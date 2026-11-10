import { createHash } from "node:crypto";
import { FederationError } from "@kuintessence/shared/federation";
import {
  CaseProposalSchema,
  CaseReceiptQuerySchema,
  CaseReceiptSchema,
  caseMembers,
  caseOperationFunction,
  caseVerificationKeys,
  type FabricCaseTrust,
  FabricCaseTrustSchema,
  verifyCaseArbitrationDecision,
  verifyCasePublication,
  verifyCaseRevocation,
} from "@kuintessence/shared/federation/case-ledger";
import { parseFederationPublicKey } from "@kuintessence/shared/federation/signatures";
import type { ChaincodeInterface, ChaincodeStub } from "fabric-shim";
import shim from "fabric-shim";
import { z } from "zod";

const ConfigKey = "kq.case.trust.v1";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const fail = (code: ConstructorParameters<typeof FederationError>[0]): never => {
  throw new FederationError(code);
};
type Stub = Pick<
  ChaincodeStub,
  | "getFunctionAndParameters"
  | "getState"
  | "putState"
  | "setStateValidationParameter"
  | "createCompositeKey"
  | "getPrivateData"
  | "getPrivateDataHash"
  | "putPrivateData"
  | "getTransient"
  | "getDateTimestamp"
>;
interface Identity {
  getMSPID(): string;
  getAttributeValue(name: string): string | null;
}

/** A separate chaincode namespace and three-party PDC; never reads the original AB ledger. */
export class CaseLedger {
  readonly trust: FabricCaseTrust;
  private readonly config: Buffer;
  constructor(trust: FabricCaseTrust) {
    this.trust = FabricCaseTrustSchema.parse(trust);
    this.config = encode(this.trust);
  }
  private organization(identity: Identity, role: "case" | "trust-admin") {
    const org = this.trust.organizations.find(
      (value) =>
        value.mspId === identity.getMSPID() &&
        value.siteId === identity.getAttributeValue("kq.federation.site"),
    );
    if (!org || identity.getAttributeValue("kq.federation.role") !== role)
      return fail("UNTRUSTED_IDENTITY");
    return org;
  }
  private key(stub: Stub, site: string, key: string) {
    return stub.createCompositeKey("revoked", [site, key]);
  }
  private endorsement(msps: string[]) {
    const policy = new shim.KeyEndorsementPolicy();
    policy.addOrgs("PEER", ...msps);
    return policy.getPolicy();
  }
  async initialize(stub: Stub, identity: Identity) {
    this.organization(identity, "trust-admin");
    const call = stub.getFunctionAndParameters();
    if (call.fcn !== "Init" || call.params.length || stub.getTransient().size)
      return fail("INVALID_MESSAGE");
    if ((await stub.getState(ConfigKey)).length) return fail("OPERATION_CONFLICT");
    for (const org of this.trust.organizations)
      for (const key of org.keys) {
        await parseFederationPublicKey(key.publicKeyPem);
        const id = this.key(stub, org.siteId, key.keyId);
        await stub.putState(id, Buffer.from("active"));
        await stub.setStateValidationParameter(id, this.endorsement([org.mspId]));
      }
    await stub.putState(ConfigKey, this.config);
    await stub.setStateValidationParameter(
      ConfigKey,
      this.endorsement(this.trust.organizations.map((org) => org.mspId)),
    );
    return encode({ digest: `sha256:${createHash("sha256").update(this.config).digest("hex")}` });
  }
  private async value(stub: Stub, collection: string, key: string) {
    const hash = await stub.getPrivateDataHash(collection, key),
      value = await stub.getPrivateData(collection, key);
    if (
      (hash.length && !createHash("sha256").update(value).digest().equals(Buffer.from(hash))) ||
      (!hash.length && value.length)
    )
      return fail("DATA_WAITING");
    return value;
  }
  async invoke(stub: Stub, identity: Identity): Promise<Buffer> {
    if (!Buffer.from(await stub.getState(ConfigKey)).equals(this.config))
      return fail("POLICY_DENIED");
    const { fcn, params } = stub.getFunctionAndParameters();
    if (fcn === "RevokeKey") {
      const org = this.organization(identity, "trust-admin");
      const [site, id] = z
        .tuple([z.uuid(), z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)])
        .parse(params);
      if (
        stub.getTransient().size ||
        org.siteId !== site ||
        !org.keys.some((key) => key.keyId === id)
      )
        return fail("POLICY_DENIED");
      await stub.putState(this.key(stub, site, id), Buffer.from("revoked"));
      return encode({ revoked: true });
    }
    const org = this.organization(identity, "case");
    if (fcn === "GetCaseReceipt") {
      const [domainId, recordType, recordId] = z
        .tuple([z.uuid(), CaseReceiptQuerySchema.shape.recordType, z.uuid()])
        .parse(params);
      const domain = this.trust.domains.find((value) => value.domainId === domainId);
      if (!domain || !caseMembers(domain).includes(org.siteId)) return fail("POLICY_DENIED");
      if (stub.getTransient().size) return fail("INVALID_MESSAGE");
      const bytes = await this.value(
        stub,
        domain.collection,
        stub.createCompositeKey(recordType, [domainId, recordId]),
      );
      if (!bytes.length) return encode({ receipt: null });
      const stored = z
        .object({ receipt: CaseReceiptSchema })
        .parse(JSON.parse(Buffer.from(bytes).toString()));
      if (stored.receipt.recordId !== recordId) return fail("OPERATION_CONFLICT");
      return encode(stored);
    }
    if (!Object.values(caseOperationFunction).some((operation) => operation === fcn))
      return fail("INVALID_MESSAGE");
    const [domainId, recordId] = z.tuple([z.uuid(), z.uuid()]).parse(params);
    const domain = this.trust.domains.find((value) => value.domainId === domainId);
    if (!domain || !caseMembers(domain).includes(org.siteId)) return fail("POLICY_DENIED");
    const transient = stub.getTransient(),
      bytes = transient.get("case");
    if (transient.size !== 1 || !bytes || bytes.length > 1_048_576) return fail("INVALID_MESSAGE");
    const input = CaseProposalSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (
      input.domainId !== domainId ||
      input.recordId !== recordId ||
      caseOperationFunction[input.operation] !== fcn
    )
      return fail("POLICY_DENIED");
    const keys = await caseVerificationKeys(
      this.trust,
      input,
      async (site, key) =>
        Buffer.from(await stub.getState(this.key(stub, site, key))).toString() !== "active",
    );
    const now = stub.getDateTimestamp();
    if (input.operation === "record-arbitration-decision") {
      if (org.siteId !== domain.recipientSiteId) return fail("POLICY_DENIED");
      const signed = await verifyCaseArbitrationDecision(input.envelope, domain, keys, now);
      if (signed.digest !== input.digest || signed.payload.decisionId !== recordId)
        return fail("OPERATION_CONFLICT");
      const recordKey = stub.createCompositeKey("case-arbitration-decision", [domainId, recordId]);
      const caseKey = stub.createCompositeKey("case-decision", [
        domainId,
        signed.payload.binding.caseId,
      ]);
      const prior = await this.value(stub, domain.collection, recordKey);
      const existing = await this.value(stub, domain.collection, caseKey);
      const receipt = { recordId, digest: signed.digest };
      if (existing.length && !Buffer.from(existing).equals(encode(receipt)))
        return fail("OPERATION_CONFLICT");
      if (prior.length) {
        const stored = z
          .object({ receipt: CaseReceiptSchema })
          .parse(JSON.parse(Buffer.from(prior).toString()));
        if (stored.receipt.recordId !== recordId || stored.receipt.digest !== signed.digest)
          return fail("OPERATION_CONFLICT");
      }
      // Even replay writes private keys, retaining native A/B/R endorsement.
      await stub.putPrivateData(domain.collection, caseKey, encode(receipt));
      await stub.putPrivateData(
        domain.collection,
        recordKey,
        prior.length ? prior : encode({ receipt, input }),
      );
      return encode(receipt);
    }
    const signed =
      input.operation === "record-case-evidence"
        ? await verifyCasePublication(input.envelope, domain, keys, now)
        : await verifyCaseRevocation(input.envelope, domain, keys, now);
    const publicationId = signed.payload.publicationId;
    if (
      signed.digest !== input.digest ||
      (signed.payload.kind === "case-evidence-publication"
        ? publicationId
        : signed.payload.revocationId) !== recordId
    )
      return fail("OPERATION_CONFLICT");
    const publicationKey = stub.createCompositeKey("case-evidence", [domainId, publicationId]);
    const revokedKey = stub.createCompositeKey("case-withdrawn", [domainId, publicationId]);
    const revoked = await this.value(stub, domain.collection, revokedKey);
    const prior = await this.value(stub, domain.collection, publicationKey);
    if (input.operation === "record-case-evidence" && revoked.length) return fail("POLICY_DENIED");
    if (signed.payload.kind === "case-publication-revocation") {
      if (prior.length) {
        const stored = z
          .object({ receipt: CaseReceiptSchema })
          .parse(JSON.parse(Buffer.from(prior).toString()));
        if (stored.receipt.digest !== signed.payload.publicationDigest)
          return fail("OPERATION_CONFLICT");
      }
      if (revoked.length && Buffer.from(revoked).toString() !== signed.payload.publicationDigest)
        return fail("OPERATION_CONFLICT");
    }
    const recordKey =
      input.operation === "record-case-evidence"
        ? publicationKey
        : stub.createCompositeKey("case-revocation", [domainId, recordId]);
    const priorRecord =
      input.operation === "record-case-evidence"
        ? prior
        : await this.value(stub, domain.collection, recordKey);
    const receipt = { recordId, digest: signed.digest };
    if (priorRecord.length) {
      const stored = z
        .object({ receipt: CaseReceiptSchema })
        .parse(JSON.parse(Buffer.from(priorRecord).toString()));
      if (stored.receipt.recordId !== recordId || stored.receipt.digest !== signed.digest)
        return fail("OPERATION_CONFLICT");
    }
    if (signed.payload.kind === "case-publication-revocation")
      await stub.putPrivateData(
        domain.collection,
        revokedKey,
        Buffer.from(signed.payload.publicationDigest),
      );
    // Replays retain original bytes but still require the collection's native endorsement policy.
    await stub.putPrivateData(
      domain.collection,
      recordKey,
      priorRecord.length ? priorRecord : encode({ receipt, input }),
    );
    return encode(receipt);
  }
}

export class CaseChaincode implements ChaincodeInterface {
  private readonly ledger: CaseLedger;
  constructor(trust: FabricCaseTrust) {
    this.ledger = new CaseLedger(trust);
  }
  async Init(stub: ChaincodeStub) {
    return this.respond(() => this.ledger.initialize(stub, new shim.ClientIdentity(stub)));
  }
  async Invoke(stub: ChaincodeStub) {
    return this.respond(() => this.ledger.invoke(stub, new shim.ClientIdentity(stub)));
  }
  private async respond(call: () => Promise<Buffer>) {
    try {
      return shim.success(await call());
    } catch (error) {
      return shim.error(error instanceof FederationError ? error.code : "INVALID_MESSAGE");
    }
  }
}

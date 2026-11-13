import { createHash } from "node:crypto";
import { FederationError } from "@kuintessence/shared/federation";
import {
  FabricAnchorReceiptSchema,
  type FabricEvidenceTrust,
  FabricEvidenceTrustSchema,
  FederationEvidenceBatchSchema,
  FederationEvidenceEnvelopeSchema,
} from "@kuintessence/shared/federation/ledger";
import {
  federationMessageKeyId,
  parseFederationPublicKey,
  verifyFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import type { ChaincodeInterface, ChaincodeStub } from "fabric-shim";
import shim from "fabric-shim";
import { z } from "zod";

const ConfigKey = "kq.evidence.trust.v1";
const StoredAnchor = z.strictObject({
  receipt: FabricAnchorReceiptSchema,
  envelope: FederationEvidenceEnvelopeSchema,
});
const Args = z.tuple([z.uuid(), z.uuid()]);
const RevocationArgs = z.tuple([z.uuid(), z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)]);
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
export interface EvidenceIdentity {
  getMSPID(): string;
  getAttributeValue(name: string): string | null;
}

/** This class also permits deterministic ledger tests without emulating the Fabric wire protocol. */
export class EvidenceLedger {
  readonly trust: FabricEvidenceTrust;
  readonly configBytes: Buffer;

  constructor(trust: FabricEvidenceTrust) {
    this.trust = FabricEvidenceTrustSchema.parse(trust);
    this.configBytes = encode(this.trust);
  }

  private organization(identity: EvidenceIdentity, role: "attestor" | "trust-admin") {
    const org = this.trust.organizations.find(
      (o) =>
        o.mspId === identity.getMSPID() &&
        o.siteId === identity.getAttributeValue("kq.federation.site"),
    );
    if (!org || identity.getAttributeValue("kq.federation.role") !== role)
      return fail("UNTRUSTED_IDENTITY");
    return org;
  }

  private endorsement(msps: string[]) {
    const policy = new shim.KeyEndorsementPolicy();
    policy.addOrgs("PEER", ...msps);
    return policy.getPolicy();
  }

  private revocationKey(stub: Stub, siteId: string, keyId: string) {
    return stub.createCompositeKey("revoked", [siteId, keyId]);
  }

  private async privateValue(stub: Stub, collection: string, key: string) {
    const hash = await stub.getPrivateDataHash(collection, key);
    const value = await stub.getPrivateData(collection, key);
    if (
      (hash.length && !createHash("sha256").update(value).digest().equals(Buffer.from(hash))) ||
      (!hash.length && value.length)
    )
      return fail("DATA_WAITING");
    return value;
  }

  async initialize(stub: Stub, identity: EvidenceIdentity): Promise<Buffer> {
    this.organization(identity, "trust-admin");
    const args = stub.getFunctionAndParameters();
    if (args.fcn !== "Init" || args.params.length || stub.getTransient().size)
      return fail("INVALID_MESSAGE");
    if ((await stub.getState(ConfigKey)).length) return fail("OPERATION_CONFLICT");
    for (const org of this.trust.organizations)
      for (const key of org.keys) {
        await parseFederationPublicKey(key.publicKeyPem);
        const stateKey = this.revocationKey(stub, org.siteId, key.keyId);
        await stub.putState(stateKey, Buffer.from("active"));
        await stub.setStateValidationParameter(stateKey, this.endorsement([org.mspId]));
      }
    await stub.putState(ConfigKey, this.configBytes);
    await stub.setStateValidationParameter(
      ConfigKey,
      this.endorsement(this.trust.organizations.map((o) => o.mspId)),
    );
    return encode({
      digest: `sha256:${createHash("sha256").update(this.configBytes).digest("hex")}`,
    });
  }

  async invoke(stub: Stub, identity: EvidenceIdentity): Promise<Buffer> {
    const storedConfig = await stub.getState(ConfigKey);
    if (!Buffer.from(storedConfig).equals(this.configBytes)) return fail("POLICY_DENIED");
    const { fcn, params } = stub.getFunctionAndParameters();
    if (fcn === "RevokeKey") {
      const org = this.organization(identity, "trust-admin");
      const [siteId, keyId] = RevocationArgs.parse(params);
      if (
        stub.getTransient().size ||
        siteId !== org.siteId ||
        !org.keys.some((k) => k.keyId === keyId)
      )
        return fail("POLICY_DENIED");
      const key = this.revocationKey(stub, siteId, keyId);
      if (!(await stub.getState(key)).length) return fail("UNTRUSTED_IDENTITY");
      await stub.putState(key, Buffer.from("revoked"));
      return encode({ revoked: true });
    }
    if (fcn !== "AnchorBatch" && fcn !== "GetAnchor") return fail("INVALID_MESSAGE");
    const org = this.organization(identity, "attestor");
    const [domainId, batchId] = Args.parse(params);
    const domain = this.trust.domains.find((d) => d.domainId === domainId);
    if (!domain?.siteIds.includes(org.siteId)) return fail("POLICY_DENIED");
    const anchorKey = stub.createCompositeKey("anchor", [domainId, batchId]);
    const priorBytes = await this.privateValue(stub, domain.collection, anchorKey);
    const prior = priorBytes.length
      ? StoredAnchor.parse(JSON.parse(Buffer.from(priorBytes).toString()))
      : undefined;
    if (fcn === "GetAnchor") {
      if (stub.getTransient().size) return fail("INVALID_MESSAGE");
      if (!prior) return fail("ASSET_UNAVAILABLE");
      return encode(prior.receipt);
    }
    const transient = stub.getTransient();
    const bytes = transient.get("evidence");
    if (!bytes || transient.size !== 1 || bytes.length > 1_048_576) return fail("INVALID_MESSAGE");
    const envelope = FederationEvidenceEnvelopeSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    const now = stub.getDateTimestamp();
    const issuer = await this.verify(stub, org.siteId, envelope.issuerJws, now);
    const batch = issuer.payload;
    if (
      batch.issuerSiteId !== org.siteId ||
      batch.domainId !== domainId ||
      batch.batchId !== batchId ||
      !domain.siteIds.includes(batch.counterpartySiteId) ||
      Date.parse(batch.createdAt) > now.getTime() + 60_000
    )
      return fail("POLICY_DENIED");
    if (batch.confirmation === "bilateral") {
      if (!envelope.counterpartyJws) return fail("UNTRUSTED_IDENTITY");
      const other = await this.verify(
        stub,
        batch.counterpartySiteId,
        envelope.counterpartyJws,
        now,
      );
      if (other.digest !== issuer.digest) return fail("OPERATION_CONFLICT");
    } else if (envelope.counterpartyJws) return fail("INVALID_MESSAGE");

    const receipt = { batchId, digest: issuer.digest };
    if (prior) {
      if (prior.receipt.batchId !== batchId || prior.receipt.digest !== issuer.digest)
        return fail("OPERATION_CONFLICT");
      // Keep replay under the collection's two-party write policy, including a new tx after INVALID.
      await stub.putPrivateData(domain.collection, anchorKey, priorBytes);
      return encode(receipt);
    }
    const cursorKey = stub.createCompositeKey("cursor", [org.siteId]);
    const cursorBytes = await this.privateValue(stub, domain.collection, cursorKey);
    const cursor = cursorBytes.length
      ? BigInt(
          z
            .object({ sequence: z.string().regex(/^[1-9][0-9]{0,19}$/) })
            .parse(JSON.parse(Buffer.from(cursorBytes).toString())).sequence,
        )
      : 0n;
    const first = batch.records[0];
    const last = batch.records.at(-1);
    if (!first || !last || BigInt(first.sequence) !== cursor + 1n)
      return fail("OPERATION_CONFLICT");
    // Reads participate in MVCC: concurrent batches and key revocations cannot silently overwrite.
    for (const record of batch.records) {
      const recordKey = stub.createCompositeKey("record", [org.siteId, record.evidenceId]);
      if ((await this.privateValue(stub, domain.collection, recordKey)).length)
        return fail("OPERATION_CONFLICT");
      await stub.putPrivateData(domain.collection, recordKey, Buffer.from(batchId));
    }
    await stub.putPrivateData(domain.collection, anchorKey, encode({ receipt, envelope }));
    await stub.putPrivateData(
      domain.collection,
      cursorKey,
      encode({ sequence: last.sequence, salt: batch.salt }),
    );
    // Only PDC writes: the collection AND(parties) policy overrides the chaincode ALL policy.
    return encode(receipt);
  }

  private async verify(stub: Stub, siteId: string, jws: string, now: Date) {
    const keyId = federationMessageKeyId(jws);
    const key = this.trust.organizations
      .find((o) => o.siteId === siteId)
      ?.keys.find((k) => k.keyId === keyId);
    if (!key) return fail("UNTRUSTED_IDENTITY");
    const state = await stub.getState(this.revocationKey(stub, siteId, keyId));
    if (Buffer.from(state).toString() !== "active") return fail("UNTRUSTED_IDENTITY");
    return verifyFederationMessage(
      FederationEvidenceBatchSchema,
      jws,
      {
        siteId,
        keyId,
        publicKey: await parseFederationPublicKey(key.publicKeyPem),
        validFrom: new Date(key.validFrom),
        validUntil: new Date(key.validUntil),
        revoked: false,
        allowedKinds: ["evidence-batch"],
      },
      now,
    );
  }
}

export class EvidenceChaincode implements ChaincodeInterface {
  private readonly ledger: EvidenceLedger;

  constructor(trust: FabricEvidenceTrust) {
    this.ledger = new EvidenceLedger(trust);
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
      // Fabric persists proposal responses. Never expose raw validation/crypto/private-data errors.
      return shim.error(error instanceof FederationError ? error.code : "INVALID_MESSAGE");
    }
  }
}

import { createHash } from "node:crypto";
import { FederationError } from "@kuintessence/shared/federation";
import {
  CommercialAgreementEnvelopeSchema,
  CommercialAgreementSchema,
  CommercialReceiptSchema,
  CommercialUsageEnvelopeSchema,
  CommercialUsageSchema,
  type FabricCommercialTrust,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  federationMessageKeyId,
  parseFederationPublicKey,
  verifyFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import type { ChaincodeInterface, ChaincodeStub } from "fabric-shim";
import shim from "fabric-shim";
import { z } from "zod";

const ConfigKey = "kq.commercial.trust.v1";
const Args = z.tuple([z.uuid(), z.uuid()]);
const StoredAgreement = z.strictObject({
  receipt: CommercialReceiptSchema,
  envelope: CommercialAgreementEnvelopeSchema,
  terms: CommercialAgreementSchema,
});
const StoredUsage = z.strictObject({
  receipt: CommercialReceiptSchema,
  envelope: CommercialUsageEnvelopeSchema,
  report: CommercialUsageSchema,
});
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

export class CommercialLedger {
  readonly trust: FabricCommercialTrust;
  private readonly configBytes: Buffer;
  constructor(input: FabricCommercialTrust) {
    this.trust = FabricCommercialTrustSchema.parse(input);
    this.configBytes = encode(this.trust);
  }
  private organization(identity: Identity, role: "commercial" | "trust-admin") {
    const org = this.trust.organizations.find(
      (org) =>
        org.mspId === identity.getMSPID() &&
        org.siteId === identity.getAttributeValue("kq.federation.site"),
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
  private keyState(stub: Stub, siteId: string, keyId: string) {
    return stub.createCompositeKey("revoked", [siteId, keyId]);
  }
  private async privateValue(stub: Stub, collection: string, key: string) {
    const hash = await stub.getPrivateDataHash(collection, key);
    const bytes = await stub.getPrivateData(collection, key);
    if (
      (hash.length && !createHash("sha256").update(bytes).digest().equals(Buffer.from(hash))) ||
      (!hash.length && bytes.length)
    )
      return fail("DATA_WAITING");
    return bytes;
  }
  private async verify<T extends { kind: string }>(
    stub: Stub,
    schema: z.ZodType<T>,
    jws: string,
    siteId: string,
    now: Date,
  ) {
    const keyId = federationMessageKeyId(jws);
    const key = this.trust.organizations
      .find((org) => org.siteId === siteId)
      ?.keys.find((key) => key.keyId === keyId);
    const purpose = this.trust.keyPurposes.find(
      (item) => item.siteId === siteId && item.keyId === keyId,
    );
    if (
      !key ||
      !purpose ||
      Buffer.from(await stub.getState(this.keyState(stub, siteId, keyId))).toString() !== "active"
    )
      return fail("UNTRUSTED_IDENTITY");
    return verifyFederationMessage(
      schema,
      jws,
      {
        siteId,
        keyId,
        publicKey: await parseFederationPublicKey(key.publicKeyPem),
        validFrom: new Date(key.validFrom),
        validUntil: new Date(key.validUntil),
        revoked: false,
        allowedKinds: purpose.kinds,
      },
      now,
    );
  }
  private input<T>(stub: Stub, schema: z.ZodType<T>): T {
    const transient = stub.getTransient();
    const bytes = transient.get("commercial");
    if (transient.size !== 1 || !bytes || bytes.length > 1048576) return fail("INVALID_MESSAGE");
    return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  }
  async initialize(stub: Stub, identity: Identity): Promise<Buffer> {
    this.organization(identity, "trust-admin");
    const { fcn, params } = stub.getFunctionAndParameters();
    if (fcn !== "Init" || params.length || stub.getTransient().size) return fail("INVALID_MESSAGE");
    if ((await stub.getState(ConfigKey)).length) return fail("OPERATION_CONFLICT");
    for (const org of this.trust.organizations)
      for (const key of org.keys) {
        await parseFederationPublicKey(key.publicKeyPem);
        const stateKey = this.keyState(stub, org.siteId, key.keyId);
        await stub.putState(stateKey, Buffer.from("active"));
        await stub.setStateValidationParameter(stateKey, this.endorsement([org.mspId]));
      }
    await stub.putState(ConfigKey, this.configBytes);
    await stub.setStateValidationParameter(
      ConfigKey,
      this.endorsement(this.trust.organizations.map((org) => org.mspId)),
    );
    return encode({
      digest: `sha256:${createHash("sha256").update(this.configBytes).digest("hex")}`,
    });
  }
  async invoke(stub: Stub, identity: Identity): Promise<Buffer> {
    if (!Buffer.from(await stub.getState(ConfigKey)).equals(this.configBytes))
      return fail("POLICY_DENIED");
    const { fcn, params } = stub.getFunctionAndParameters();
    if (fcn === "RevokeKey") {
      const org = this.organization(identity, "trust-admin");
      const [siteId, keyId] = z
        .tuple([z.uuid(), z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)])
        .parse(params);
      if (
        stub.getTransient().size ||
        siteId !== org.siteId ||
        !org.keys.some((key) => key.keyId === keyId)
      )
        return fail("POLICY_DENIED");
      await stub.putState(this.keyState(stub, siteId, keyId), Buffer.from("revoked"));
      return encode({ revoked: true });
    }
    if (
      !["RegisterAgreement", "RecordUsage", "GetAgreementReceipt", "GetUsageReceipt"].includes(fcn)
    )
      return fail("INVALID_MESSAGE");
    const org = this.organization(identity, "commercial");
    const [domainId, recordId] = Args.parse(params);
    const domain = this.trust.domains.find((domain) => domain.domainId === domainId);
    if (!domain?.siteIds.includes(org.siteId)) return fail("POLICY_DENIED");
    const agreementOperation = fcn === "RegisterAgreement" || fcn === "GetAgreementReceipt";
    const key = stub.createCompositeKey(agreementOperation ? "agreement" : "usage", [
      domainId,
      recordId,
    ]);
    const priorBytes = await this.privateValue(stub, domain.collection, key);
    const prior = priorBytes.length
      ? (agreementOperation ? StoredAgreement : StoredUsage).parse(
          JSON.parse(Buffer.from(priorBytes).toString()),
        )
      : undefined;
    if (fcn.startsWith("Get")) {
      if (stub.getTransient().size) return fail("INVALID_MESSAGE");
      if (!prior) return fail("ASSET_UNAVAILABLE");
      // Never return plaintext contracts or reports: even a read function may be submitted as a transaction.
      return encode(prior.receipt);
    }
    const now = stub.getDateTimestamp();
    if (fcn === "RegisterAgreement") {
      const envelope = this.input(stub, CommercialAgreementEnvelopeSchema);
      if (
        envelope.sourceSiteId === envelope.targetSiteId ||
        !domain.siteIds.includes(envelope.sourceSiteId) ||
        !domain.siteIds.includes(envelope.targetSiteId)
      )
        return fail("POLICY_DENIED");
      const source = await this.verify(
        stub,
        CommercialAgreementSchema,
        envelope.sourceJws,
        envelope.sourceSiteId,
        now,
      );
      const terms = source.payload;
      if (
        terms.domainId !== domainId ||
        terms.agreement.agreementRevisionId !== recordId ||
        !domain.siteIds.includes(terms.agreement.sourceSiteId) ||
        !domain.siteIds.includes(terms.agreement.targetSiteId)
      )
        return fail("POLICY_DENIED");
      if (
        terms.agreement.sourceSiteId !== envelope.sourceSiteId ||
        terms.agreement.targetSiteId !== envelope.targetSiteId
      )
        return fail("POLICY_DENIED");
      const target = await this.verify(
        stub,
        CommercialAgreementSchema,
        envelope.targetJws,
        terms.agreement.targetSiteId,
        now,
      );
      if (source.digest !== target.digest) return fail("OPERATION_CONFLICT");
      if (Date.parse(terms.createdAt) > now.getTime() + 60000) return fail("INVALID_MESSAGE");
      if (!prior && Date.parse(terms.agreement.validUntil) <= now.getTime())
        return fail("AUTHORIZATION_EXPIRED");
      const receipt = { recordId, digest: source.digest };
      if (prior && prior.receipt.digest !== receipt.digest) return fail("OPERATION_CONFLICT");
      await stub.putPrivateData(
        domain.collection,
        key,
        prior ? priorBytes : encode({ receipt, envelope, terms }),
      );
      return encode(receipt);
    }
    const envelope = this.input(stub, CommercialUsageEnvelopeSchema);
    const report = await this.verify(
      stub,
      CommercialUsageSchema,
      envelope.providerJws,
      org.siteId,
      now,
    );
    const usage = report.payload;
    if (
      usage.domainId !== domainId ||
      usage.reportId !== recordId ||
      usage.targetSiteId !== org.siteId ||
      !domain.siteIds.includes(usage.sourceSiteId) ||
      Date.parse(usage.reportedAt) > now.getTime() + 60000
    )
      return fail("POLICY_DENIED");
    const agreementKey = stub.createCompositeKey("agreement", [
      domainId,
      usage.agreementRevisionId,
    ]);
    const agreementBytes = await this.privateValue(stub, domain.collection, agreementKey);
    if (!agreementBytes.length) return fail("ASSET_UNAVAILABLE");
    const stored = StoredAgreement.parse(JSON.parse(Buffer.from(agreementBytes).toString()));
    // Previously committed approvals remain historical facts when their signing keys later expire.
    const terms = stored.terms;
    if (
      usage.agreementDigest !== stored.receipt.digest ||
      terms.agreement.sourceSiteId !== usage.sourceSiteId ||
      terms.agreement.targetSiteId !== usage.targetSiteId ||
      Date.parse(usage.periodStart) < Date.parse(terms.agreement.validFrom) ||
      Date.parse(usage.periodEnd) > Date.parse(terms.agreement.validUntil) ||
      usage.measurements.some(
        (item) =>
          !terms.prices.some(
            (price) => price.metric === item.metric && price.quantityUnit === item.quantityUnit,
          ),
      )
    )
      return fail("POLICY_DENIED");
    const receipt = { recordId, digest: report.digest };
    if (prior) {
      if (prior.receipt.digest !== receipt.digest) return fail("OPERATION_CONFLICT");
      await stub.putPrivateData(domain.collection, key, priorBytes);
      return encode(receipt);
    }
    const headKey = stub.createCompositeKey("usage-head", [
      domainId,
      usage.agreementRevisionId,
      usage.taskId,
      String(usage.attempt),
    ]);
    const headBytes = await this.privateValue(stub, domain.collection, headKey);
    const head = headBytes.length
      ? z
          .strictObject({ reportId: z.uuid(), salt: z.string().regex(/^[a-f0-9]{64}$/) })
          .parse(JSON.parse(Buffer.from(headBytes).toString()))
      : null;
    if (
      (usage.correctionOf && head?.reportId !== usage.correctionOf) ||
      (!usage.correctionOf && head)
    )
      return fail("OPERATION_CONFLICT");
    if (usage.correctionOf) {
      const originalBytes = await this.privateValue(
        stub,
        domain.collection,
        stub.createCompositeKey("usage", [domainId, usage.correctionOf]),
      );
      if (!originalBytes.length) return fail("ASSET_UNAVAILABLE");
      const original = StoredUsage.parse(JSON.parse(Buffer.from(originalBytes).toString()));
      if (
        original.report.agreementRevisionId !== usage.agreementRevisionId ||
        original.report.taskId !== usage.taskId ||
        original.report.attempt !== usage.attempt ||
        Date.parse(original.report.reportedAt) > Date.parse(usage.reportedAt)
      )
        return fail("POLICY_DENIED");
    }
    await stub.putPrivateData(domain.collection, key, encode({ receipt, envelope, report: usage }));
    await stub.putPrivateData(
      domain.collection,
      headKey,
      encode({ reportId: usage.reportId, salt: usage.salt }),
    );
    return encode(receipt);
  }
}

export class CommercialChaincode implements ChaincodeInterface {
  private readonly ledger: CommercialLedger;
  constructor(trust: FabricCommercialTrust) {
    this.ledger = new CommercialLedger(trust);
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

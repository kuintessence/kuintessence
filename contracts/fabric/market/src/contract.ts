import { createHash } from "node:crypto";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  type FabricMarketTrust,
  FabricMarketTrustSchema,
  MarketCancelOpenSchema,
  MarketClaimSchema,
  MarketDemandSchema,
  MarketDemandStateSchema,
} from "@kuintessence/shared/federation/market";
import type { ChaincodeInterface, ChaincodeStub } from "fabric-shim";
import shim from "fabric-shim";
import { z } from "zod";

const ConfigKey = "kq.market.trust.v1";
const encode = (value: unknown) => Buffer.from(federationCanonicalJson(value));
const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(encode(value)).digest("hex")}`;
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
  | "getTransient"
  | "getDateTimestamp"
>;
interface Identity {
  getMSPID(): string;
  getAttributeValue(name: string): string | null;
}

export class MarketLedger {
  readonly trust: FabricMarketTrust;
  constructor(input: FabricMarketTrust) {
    this.trust = FabricMarketTrustSchema.parse(input);
  }
  private organization(identity: Identity, roles: string[]) {
    const org = this.trust.organizations.find(
      (org) =>
        org.mspId === identity.getMSPID() &&
        org.siteId === identity.getAttributeValue("kq.federation.site"),
    );
    if (!org || !roles.includes(identity.getAttributeValue("kq.federation.role") ?? ""))
      return fail("UNTRUSTED_IDENTITY");
    return org;
  }
  private input<T>(stub: Stub, schema: z.ZodType<T>) {
    const data = stub.getTransient();
    const bytes = data.get("market");
    if (data.size !== 1 || !bytes || bytes.length > 32768) return fail("INVALID_MESSAGE");
    return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  }
  async initialize(stub: Stub, identity: Identity): Promise<Buffer> {
    this.organization(identity, ["trust-admin"]);
    const { fcn, params } = stub.getFunctionAndParameters();
    if (fcn !== "Init" || params.length || stub.getTransient().size) return fail("INVALID_MESSAGE");
    if ((await stub.getState(ConfigKey)).length) return fail("OPERATION_CONFLICT");
    await stub.putState(ConfigKey, encode(this.trust));
    const policy = new shim.KeyEndorsementPolicy();
    policy.addOrgs("PEER", ...this.trust.organizations.map((org) => org.mspId));
    await stub.setStateValidationParameter(ConfigKey, policy.getPolicy());
    return encode({ digest: digest(this.trust) });
  }
  async invoke(stub: Stub, identity: Identity): Promise<Buffer> {
    if (!Buffer.from(await stub.getState(ConfigKey)).equals(encode(this.trust)))
      return fail("POLICY_DENIED");
    const { fcn, params } = stub.getFunctionAndParameters();
    if (!["PublishDemand", "ClaimDemand", "CancelOpenDemand", "GetDemand"].includes(fcn))
      return fail("INVALID_MESSAGE");
    const org = this.organization(
      identity,
      fcn === "GetDemand" ? ["market", "commercial"] : ["market"],
    );
    const [id] = z.tuple([z.uuid()]).parse(params);
    const key = stub.createCompositeKey("demand", [id]);
    const bytes = await stub.getState(key);
    const prior = bytes.length
      ? MarketDemandStateSchema.parse(JSON.parse(Buffer.from(bytes).toString()))
      : null;
    if (fcn === "GetDemand") {
      if (stub.getTransient().size) return fail("INVALID_MESSAGE");
      if (!prior) return fail("ASSET_UNAVAILABLE");
      return encode(prior);
    }
    const now = stub.getDateTimestamp().getTime();
    if (fcn === "PublishDemand") {
      const demand = this.input(stub, MarketDemandSchema);
      if (demand.demandId !== id || demand.sourceSiteId !== org.siteId)
        return fail("POLICY_DENIED");
      const hash = digest(demand);
      if (prior) {
        if (prior.digest !== hash) return fail("OPERATION_CONFLICT");
      } else {
        if (Date.parse(demand.createdAt) > now + 60000 || Date.parse(demand.expiresAt) <= now)
          return fail("AUTHORIZATION_EXPIRED");
        await stub.putState(
          key,
          encode({
            demand,
            digest: hash,
            version: 1,
            status: "OPEN",
            claim: null,
            cancellation: null,
          }),
        );
      }
      return encode({ recordId: id, digest: hash });
    }
    if (!prior) return fail("ASSET_UNAVAILABLE");
    if (fcn === "CancelOpenDemand") {
      const cancellation = this.input(stub, MarketCancelOpenSchema);
      if (cancellation.demandId !== id || prior.demand.sourceSiteId !== org.siteId)
        return fail("POLICY_DENIED");
      if (prior.cancellation) {
        if (digest(prior.cancellation) !== digest(cancellation)) return fail("OPERATION_CONFLICT");
      } else {
        if (prior.status !== "OPEN" || prior.version !== cancellation.expectedVersion)
          return fail("OPERATION_CONFLICT");
        await stub.putState(
          key,
          encode({ ...prior, version: prior.version + 1, status: "CANCELLED", cancellation }),
        );
      }
      return encode({ recordId: cancellation.cancellationId, digest: digest(cancellation) });
    }
    const claim = this.input(stub, MarketClaimSchema);
    if (
      claim.demandId !== id ||
      claim.providerSiteId !== org.siteId ||
      org.siteId === prior.demand.sourceSiteId
    )
      return fail("POLICY_DENIED");
    if (prior.claim) {
      if (digest(prior.claim) !== digest(claim)) return fail("OPERATION_CONFLICT");
      return encode({ recordId: claim.claimId, digest: digest(claim) });
    }
    if (prior.status !== "OPEN" || prior.version !== claim.expectedVersion)
      return fail("OPERATION_CONFLICT");
    if (
      Date.parse(claim.expiresAt) <= now ||
      Date.parse(claim.expiresAt) > Date.parse(prior.demand.expiresAt)
    )
      return fail("AUTHORIZATION_EXPIRED");
    // This read + write is validated by Fabric MVCC. Expiry alone never reopens a possibly funded claim.
    await stub.putState(
      key,
      encode({ ...prior, version: prior.version + 1, status: "CLAIMED", claim }),
    );
    return encode({ recordId: claim.claimId, digest: digest(claim) });
  }
}

export class MarketChaincode implements ChaincodeInterface {
  private readonly ledger: MarketLedger;
  constructor(trust: FabricMarketTrust) {
    this.ledger = new MarketLedger(trust);
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

import { createHash } from "node:crypto";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  type FabricMarketTrust,
  FabricMarketTrustSchema,
  MarketActivationSchema,
  MarketCancelOpenSchema,
  MarketClaimSchema,
  MarketClosureSchema,
  MarketDemandSchema,
  MarketDemandStateSchema,
  MarketExecutionAuthorizationSchema,
  MarketExecutionStopSchema,
  MarketPageRequestSchema,
  MarketUnreservedClosureSchema,
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
  | "getStateByPartialCompositeKeyWithPagination"
  | "invokeChaincode"
  | "getChannelID"
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
    if (
      ![
        "PublishDemand",
        "ClaimDemand",
        "CancelOpenDemand",
        "GetDemand",
        "ListDemands",
        "ActivateDemand",
        "AuthorizeExecution",
        "RequestExecutionStop",
        "CloseDemand",
        "CloseUnreservedDemand",
      ].includes(fcn)
    )
      return fail("INVALID_MESSAGE");
    const org = this.organization(
      identity,
      ["GetDemand", "ListDemands"].includes(fcn) ? ["market", "commercial"] : ["market"],
    );
    if (fcn === "ListDemands") {
      if (stub.getTransient().size) return fail("INVALID_MESSAGE");
      const [size, cursor] = z.tuple([z.string().regex(/^[1-9][0-9]?$/), z.string()]).parse(params);
      const { limit, bookmark } = MarketPageRequestSchema.parse({
        limit: Number(size),
        bookmark: cursor,
      });
      const { iterator, metadata } = await stub.getStateByPartialCompositeKeyWithPagination(
        "demand",
        [],
        limit,
        bookmark,
      );
      const demands = [];
      try {
        for (;;) {
          const item = await iterator.next();
          if (item.value?.value?.length)
            demands.push(
              MarketDemandStateSchema.parse(JSON.parse(Buffer.from(item.value.value).toString())),
            );
          if (item.done) break;
          if (demands.length > limit) return fail("INVALID_MESSAGE");
        }
      } finally {
        await iterator.close();
      }
      return encode({ demands, bookmark: metadata.bookmark });
    }
    const [id] = z.tuple([z.uuid()]).parse(params);
    const key = stub.createCompositeKey("demand", [id]);
    const bytes = await stub.getState(key);
    const prior = bytes.length
      ? MarketDemandStateSchema.parse(JSON.parse(Buffer.from(bytes).toString()))
      : null;
    if (fcn === "GetDemand") {
      // Same-channel commercial calls carry their original transient map; this read never decodes it.
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
    if (fcn === "CloseUnreservedDemand") {
      const closure = this.input(stub, MarketUnreservedClosureSchema);
      if (
        closure.demandId !== id ||
        closure.issuerSiteId !== org.siteId ||
        ![prior.demand.sourceSiteId, prior.claim?.providerSiteId].includes(org.siteId)
      )
        return fail("POLICY_DENIED");
      if (prior.unreservedClosure) {
        if (digest(prior.unreservedClosure) !== digest(closure)) return fail("OPERATION_CONFLICT");
        return encode({ recordId: closure.closureId, digest: digest(closure) });
      }
      if (
        prior.status !== "CLAIMED" ||
        prior.activation ||
        !prior.claim ||
        prior.version !== closure.expectedVersion ||
        prior.claim.claimId !== closure.claimId ||
        prior.claim.commercialDomainId !== closure.commercialDomainId
      )
        return fail("OPERATION_CONFLICT");
      const response = await stub.invokeChaincode(
        "kq-commercial",
        ["GetExecutionGatePresence", closure.commercialDomainId, closure.claimId],
        stub.getChannelID(),
      );
      if (response.status !== 200 || !response.payload) return fail("LEDGER_REQUIRED");
      const current = z
        .strictObject({
          hash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
        })
        .parse(JSON.parse(Buffer.from(response.payload).toString()));
      if (current.hash !== null) return fail("OPERATION_CONFLICT");
      // An absent private hash is a native MVCC read, so a concurrent reservation cannot also win.
      await stub.putState(
        key,
        encode(
          MarketDemandStateSchema.parse({
            ...prior,
            status: "CLOSED",
            version: prior.version + 1,
            unreservedClosure: closure,
          }),
        ),
      );
      return encode({ recordId: closure.closureId, digest: digest(closure) });
    }
    if (fcn === "CloseDemand") {
      const closure = this.input(stub, MarketClosureSchema);
      if (
        closure.demandId !== id ||
        ![prior.demand.sourceSiteId, prior.claim?.providerSiteId].includes(org.siteId)
      )
        return fail("POLICY_DENIED");
      if (prior.closure) {
        if (digest(prior.closure) !== digest(closure)) return fail("OPERATION_CONFLICT");
        return encode({ recordId: closure.closureId, digest: digest(closure) });
      }
      const gate = closure.gate;
      if (gate.state === "REVOKED") {
        if (org.siteId !== prior.demand.sourceSiteId) return fail("POLICY_DENIED");
        if (
          prior.status !== "CLAIMED" ||
          prior.activation ||
          !prior.claim ||
          prior.version !== closure.expectedVersion ||
          gate.claimVersion !== prior.version ||
          gate.domainId !== prior.claim.commercialDomainId ||
          gate.reservationId !== prior.claim.claimId
        )
          return fail("OPERATION_CONFLICT");
      } else {
        if (
          !["ACTIVE", "STOPPING"].includes(prior.status) ||
          !prior.activation ||
          closure.expectedVersion !== prior.activation.expectedVersion + 1 ||
          gate.terminal?.activationId !== prior.activation.activationId ||
          gate.domainId !== prior.claim?.commercialDomainId ||
          gate.reservationId !== prior.claim.claimId ||
          gate.claimVersion !== prior.activation.expectedVersion ||
          gate.version !== prior.activation.gate.version + 1 ||
          gate.reservationDigest !== prior.activation.gate.reservationDigest ||
          gate.expiresAt !== prior.activation.gate.expiresAt
        )
          return fail("OPERATION_CONFLICT");
      }
      const response = await stub.invokeChaincode(
        "kq-commercial",
        ["GetExecutionGateHash", gate.domainId, gate.reservationId],
        stub.getChannelID(),
      );
      if (response.status !== 200 || !response.payload) return fail("LEDGER_REQUIRED");
      const current = z
        .strictObject({ hash: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(JSON.parse(Buffer.from(response.payload).toString()));
      if (current.hash !== createHash("sha256").update(JSON.stringify(gate)).digest("hex"))
        return fail("OPERATION_CONFLICT");
      await stub.putState(
        key,
        encode(
          MarketDemandStateSchema.parse({
            ...prior,
            version: prior.version + 1,
            status: "CLOSED",
            closure,
          }),
        ),
      );
      return encode({ recordId: closure.closureId, digest: digest(closure) });
    }
    if (fcn === "RequestExecutionStop") {
      const stop = this.input(stub, MarketExecutionStopSchema);
      if (stop.demandId !== id || stop.issuerSiteId !== org.siteId) return fail("POLICY_DENIED");
      // One immutable request per participant/activation, including after a later task generation.
      const receiptKey = stub.createCompositeKey("execution-stop", [
        id,
        stop.activationId,
        org.siteId,
      ]);
      const saved = await stub.getState(receiptKey);
      if (saved.length) {
        const original = MarketExecutionStopSchema.parse(JSON.parse(Buffer.from(saved).toString()));
        if (digest(original) !== digest(stop)) return fail("OPERATION_CONFLICT");
        return encode({ recordId: stop.stopId, digest: digest(stop) });
      }
      if (![prior.demand.sourceSiteId, prior.claim?.providerSiteId].includes(org.siteId))
        return fail("POLICY_DENIED");
      if (
        !["ACTIVE", "STOPPING"].includes(prior.status) ||
        !prior.activation ||
        prior.activation.activationId !== stop.activationId ||
        stop.expectedVersion !== prior.activation.expectedVersion + 1 ||
        (prior.status === "ACTIVE" && prior.version !== stop.expectedVersion)
      )
        return fail("OPERATION_CONFLICT");
      if (prior.status === "ACTIVE")
        await stub.putState(
          key,
          encode(
            MarketDemandStateSchema.parse({
              ...prior,
              version: prior.version + 1,
              status: "STOPPING",
              stopRequest: stop,
            }),
          ),
        );
      await stub.putState(receiptKey, encode(stop));
      return encode({ recordId: stop.stopId, digest: digest(stop) });
    }
    if (fcn === "AuthorizeExecution") {
      const authorization = this.input(stub, MarketExecutionAuthorizationSchema);
      if (
        authorization.demandId !== id ||
        authorization.issuerSiteId !== org.siteId ||
        ![prior.demand.sourceSiteId, prior.claim?.providerSiteId].includes(org.siteId)
      )
        return fail("POLICY_DENIED");
      if (
        prior.status !== "ACTIVE" ||
        !prior.activation ||
        prior.activation.activationId !== authorization.activationId ||
        digest(prior.activation.gate) !== digest(authorization.gate)
      )
        return fail("OPERATION_CONFLICT");
      const issuedAt = Date.parse(authorization.issuedAt);
      if (issuedAt > now || now - issuedAt > 60000 || Date.parse(authorization.expiresAt) <= now)
        return fail("AUTHORIZATION_EXPIRED");
      const gate = authorization.gate;
      const response = await stub.invokeChaincode(
        "kq-commercial",
        ["GetExecutionGateHash", gate.domainId, gate.reservationId],
        stub.getChannelID(),
      );
      if (response.status !== 200 || !response.payload) return fail("LEDGER_REQUIRED");
      const current = z
        .strictObject({ hash: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(JSON.parse(Buffer.from(response.payload).toString()));
      if (current.hash !== createHash("sha256").update(JSON.stringify(gate)).digest("hex"))
        return fail("OPERATION_CONFLICT");
      // Keep one latest state per party/demand; immutable historical proofs remain in transaction blocks.
      const authorizationKey = stub.createCompositeKey("execution-authorization", [id, org.siteId]);
      const previousBytes = await stub.getState(authorizationKey);
      if (previousBytes.length) {
        const previous = MarketExecutionAuthorizationSchema.parse(
          JSON.parse(Buffer.from(previousBytes).toString()),
        );
        if (previous.authorizationId === authorization.authorizationId) {
          if (digest(previous) !== digest(authorization)) return fail("OPERATION_CONFLICT");
        } else if (Date.parse(previous.issuedAt) >= issuedAt) return fail("OPERATION_CONFLICT");
      }
      // VALID requires both the public ACTIVE read and same-channel private hash read to remain current.
      await stub.putState(authorizationKey, encode(authorization));
      return encode({ recordId: authorization.authorizationId, digest: digest(authorization) });
    }
    if (fcn === "ActivateDemand") {
      const activation = this.input(stub, MarketActivationSchema);
      if (activation.demandId !== id || org.siteId !== prior.demand.sourceSiteId)
        return fail("POLICY_DENIED");
      if (prior.activation) {
        if (digest(prior.activation) !== digest(activation)) return fail("OPERATION_CONFLICT");
        return encode({ recordId: activation.activationId, digest: digest(activation) });
      }
      const gate = activation.gate;
      if (
        prior.status !== "CLAIMED" ||
        prior.version !== activation.expectedVersion ||
        gate.demandId !== id ||
        gate.claimVersion !== prior.version ||
        gate.reservationId !== prior.claim?.claimId ||
        gate.domainId !== prior.claim.commercialDomainId ||
        gate.state !== "READY"
      )
        return fail("OPERATION_CONFLICT");
      if (Date.parse(gate.expiresAt) <= now || Date.parse(prior.claim.expiresAt) <= now)
        return fail("AUTHORIZATION_EXPIRED");
      const response = await stub.invokeChaincode(
        "kq-commercial",
        ["GetExecutionGateHash", gate.domainId, gate.reservationId],
        stub.getChannelID(),
      );
      if (response.status !== 200 || !response.payload) return fail("LEDGER_REQUIRED");
      const current = z
        .strictObject({ hash: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(JSON.parse(Buffer.from(response.payload).toString()));
      if (current.hash !== createHash("sha256").update(JSON.stringify(gate)).digest("hex"))
        return fail("OPERATION_CONFLICT");
      // Same-channel hashed read is part of this transaction's MVCC set, not an application preflight.
      await stub.putState(
        key,
        encode({ ...prior, version: prior.version + 1, status: "ACTIVE", activation }),
      );
      return encode({ recordId: activation.activationId, digest: digest(activation) });
    }
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

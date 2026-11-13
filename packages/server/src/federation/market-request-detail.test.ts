import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  federationCapabilities,
  federationCommercialAgreements,
  federationMarketRequests,
  type PgDb,
  users,
} from "@kuintessence/db";
import { MarketRequestSchema } from "@kuintessence/shared/federation/market-request";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { FederationMarketRequestService } from "./market-requests";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const site = uuid(1),
  revision = uuid(2),
  reservation = uuid(3),
  actor = { userId: uuid(4), orgId: uuid(5) };
const signingKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const hash = `sha256:${"a".repeat(64)}`;
function fixture() {
  const resources = { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 30 };
  const issuedAt = "2026-11-11T00:00:00Z",
    expiresAt = "2026-11-11T00:15:00Z";
  const payload = MarketRequestSchema.parse({
    protocolVersion: 1,
    kind: "market-request",
    demand: {
      protocolVersion: 1,
      demandId: uuid(6),
      sourceSiteId: site,
      createdAt: issuedAt,
      expiresAt,
      title: "Task",
      description: "",
      platform: "linux",
      architecture: "x86_64",
      resources,
    },
    proposal: {
      protocolVersion: 1,
      kind: "commercial-reservation",
      domainId: uuid(7),
      reservationId: reservation,
      demandId: uuid(6),
      claimVersion: 2,
      agreementDigest: hash,
      salt: "b".repeat(64),
      request: {
        protocolVersion: 1,
        kind: "delegation",
        operationId: reservation,
        senderSiteId: site,
        recipientSiteId: uuid(8),
        agreementRevisionId: revision,
        mode: "ledger_coordinated",
        budgetDomainId: uuid(9),
        epoch: uuid(10),
        taskId: uuid(11),
        attempt: 1,
        issuedAt,
        expiresAt,
        template: { originSiteId: site, kind: "script", id: uuid(12), revision: "1", digest: hash },
        inputManifestDigest: hash,
        environmentLockDigest: hash,
        resources,
        maxAmount: "100",
        unit: "credit",
      },
    },
  });
  const row = {
    reservationId: reservation,
    demandId: payload.demand.demandId,
    agreementRevisionId: revision,
    policyId: uuid(13),
    direction: "outbound",
    state: "pending",
    lastError: null,
    marketSubmissionId: null,
    createdAt: new Date(),
    completedAt: null,
    nextAttemptAt: null,
    payload,
    digest: `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`,
    sourceJws: "private-signature",
    leaseToken: "internal-lease",
  };
  const rows = new Map<unknown, unknown[]>([
    [users, [{ id: actor.userId }]],
    [federationCapabilities, [{}]],
    [federationCommercialAgreements, [{}]],
    [federationMarketRequests, [row]],
  ]);
  const predicates: { table: unknown; params: unknown[]; sql: string }[] = [];
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        const builder = {
          innerJoin: () => builder,
          where: (query: SQL) => {
            const compiled = new PgDialect().sqlToQuery(query);
            predicates.push({ table, ...compiled });
            const result = rows.get(table) ?? [];
            return Object.assign(Promise.resolve(result), { for: async () => result });
          },
        };
        return builder;
      },
    }),
  };
  const db = {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(tx),
  } as unknown as PgDb;
  const service = new FederationMarketRequestService(db, {
    siteId: site,
    keyId: uuid(14),
    privateKey: signingKey.privateKey,
  });
  return { service, rows, predicates, row };
}
test("private request lookup scopes the contract and request to the local site, organization and exact IDs", async () => {
  const f = fixture();
  const result = await f.service.get(actor, revision, reservation);
  const query = f.predicates.find((item) => item.table === federationMarketRequests);
  expect(query?.params).toEqual([site, reservation, actor.orgId, revision]);
  expect(
    f.predicates.find((item) => item.table === federationCommercialAgreements)?.params,
  ).toEqual([site, revision, actor.orgId]);
  expect(result.request).toEqual(f.row.payload);
  expect(result).not.toHaveProperty("sourceJws");
  expect(result).not.toHaveProperty("leaseToken");
});
test("private request lookup rejects denied readers, absent scope and corrupted original intent", async () => {
  const denied = fixture();
  denied.rows.set(federationCapabilities, []);
  await expect(denied.service.get(actor, revision, reservation)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  expect(denied.predicates.some((item) => item.table === federationMarketRequests)).toBe(false);
  const absent = fixture();
  absent.rows.set(federationCommercialAgreements, []);
  await expect(absent.service.get(actor, revision, reservation)).rejects.toMatchObject({
    code: "AGREEMENT_UNAVAILABLE",
  });
  const missing = fixture();
  missing.rows.set(federationMarketRequests, []);
  await expect(missing.service.get(actor, revision, reservation)).rejects.toMatchObject({
    code: "ASSET_UNAVAILABLE",
  });
  const corrupt = fixture();
  corrupt.row.digest = `sha256:${"f".repeat(64)}`;
  await expect(corrupt.service.get(actor, revision, reservation)).rejects.toMatchObject({
    code: "OPERATION_CONFLICT",
  });
});

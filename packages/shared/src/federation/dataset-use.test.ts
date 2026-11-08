import { expect, test } from "bun:test";
import {
  assertDatasetUseGrant,
  FederationDatasetUseGrantSchema,
  FederationDatasetUseQuerySchema,
} from "./dataset-use";
import { federationCapabilitySources } from "./permissions";

const now = new Date("2026-01-01T00:00:00Z");
const source = crypto.randomUUID(),
  target = crypto.randomUUID();
const query = FederationDatasetUseQuerySchema.parse({
  protocolVersion: 1,
  kind: "dataset-use-query",
  queryId: crypto.randomUUID(),
  policyId: crypto.randomUUID(),
  senderSiteId: target,
  recipientSiteId: source,
  agreementRevisionId: crypto.randomUUID(),
  asset: {
    kind: "dataset",
    originSiteId: source,
    id: crypto.randomUUID(),
    revision: "v1",
    digest: `sha256:${"a".repeat(64)}`,
  },
  replicaId: crypto.randomUUID(),
  agentId: "recipient-worker",
  managedRootId: crypto.randomUUID(),
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 60_000).toISOString(),
});
const digest = `sha256:${"b".repeat(64)}`;
const grant = FederationDatasetUseGrantSchema.parse({
  ...query,
  kind: "dataset-use-grant",
  senderSiteId: source,
  recipientSiteId: target,
  queryDigest: digest,
});
test("dataset use is an independent institutional permission and a narrowly bound lease", () => {
  expect(federationCapabilitySources("dataset.use.approve")).toEqual(["dataset.use.approve"]);
  assertDatasetUseGrant(query, digest, grant, now);
  for (const changed of [
    { ...grant, policyId: crypto.randomUUID() },
    { ...grant, replicaId: crypto.randomUUID() },
    { ...grant, managedRootId: crypto.randomUUID() },
    { ...grant, asset: { ...grant.asset, revision: "v2" } },
    { ...grant, recipientSiteId: source },
    { ...grant, queryDigest: query.asset.digest },
    { ...grant, expiresAt: new Date(now.getTime() + 60_001).toISOString() },
  ])
    expect(() => assertDatasetUseGrant(query, digest, changed, now)).toThrow();
  expect(() =>
    assertDatasetUseGrant(query, digest, grant, new Date(now.getTime() + 60_001)),
  ).toThrow();
  expect(FederationDatasetUseGrantSchema.safeParse({ ...grant, download: true }).success).toBe(
    false,
  );
});

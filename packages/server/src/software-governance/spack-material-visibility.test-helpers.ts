import { createHash, randomUUID } from "node:crypto";
import {
  agentCerts,
  agents,
  createPgDb,
  orgs,
  type PgDb,
  SpackMaterialReferences,
  SpackMaterialRollout,
  SpackMaterialVisibility,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { AppError, type SpackMaterialManifest } from "@kuintessence/shared";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { jwtVerify } from "jose";
import { type AgentChannel, AgentDispatcher } from "../grpc/dispatcher";
import { deriveCpScope } from "../middleware/cp-rbac";
import { createAgentSpackMaterialRoutes } from "../routes/agent-spack-materials";
import { InstalledRegistry } from "./installed-registry";
import { SoftwareOperationService } from "./operation-service";
import { createSpackDeliveryAccess } from "./spack-delivery-access";
import { SpackMaterialDelivery } from "./spack-material-delivery";

export const ACTOR = randomUUID();
export const OPERATOR = randomUUID();
export const PROVIDER = randomUUID();
export const READER_ORG = randomUUID();
export const AGENT = `visibility-${randomUUID()}`;
export const SPEC = "hello@2.12.1";
const FINGERPRINT = "c".repeat(64);
const REGISTRY_SECRET = "visibility-registry-fixture".repeat(3);
const EVIDENCE = {
  legacyProcessesStoppedAndDrained: true,
  legacyAccessRevoked: true,
  legacyInventoryComplete: true,
} as const;
const TABLES = [
  "orgs",
  "users",
  "user_org_memberships",
  "agents",
  "agent_certs",
  "software_policies",
  "software_policy_overlays",
  "software_operations",
  "spack_material_bindings",
  "spack_material_operation_references",
  "spack_material_rollouts",
  "spack_material_binding_retirements",
  "spack_material_lifecycle_events",
  "spack_material_visibility_events",
];
const digest = (bytes: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const BLOB_BYTES = Buffer.from("visibility source fixture");
export const BLOB = { digest: digest(BLOB_BYTES), size: BLOB_BYTES.length };
const MANIFEST: SpackMaterialManifest = {
  version: 1,
  repository: "public/visibility-sources",
  spec: SPEC,
  spackVersion: "1.0.0",
  target: "linux-x86_64",
  redistribution: "unrestricted",
  recipes: [
    {
      repositoryId: "a".repeat(64),
      commit: "b".repeat(40),
      roots: ["."],
      archive: BLOB,
    },
  ],
  sources: [{ path: "hello/hello-2.12.1.tar.gz", blob: BLOB }],
  lockfile: BLOB,
};
export const MANIFEST_BYTES = Buffer.from(JSON.stringify(MANIFEST));
export const BINDING = {
  repositoryId: createHash("sha256").update(MANIFEST.repository).digest("hex"),
  manifestDigest: digest(MANIFEST_BYTES),
};

export function visibilityDatabase() {
  const schema = `server_visibility_${randomUUID().replaceAll("-", "")}`;
  const connections: PgDb[] = [];
  let admin: PgDb | undefined;
  let created = false;
  function connect(searchPath: string) {
    const url = new URL(
      process.env.KQ_PG_URL ??
        process.env.DATABASE_URL ??
        "postgres://kq:kq@localhost:5432/kuintessence",
    );
    url.searchParams.set("search_path", searchPath);
    url.searchParams.set("statement_timeout", "10000");
    const db = createPgDb(url.toString(), { max: 1, idle_timeout: 0 });
    connections.push(db);
    return db;
  }
  return {
    async initialize() {
      admin = connect("public");
      await admin.execute(sql`create schema ${sql.identifier(schema)}`);
      created = true;
      for (const table of TABLES) {
        await admin.execute(sql`
          create table ${sql.identifier(schema)}.${sql.identifier(table)}
          (like public.${sql.identifier(table)} including all)
        `);
      }
      return connect(schema);
    },
    async reset(db: PgDb) {
      for (const table of [...TABLES].reverse()) {
        await db.execute(sql`truncate table ${sql.identifier(schema)}.${sql.identifier(table)}`);
      }
    },
    async close() {
      try {
        if (created && admin) {
          await admin.execute(sql`drop schema ${sql.identifier(schema)} cascade`);
        }
      } finally {
        await Promise.all(connections.map((db) => db.$client.end()));
      }
    },
  };
}

export async function visibilityDelivery(db: PgDb) {
  await db.insert(orgs).values([
    { id: PROVIDER, name: "Delivery provider fixture" },
    { id: READER_ORG, name: "Material reader fixture" },
  ]);
  await db.insert(users).values([
    { id: ACTOR, email: `${ACTOR}@example.invalid`, role: "user" },
    { id: OPERATOR, email: `${OPERATOR}@example.invalid`, role: "platform_admin" },
  ]);
  await db.insert(userOrgMemberships).values([
    { userId: ACTOR, orgId: PROVIDER, role: "admin" },
    { userId: ACTOR, orgId: READER_ORG, role: "member" },
  ]);
  await db.insert(agents).values({
    agentId: AGENT,
    providerOrgId: PROVIDER,
    siteName: "visibility-fixture",
    schedulerType: "slurm",
    schedulerVersion: "test",
  });
  await db.insert(agentCerts).values({
    agentId: AGENT,
    fingerprintSha256: FINGERPRINT,
    subjectCn: AGENT,
    certPem: "fixture certificate metadata",
    issuedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const bindings = { [SPEC]: BINDING };
  const rollout = new SpackMaterialRollout(db);
  let state = await rollout.execute({ action: "pause", operatorId: OPERATOR, expectedRevision: 0 });
  state = await rollout.execute({
    action: "reconcile",
    operatorId: OPERATOR,
    expectedRevision: state.revision,
    epoch: state.epoch,
    bindings: [bindings],
  });
  state = await rollout.execute({
    action: "activate-policy",
    operatorId: OPERATOR,
    expectedRevision: state.revision,
    epoch: state.epoch,
    inventoryDigest: state.inventoryDigest,
    evidence: EVIDENCE,
  });
  if (!state.epoch || state.phase !== "policy-ready") throw new Error("Policy rollout not ready");
  const visibility = new SpackMaterialVisibility(db, state.epoch);
  const references = new SpackMaterialReferences(db, state.epoch);
  const access = createSpackDeliveryAccess(db, {
    mode: "off",
    requirePermission: async () => {
      throw new Error("Unexpected enforce authorization");
    },
    shadowCheck: async () => {
      throw new Error("Unexpected shadow authorization");
    },
  });
  const pushed: Parameters<AgentChannel["push"]>[0][] = [];
  const dispatcher = new AgentDispatcher();
  dispatcher.register(AGENT, {
    push: (message) => {
      pushed.push(message);
    },
    close() {},
    spackMaterialDeliveryV1: true,
    verifiedCertFingerprint: FINGERPRINT,
  });
  const registryCalls: string[] = [];
  const base = `https://registry.example.test/api/spack/material-repositories/${BINDING.repositoryId}/releases/${BINDING.manifestDigest}`;
  let afterManifest: (() => Promise<void>) | undefined;
  const delivery = new SpackMaterialDelivery({
    registryUrl: "https://registry.example.test",
    registryJwtSecret: REGISTRY_SECRET,
    ticketSecret: "visibility-ticket-fixture".repeat(3),
    bindings,
    references,
    access,
    dispatcher,
    // Only the immutable byte source is fake; admission uses the real PG services.
    fetch: Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        registryCalls.push(url);
        const authorization = new Headers(init?.headers).get("Authorization");
        const { payload } = await jwtVerify(
          authorization?.slice(7) ?? "",
          new TextEncoder().encode(REGISTRY_SECRET),
          { algorithms: ["HS256"] },
        );
        if (payload.sub !== ACTOR) throw new Error("Wrong Registry requester");
        if (url === base) {
          await afterManifest?.();
          return new Response(MANIFEST_BYTES);
        }
        if (url === `${base}/blobs/${BLOB.digest}`) return new Response(BLOB_BYTES);
        throw new Error("Unexpected Registry path");
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toJSON(), error.statusCode as 400 | 401 | 403 | 404 | 429 | 502 | 503);
    }
    return c.json({ error: "internal" }, 500);
  });
  app.route("/api", createAgentSpackMaterialRoutes(delivery));
  const operations = new SoftwareOperationService(
    db,
    dispatcher,
    new InstalledRegistry(db),
    (input) => delivery.prepareOperation(input),
  );
  const scope = deriveCpScope({
    sub: ACTOR,
    role: "user",
    memberships: [{ orgId: PROVIDER, role: "admin" }],
  });
  return {
    delivery,
    visibility,
    references,
    access,
    app,
    bindings,
    pushed,
    registryCalls,
    requestInstall: () =>
      operations.requestOperation({
        scope,
        agentId: AGENT,
        requestedBy: ACTOR,
        spec: SPEC,
        action: "install",
      }),
    afterManifest(callback?: () => Promise<void>) {
      afterManifest = callback;
    },
    changePolicy(input: Parameters<SpackMaterialVisibility["transition"]>[2]) {
      return visibility.transition(BINDING, OPERATOR, input, async (principal) => {
        if (principal.sub !== OPERATOR || principal.role !== "platform_admin") {
          throw new Error("Fixture operator is not authorized");
        }
      });
    },
  };
}

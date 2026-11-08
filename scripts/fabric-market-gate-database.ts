import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  federationCommercialSubmissions as commercialSubmissions,
  federationCompletionClaims as completionClaims,
  createPgDb,
  federationMarketAttempts as marketAttempts,
  federationMarketSubmissions as marketSubmissions,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { FederationAgreementSchema, FederationError } from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  CommercialReleaseSchema,
  CommercialReservationSchema,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  FabricMarketTrustSchema,
  MarketDemandStateSchema,
  MarketExecutionGateSchema,
} from "@kuintessence/shared/federation/market";
import { and, eq, sql } from "drizzle-orm";
import { importPKCS8 } from "jose";
import postgres from "postgres";
import { z } from "zod";
import { migratePostgresDatabase } from "../packages/db/src/pg/migrate";
import { FederationAgreementService } from "../packages/server/src/federation/agreements";
import { federationMaterialDigest } from "../packages/server/src/federation/assets";
import { FederationCommercialAgreementService } from "../packages/server/src/federation/commercial-agreements";
import { UnixCommercialClient } from "../packages/server/src/federation/commercial-client";
import { FederationCommercialExecutionService } from "../packages/server/src/federation/commercial-execution";
import { FederationCommercialSubmissionService } from "../packages/server/src/federation/commercial-submissions";
import { FederationCompletionCapacity } from "../packages/server/src/federation/completion-capacity";
import { FederationExecutionConfirmationService } from "../packages/server/src/federation/execution-confirmation";
import { FabricClientFailure } from "../packages/server/src/federation/fabric-client";
import { FederationMarketService } from "../packages/server/src/federation/market";
import { UnixMarketClient } from "../packages/server/src/federation/market-client";
import { FederationPermissionService } from "../packages/server/src/federation/permissions";
import { signFederationMessage } from "../packages/server/src/federation/signatures";
import { testCompletionStorage } from "../packages/server/src/federation/test-fixtures";
import { FederationTrustRegistry } from "../packages/server/src/federation/trust-registry";
import { Site } from "./fabric-evidence-fixture";
import { databaseUrlWithName, unitDatabaseName } from "./test-unit";

export async function verifyGateDatabase(
  root: string,
  sourceUrl: string,
  controls: {
    stopOrderer(): Promise<void>;
    startOrderer(): Promise<void>;
    onCleanup(cleanup: () => Promise<void>): void;
  },
  pass: (name: string) => void,
) {
  const fixture = z
    .object({
      agreement: CommercialAgreementSchema,
      fundedReservation: CommercialReservationSchema,
      freshReservation: CommercialReservationSchema,
      fundedDemand: MarketDemandStateSchema,
      freshDemand: MarketDemandStateSchema,
      releasePayload: CommercialReleaseSchema,
      releasedGate: MarketExecutionGateSchema,
    })
    .parse(JSON.parse(await readFile(join(root, "gate-adapter-fixture.json"), "utf8")));
  const network = z
    .object({
      channel: z.string(),
      trust: FabricCommercialTrustSchema,
      sites: z.array(Site),
    })
    .parse(JSON.parse(await readFile(join(root, "network.json"), "utf8")));
  const siteA = Site.parse(network.sites.find((site) => site.name === "A"));
  const siteB = Site.parse(network.sites.find((site) => site.name === "B"));
  const name = unitDatabaseName(new Date(), process.pid, randomUUID());
  const url = databaseUrlWithName(sourceUrl, name);
  const admin = postgres(databaseUrlWithName(sourceUrl, "postgres"), {
    max: 1,
    connect_timeout: 5,
  });
  const db = createPgDb(url, { max: 4, idle_timeout: 1 });
  const children = new Set<Bun.Subprocess>();
  let created = false;
  let cleaned: Promise<void> | undefined;
  function cleanup() {
    cleaned ??= (async () => {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try {
          await child.exited;
        } finally {
          clearTimeout(timer);
        }
      }
      await db.$client.end({ timeout: 5 });
      try {
        if (created) await admin`DROP DATABASE ${admin(name)} WITH (FORCE)`;
      } finally {
        await admin.end({ timeout: 5 });
      }
    })();
    return cleaned;
  }
  controls.onCleanup(cleanup);
  try {
    await admin`CREATE DATABASE ${admin(name)}`;
    created = true;
    await migratePostgresDatabase(url);
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../packages/fabric-adapter/src/main.ts")],
      target: "node",
      format: "esm",
      external: ["@hyperledger/fabric-gateway", "@hyperledger/fabric-protos", "@grpc/grpc-js"],
    });
    assert(build.success && build.outputs[0]);
    const entry = join(root, "gate-db-adapter.mjs");
    await writeFile(entry, await build.outputs[0].text(), { mode: 0o600 });
    await writeFile(join(root, "gate-db-recovery.key"), randomBytes(32), { mode: 0o600 });
    for (const [kind, site, suffix] of [
      ["commercial", siteA, "commercial"],
      ["market", siteA, "market"],
      ["commercial", siteB, "provider-commercial"],
    ] as const) {
      const user = kind === "market" ? "User2" : "User1";
      const userDomain = `${user}@${site.name.toLowerCase()}.kq.test`;
      const msp = join(dirname(dirname(site.userMsp)), userDomain, "msp");
      const keys = await readdir(join(msp, "keystore"));
      assert(keys.length === 1 && keys[0]);
      const runDirectory = join(root, `gate-db-${suffix}`);
      await mkdir(runDirectory, { recursive: true, mode: 0o700 });
      const config = join(root, `gate-db-${suffix}.json`);
      await writeFile(
        config,
        JSON.stringify({
          adapter: {
            siteId: site.siteId,
            channel: network.channel,
            chaincode: `kq-${kind}`,
            trust:
              kind === "commercial"
                ? network.trust
                : FabricMarketTrustSchema.parse(
                    JSON.parse(await readFile(join(root, "gate-market-trust.json"), "utf8")),
                  ),
          },
          peerEndpoint: `127.0.0.1:${site.peerPort}`,
          peerTlsCaFile: join(site.tls, "ca.crt"),
          tlsCertificateFile: join(site.tls, "server.crt"),
          tlsPrivateKeyFile: join(site.tls, "server.key"),
          identityCertificateFile: join(msp, "signcerts", `${userDomain}-cert.pem`),
          identityPrivateKeyFile: join(msp, "keystore", keys[0]),
          recoveryKeyFile: join(root, "gate-db-recovery.key"),
          runDirectory,
        }),
        { mode: 0o600 },
      );
      const fd = openSync(join(root, `gate-db-${suffix}.log`), "a", 0o600);
      let child: Bun.Subprocess;
      try {
        child = Bun.spawn(["node", entry], {
          env: { ...process.env, KQ_FABRIC_ADAPTER_KIND: kind, KQ_FABRIC_ADAPTER_CONFIG: config },
          stdout: fd,
          stderr: fd,
        });
        children.add(child);
      } finally {
        closeSync(fd);
      }
      const deadline = Date.now() + 15000;
      for (;;) {
        assert.equal(child.exitCode, null, "Production gate adapter must remain alive");
        try {
          const reply = await fetch("http://localhost/health", {
            unix: join(runDirectory, `${kind}.sock`),
            signal: AbortSignal.timeout(1000),
          });
          if (reply.ok) break;
        } catch {
          /* Bounded by deadline. */
        }
        assert(Date.now() < deadline, "Production gate adapter ready");
        await Bun.sleep(200);
      }
    }
    const trust = new FederationTrustRegistry(db);
    const institutions = [];
    for (const site of [siteA, siteB]) {
      const actor = { userId: randomUUID(), orgId: randomUUID() };
      await db.insert(orgs).values({ id: actor.orgId, name: "Gate integration institution" });
      await db.insert(users).values({
        id: actor.userId,
        orgId: actor.orgId,
        email: `${actor.userId}@test.invalid`,
        role: "platform_admin",
      });
      await db.insert(userOrgMemberships).values({ ...actor, role: "owner" });
      for (const capability of ["agreement.approve", "market.publish", "market.claim"] as const)
        await new FederationPermissionService(db).set(
          { ...actor, capability, enabled: true },
          actor.userId,
        );
      const org = network.trust.organizations.find((org) => org.siteId === site.siteId);
      const key = org?.keys[0];
      assert(org && key);
      const purposes = network.trust.keyPurposes.find(
        (item) => item.siteId === site.siteId && item.keyId === key.keyId,
      );
      assert(purposes);
      await trust.addSite(
        { id: site.siteId, name: `Institution ${site.name}`, endpoint: "https://test.invalid" },
        actor.userId,
      );
      await trust.addKey(
        site.siteId,
        { ...key, allowedKinds: [...purposes.kinds, "agreement"] },
        actor.userId,
      );
      institutions.push({
        actor,
        key: {
          siteId: site.siteId,
          keyId: key.keyId,
          privateKey: await importPKCS8(await readFile(site.businessKeyFile, "utf8"), "RS256"),
        },
      });
    }
    const a = institutions[0],
      b = institutions[1];
    assert(a && b);
    // These publications/claims were committed by the native probe; import their historical local intents.
    for (const state of [fixture.fundedDemand, fixture.freshDemand]) {
      assert(state.claim && state.status === "CLAIMED");
      for (const [institution, input, id] of [
        [a, { operation: "publish-demand" as const, demand: state.demand }, state.demand.demandId],
        [b, { operation: "claim-demand" as const, claim: state.claim }, state.claim.claimId],
      ] as const)
        await db.insert(marketSubmissions).values({
          id,
          demandId: state.demand.demandId,
          localSiteId: institution.key.siteId,
          localOrgId: institution.actor.orgId,
          requestedBy: institution.actor.userId,
          input,
          digest: federationMaterialDigest(input),
          state: "committed",
        });
    }
    const marketClient = new UnixMarketClient(join(root, "gate-db-market", "market.sock"));
    const commercialClient = new UnixCommercialClient(
      join(root, "gate-db-commercial", "commercial.sock"),
    );
    const providerCommercialClient = new UnixCommercialClient(
      join(root, "gate-db-provider-commercial", "commercial.sock"),
    );
    const sourceStorage = testCompletionStorage(),
      providerStorage = testCompletionStorage();
    const aAgreements = new FederationCommercialAgreementService(db, a.key);
    const bAgreements = new FederationCommercialAgreementService(db, b.key);
    const revision = fixture.agreement.agreement.agreementRevisionId;
    const aContract = await aAgreements.approve(a.actor, fixture.agreement);
    const bContract = await bAgreements.approve(b.actor, fixture.agreement);
    await aAgreements.attachCounterparty(a.actor, revision, bContract.approvalJws);
    await bAgreements.attachCounterparty(b.actor, revision, aContract.approvalJws);
    const aExecution = new FederationCommercialExecutionService(
      db,
      a.key,
      marketClient,
      undefined,
      sourceStorage.guard,
    );
    const bExecution = new FederationCommercialExecutionService(
      db,
      b.key,
      marketClient,
      undefined,
      providerStorage.guard,
    );
    const approve = async (
      payload:
        | z.infer<typeof CommercialReservationSchema>
        | z.infer<typeof CommercialReleaseSchema>,
    ) => {
      const first = await aExecution.approve(a.actor, revision, payload);
      const second = await bExecution.approve(b.actor, revision, payload);
      await aExecution.attachCounterparty(a.actor, revision, first.recordId, second.approvalJws);
      await bExecution.attachCounterparty(b.actor, revision, second.recordId, first.approvalJws);
    };
    const drain = async (recordId: string, operation: string, provider = false) => {
      const institution = provider ? b : a;
      const deadline = Date.now() + 120000;
      for (;;) {
        const [row] = await db
          .select()
          .from(commercialSubmissions)
          .where(
            and(
              eq(commercialSubmissions.localSiteId, institution.key.siteId),
              sql`${commercialSubmissions.input}->>'recordId' = ${recordId}`,
              sql`${commercialSubmissions.input}->>'operation' = ${operation}`,
            ),
          );
        assert(
          row && row.state !== "needs_review",
          `Commercial gate submission refused: ${row?.lastError}`,
        );
        if (row.state === "committed") return;
        assert(Date.now() < deadline, "Commercial gate submission committed");
        await new FederationCommercialSubmissionService(
          db,
          institution.key.siteId,
          provider ? providerCommercialClient : commercialClient,
        ).advanceNext();
        await Bun.sleep(200);
      }
    };
    await approve(fixture.fundedReservation);
    await drain(fixture.fundedReservation.reservationId, "reserve-execution");
    await drain(fixture.fundedReservation.reservationId, "reserve-execution", true);
    const sourceCapacity = new FederationCompletionCapacity(db, a.key.siteId, sourceStorage.guard);
    const providerCapacity = new FederationCompletionCapacity(
      db,
      b.key.siteId,
      providerStorage.guard,
    );
    for (const [capacity, storage, actor] of [
      [sourceCapacity, sourceStorage, a.actor],
      [providerCapacity, providerStorage, b.actor],
    ] as const) {
      await capacity.configure(
        { reserveId: storage.reserveId, capacityBytes: "200", taskBytes: "60", marketBytes: "20" },
        actor.userId,
      );
      assert.equal((await capacity.inspect()).allocatedBytes, "100");
    }
    await approve(fixture.releasePayload);
    await drain(fixture.releasePayload.releaseId, "release-execution");
    await drain(fixture.releasePayload.releaseId, "release-execution", true);
    const released = await commercialClient.query({
      operation: "get-execution-gate-hash",
      domainId: fixture.releasedGate.domainId,
      reservationId: fixture.releasedGate.reservationId,
    });
    assert.equal(
      released.hash,
      createHash("sha256").update(JSON.stringify(fixture.releasedGate)).digest("hex"),
    );
    const scan = async (provider = false) => {
      const capacity = provider ? providerCapacity : sourceCapacity;
      await db
        .update(completionClaims)
        .set({ nextCheckAt: new Date(0) })
        .where(eq(completionClaims.localSiteId, provider ? b.key.siteId : a.key.siteId));
      for (let i = 0; i < 4; i++) if (!(await capacity.advanceNext())) break;
      return (await capacity.inspect()).allocatedBytes;
    };
    assert.equal(await scan(true), "20");
    assert.equal(await scan(), "100");
    const closureId = fixture.releasePayload.releaseId;
    let lostClosureResponse = false;
    const closureWorker = new FederationMarketService(db, a.key.siteId, {
      prepare: (input) => marketClient.prepare(input),
      query: (input) => marketClient.query(input),
      advance: async (token) => {
        const result = await marketClient.advance(token);
        if (result.state === "committed" && !lostClosureResponse) {
          lostClosureResponse = true;
          throw new Error("Simulated lost closure commit response");
        }
        return result;
      },
    });
    const closureDeadline = Date.now() + 120000;
    while (!lostClosureResponse) {
      assert(Date.now() < closureDeadline, "Public closure reached VALID");
      await closureWorker.advanceNext();
      await Bun.sleep(200);
    }
    const closureStatus = await closureWorker.get(a.actor, closureId);
    assert.equal(closureStatus.operation.state, "pending");
    assert.equal(closureStatus.transactions.length, 1);
    assert.equal(await scan(), "100");
    const resumedClosure = new FederationMarketService(db, a.key.siteId, marketClient);
    while ((await resumedClosure.get(a.actor, closureId)).operation.state !== "committed") {
      assert(Date.now() < closureDeadline, "Public closure resumes original transaction");
      await resumedClosure.advanceNext();
      await Bun.sleep(200);
    }
    const confirmedClosure = await resumedClosure.get(a.actor, closureId);
    assert.equal(confirmedClosure.transactions.length, 1);
    assert.equal(
      confirmedClosure.transactions[0]?.transactionId,
      closureStatus.transactions[0]?.transactionId,
    );
    assert.equal(await scan(), "20");
    const publicState = await marketClient.query({
      operation: "get-demand",
      demandId: fixture.fundedReservation.demandId,
    });
    assert(publicState.operation === "get-demand" && publicState.demand?.status === "CLOSED");
    assert.equal(publicState.demand.activation, null);
    await assert.rejects(
      aExecution.activate(a.actor, revision, fixture.fundedReservation.reservationId, randomUUID()),
      (error: unknown) => error instanceof FederationError && error.code === "OPERATION_CONFLICT",
    );
    pass(
      "real Fabric private release reclaims provider capacity; source waits for its original public VALID closure, including lost-response recovery, without reopening execution",
    );
    if (process.argv.includes("--preexecution-closure")) return;
    await approve(fixture.freshReservation);
    await drain(fixture.freshReservation.reservationId, "reserve-execution");
    pass(
      "real PostgreSQL bilateral approvals submit original private reserve, release and replacement reserve through production runtimes",
    );
    const activationId = randomUUID();
    await aExecution.activate(
      a.actor,
      revision,
      fixture.freshReservation.reservationId,
      activationId,
    );
    const market = new FederationMarketService(db, a.key.siteId, marketClient);
    assert(await market.advanceNext());
    assert(await market.advanceNext());
    const [checkpoint] = await db
      .select()
      .from(marketAttempts)
      .where(eq(marketAttempts.submissionId, activationId));
    assert(checkpoint?.stage === "transaction");
    await controls.stopOrderer();
    try {
      assert(await market.advanceNext());
    } finally {
      await controls.startOrderer();
    }
    const [pending] = await db
      .select()
      .from(marketSubmissions)
      .where(eq(marketSubmissions.id, activationId));
    assert(pending?.state === "pending" && pending.lastError === "LEDGER_PENDING");
    const deadline = Date.now() + 120000;
    let loseResponse = true;
    const recovered = new FederationMarketService(db, a.key.siteId, {
      prepare: (input) => marketClient.prepare(input),
      query: (input) => marketClient.query(input),
      advance: async (token) => {
        const result = await marketClient.advance(token);
        if (result.state === "committed" && loseResponse) {
          loseResponse = false;
          throw new Error("Simulated lost successful response");
        }
        return result;
      },
    });
    for (;;) {
      const status = await recovered.get(a.actor, activationId);
      if (status.operation.state === "committed") {
        assert.equal(loseResponse, false);
        assert.equal(status.transactions.length, 1);
        assert.equal(status.transactions[0]?.transactionId, checkpoint.transactionId);
        break;
      }
      assert.equal(status.operation.state, "pending");
      assert(Date.now() < deadline, "Activation resumes original committed transaction");
      await recovered.advanceNext();
      await Bun.sleep(500);
    }
    const result = await marketClient.query({
      operation: "get-demand",
      demandId: fixture.freshReservation.demandId,
    });
    assert(result.operation === "get-demand" && result.demand?.status === "ACTIVE");
    assert.equal(result.demand.activation?.activationId, activationId);
    assert.equal(
      result.demand.activation?.gate.reservationId,
      fixture.freshReservation.reservationId,
    );
    pass(
      "real database activation survives Orderer outage and lost VALID response with one original transaction and matching ACTIVE demand",
    );
    const ordinary = new FederationAgreementService(db, a.key);
    await ordinary.approve(a.actor, { terms: fixture.agreement.agreement });
    await ordinary.attachCounterparty(
      a.actor,
      revision,
      await signFederationMessage(FederationAgreementSchema, fixture.agreement.agreement, b.key),
    );
    const confirmation = new FederationExecutionConfirmationService(db, a.key.siteId, marketClient);
    const intent = await confirmation.request(
      a.actor,
      revision,
      fixture.freshReservation.reservationId,
    );
    const authorize = () =>
      db.transaction((tx) =>
        confirmation.authorize(tx, a.actor.orgId, fixture.freshReservation.request),
      );
    const pendingProof = (error: unknown) =>
      error instanceof FabricClientFailure && error.code === "LEDGER_PENDING";
    await assert.rejects(authorize, pendingProof);
    for (let stage = 0; stage < 3; stage++) {
      assert(await market.advanceNext());
      if (stage < 2) await assert.rejects(authorize, pendingProof);
    }
    const proof = await authorize();
    assert.equal(proof.authorizationId, intent.id);
    assert.equal(proof.reservationId, fixture.freshReservation.reservationId);
    assert(proof.expiresAtUnixMs > Date.now() && proof.expiresAtUnixMs <= Date.now() + 300000);
    assert.equal(
      (await confirmation.request(a.actor, revision, fixture.freshReservation.reservationId)).id,
      intent.id,
    );
    await ordinary.setState(a.actor, revision, "suspended");
    await assert.rejects(
      authorize,
      (error: unknown) =>
        error instanceof FederationError && error.code === "AGREEMENT_UNAVAILABLE",
    );
    pass(
      "real Server confirmation persists and consumes only VALID bounded authority; local suspension overrides committed chain proof",
    );
  } finally {
    await cleanup();
  }
}

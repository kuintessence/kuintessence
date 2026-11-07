import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type CommercialAdapterProposalInput,
  CommercialExecutionProposalInputSchema,
  CommercialTerminalSchema,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import { FabricProposalCheckpointSchema } from "@kuintessence/shared/federation/ledger";
import {
  FabricMarketTrustSchema,
  MarketAdapterProposalInputSchema,
  MarketClosureSchema,
  MarketExecutionAuthorizationSchema,
  MarketExecutionGateSchema,
  MarketExecutionStopSchema,
} from "@kuintessence/shared/federation/market";
import { signFederationMessage } from "@kuintessence/shared/federation/signatures";
import { importPKCS8 } from "jose";
import { z } from "zod";
import { startCommercialAdapter } from "../packages/fabric-adapter/src/commercial-runtime";
import { startMarketAdapter } from "../packages/fabric-adapter/src/market-runtime";
import { UnixCommercialClient } from "../packages/server/src/federation/commercial-client";
import { UnixMarketClient } from "../packages/server/src/federation/market-client";
import { Site } from "./fabric-evidence-fixture";

const root = z.string().parse(process.argv[2]);
const operation = z
  .enum(["release", "reserve", "activate", "authorize", "stop", "terminal", "close"])
  .parse(process.argv[3]);
const action = z.enum(["prepare", "advance", "crash", "query"]).parse(process.argv[4]);
const replyFile = z.string().parse(process.argv[5]);
const fixture = z
  .object({
    release: CommercialExecutionProposalInputSchema,
    reserve: CommercialExecutionProposalInputSchema,
    activate: MarketAdapterProposalInputSchema,
    releasedGate: MarketExecutionGateSchema,
  })
  .parse(JSON.parse(await readFile(join(root, "gate-adapter-fixture.json"), "utf8")));
assert(fixture.activate.operation === "activate-demand");
const network = z
  .object({
    channel: z.literal("kq-evidence-test"),
    trust: FabricCommercialTrustSchema,
    sites: z.array(Site),
  })
  .parse(JSON.parse(await readFile(join(root, "network.json"), "utf8")));
const site = Site.parse(network.sites.find((site) => site.name === "A"));
const isMarket =
  operation === "activate" ||
  operation === "authorize" ||
  operation === "stop" ||
  operation === "close";
const kind = isMarket ? "market" : "commercial";
const user = isMarket ? "User2" : "User1";
const msp = join(dirname(dirname(site.userMsp)), `${user}@a.kq.test`, "msp");
const keys = await readdir(join(msp, "keystore"));
assert(keys.length === 1 && keys[0]);
const runDirectory = join(root, `gate-${kind}-adapter`);
await mkdir(runDirectory, { recursive: true, mode: 0o700 });
const configFile = join(root, `gate-${kind}-adapter.json`);
await writeFile(
  configFile,
  JSON.stringify({
    adapter: {
      siteId: site.siteId,
      channel: network.channel,
      chaincode: `kq-${kind}`,
      trust: isMarket
        ? FabricMarketTrustSchema.parse(
            JSON.parse(await readFile(join(root, "gate-market-trust.json"), "utf8")),
          )
        : network.trust,
    },
    peerEndpoint: `127.0.0.1:${site.peerPort}`,
    peerTlsCaFile: join(site.tls, "ca.crt"),
    tlsCertificateFile: join(site.tls, "server.crt"),
    tlsPrivateKeyFile: join(site.tls, "server.key"),
    identityCertificateFile: join(msp, "signcerts", `${user}@a.kq.test-cert.pem`),
    identityPrivateKeyFile: join(msp, "keystore", keys[0]),
    recoveryKeyFile: join(root, "gate-recovery.key"),
    runDirectory,
  }),
  { mode: 0o600 },
);
let close: (() => Promise<void>) | undefined;
try {
  close = await (isMarket ? startMarketAdapter : startCommercialAdapter)(configFile);
  const commercial = new UnixCommercialClient(join(runDirectory, "commercial.sock"));
  const market = new UnixMarketClient(join(runDirectory, "market.sock"));
  const client = isMarket ? market : commercial;
  const checkpointFile = join(root, `gate-${operation}-checkpoint.json`);
  if (action === "prepare") {
    let activation = fixture.activate.activation;
    if (operation === "authorize" || operation === "stop") {
      const result = await market.query({ operation: "get-demand", demandId: activation.demandId });
      assert(
        result.operation === "get-demand" &&
          result.demand?.status === "ACTIVE" &&
          result.demand.activation,
      );
      assert.deepEqual(result.demand.activation.gate, activation.gate);
      activation = result.demand.activation;
    }
    const issuedAt = Date.now();
    const authorization = MarketExecutionAuthorizationSchema.parse({
      demandId: activation.demandId,
      authorizationId: randomUUID(),
      issuerSiteId: site.siteId,
      activationId: activation.activationId,
      gate: activation.gate,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + 300000).toISOString(),
    });
    const stop = MarketExecutionStopSchema.parse({
      demandId: activation.demandId,
      stopId: randomUUID(),
      issuerSiteId: site.siteId,
      activationId: activation.activationId,
      expectedVersion: activation.expectedVersion + 1,
    });
    if (operation === "stop")
      await writeFile(join(root, "gate-stop-input.json"), JSON.stringify(stop), { mode: 0o600 });
    let terminalInput:
      | Extract<CommercialAdapterProposalInput, { operation: "record-execution-terminal" }>
      | undefined;
    if (operation === "terminal") {
      const stopped = MarketExecutionStopSchema.parse(
        JSON.parse(await readFile(join(root, "gate-stop-input.json"), "utf8")),
      );
      const terminal = CommercialTerminalSchema.parse({
        protocolVersion: 1,
        kind: "commercial-terminal",
        terminalId: randomUUID(),
        domainId: fixture.reserve.domainId,
        reservationId: fixture.reserve.recordId,
        reservationDigest: fixture.reserve.digest,
        activationId: stopped.activationId,
        sourceSiteId: fixture.reserve.envelope.sourceSiteId,
        targetSiteId: fixture.reserve.envelope.targetSiteId,
        expectedGateVersion: 1,
        outcome: "cancelled",
        executionEvidenceDigest: `sha256:${randomBytes(32).toString("hex")}`,
        resultManifestDigest: null,
        observedAt: new Date().toISOString(),
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      const signature = async (siteId: string) => {
        const signer = Site.parse(network.sites.find((s) => s.siteId === siteId));
        return signFederationMessage(CommercialTerminalSchema, terminal, {
          siteId,
          keyId: "batch-1",
          privateKey: await importPKCS8(await readFile(signer.businessKeyFile, "utf8"), "RS256"),
        });
      };
      const digest = `sha256:${createHash("sha256").update(JSON.stringify(terminal)).digest("hex")}`;
      terminalInput = {
        operation: "record-execution-terminal" as const,
        domainId: terminal.domainId,
        recordId: terminal.terminalId,
        digest,
        envelope: {
          sourceSiteId: terminal.sourceSiteId,
          targetSiteId: terminal.targetSiteId,
          sourceJws: await signature(terminal.sourceSiteId),
          targetJws: await signature(terminal.targetSiteId),
        },
      };
      const gate = MarketExecutionGateSchema.parse({
        ...activation.gate,
        version: 2,
        state: "TERMINAL",
        terminal: { terminalId: terminal.terminalId, activationId: terminal.activationId, digest },
      });
      await writeFile(join(root, "gate-terminal-gate.json"), JSON.stringify(gate), { mode: 0o600 });
    }
    const terminalGate =
      operation === "close"
        ? MarketExecutionGateSchema.parse(
            JSON.parse(await readFile(join(root, "gate-terminal-gate.json"), "utf8")),
          )
        : undefined;
    const checkpoint = terminalInput
      ? await commercial.prepare(terminalInput)
      : isMarket
        ? await market.prepare(
            terminalGate
              ? {
                  operation: "close-demand",
                  closure: MarketClosureSchema.parse({
                    demandId: terminalGate.demandId,
                    closureId: terminalGate.terminal?.terminalId,
                    expectedVersion: terminalGate.claimVersion + 1,
                    gate: terminalGate,
                  }),
                }
              : operation === "stop"
                ? { operation: "request-execution-stop", stop }
                : operation === "authorize"
                  ? { operation: "authorize-execution", authorization }
                  : fixture.activate,
          )
        : await commercial.prepare(fixture[operation === "release" ? "release" : "reserve"]);
    await writeFile(checkpointFile, JSON.stringify(checkpoint), { mode: 0o600 });
    await writeFile(
      replyFile,
      JSON.stringify({ state: "proposal", transactionId: checkpoint.transactionId }),
      { mode: 0o600 },
    );
  } else if (action === "query") {
    const deadline = Date.now() + 15000;
    for (;;) {
      if (isMarket) {
        const result = await market.query({
          operation: "get-demand",
          demandId: fixture.activate.activation.demandId,
        });
        if (
          result.operation === "get-demand" &&
          result.demand?.status ===
            (operation === "close" ? "CLOSED" : operation === "stop" ? "STOPPING" : "ACTIVE")
        ) {
          if (operation === "close")
            assert.deepEqual(
              result.demand.closure?.gate,
              MarketExecutionGateSchema.parse(
                JSON.parse(await readFile(join(root, "gate-terminal-gate.json"), "utf8")),
              ),
            );
          else if (operation === "stop")
            assert.deepEqual(
              result.demand.stopRequest,
              MarketExecutionStopSchema.parse(
                JSON.parse(await readFile(join(root, "gate-stop-input.json"), "utf8")),
              ),
            );
          else if (operation === "authorize")
            assert.deepEqual(result.demand.activation?.gate, fixture.activate.activation.gate);
          else assert.deepEqual(result.demand.activation, fixture.activate.activation);
          break;
        }
      } else {
        const gate =
          operation === "terminal"
            ? MarketExecutionGateSchema.parse(
                JSON.parse(await readFile(join(root, "gate-terminal-gate.json"), "utf8")),
              )
            : operation === "release"
              ? fixture.releasedGate
              : fixture.activate.activation.gate;
        const result = await commercial.query({
          operation: "get-execution-gate-hash",
          domainId: gate.domainId,
          reservationId: gate.reservationId,
        });
        if (result.hash === createHash("sha256").update(JSON.stringify(gate)).digest("hex")) break;
      }
      assert(Date.now() < deadline, "Committed gate state must reach the query peer");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!isMarket)
      assert.deepEqual(
        await commercial.query({
          operation: "get-execution-gate-hash",
          domainId: fixture.releasedGate.domainId,
          reservationId: randomUUID(),
        }),
        { hash: null },
      );
    await writeFile(replyFile, JSON.stringify({ state: "queried" }), { mode: 0o600 });
  } else {
    const prior = FabricProposalCheckpointSchema.parse(
      JSON.parse(await readFile(checkpointFile, "utf8")),
    );
    let next = await client.advance(prior.recovery);
    assert.equal(next.transactionId, prior.transactionId);
    if (action === "crash") {
      const deadline = Date.now() + 30000;
      while (next.state === "pending" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        next = await client.advance(prior.recovery);
        assert.equal(next.transactionId, prior.transactionId);
      }
      assert.equal(next.state, "committed");
      process.exit(86);
    }
    if (next.state === "prepared")
      await writeFile(
        checkpointFile,
        JSON.stringify({
          transactionId: next.transactionId,
          recovery: next.recovery,
        }),
        { mode: 0o600 },
      );
    await writeFile(
      replyFile,
      JSON.stringify({
        ...next,
        ...("recovery" in next ? { recovery: undefined } : {}),
      }),
      { mode: 0o600 },
    );
  }
} catch (error) {
  await writeFile(
    `${replyFile}.failure`,
    JSON.stringify({
      message: error instanceof Error ? error.message : "Error",
      stack: error instanceof Error ? error.stack : undefined,
    }),
    { mode: 0o600 },
  );
  process.exitCode = 1;
} finally {
  await close?.();
}

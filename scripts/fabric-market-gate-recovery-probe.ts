import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CommercialExecutionProposalInputSchema,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import { FabricProposalCheckpointSchema } from "@kuintessence/shared/federation/ledger";
import {
  FabricMarketTrustSchema,
  MarketAdapterProposalInputSchema,
  MarketExecutionGateSchema,
} from "@kuintessence/shared/federation/market";
import { z } from "zod";
import { startCommercialAdapter } from "../packages/fabric-adapter/src/commercial-runtime";
import { startMarketAdapter } from "../packages/fabric-adapter/src/market-runtime";
import { UnixCommercialClient } from "../packages/server/src/federation/commercial-client";
import { UnixMarketClient } from "../packages/server/src/federation/market-client";
import { Site } from "./fabric-evidence-fixture";

const root = z.string().parse(process.argv[2]);
const operation = z.enum(["release", "reserve", "activate"]).parse(process.argv[3]);
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
const isMarket = operation === "activate";
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
    const checkpoint = isMarket
      ? await market.prepare(fixture.activate)
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
        if (result.operation === "get-demand" && result.demand?.status === "ACTIVE") {
          assert.deepEqual(result.demand.activation, fixture.activate.activation);
          break;
        }
      } else {
        const gate =
          operation === "release" ? fixture.releasedGate : fixture.activate.activation.gate;
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

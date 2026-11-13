import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FabricProposalCheckpointSchema } from "@kuintessence/shared/federation/ledger";
import {
  FabricMarketTrustSchema,
  MarketProposalInputSchema,
} from "@kuintessence/shared/federation/market";
import { z } from "zod";
import { startMarketAdapter } from "../packages/fabric-adapter/src/market-runtime";
import { UnixMarketClient } from "../packages/server/src/federation/market-client";
import { Site } from "./fabric-evidence-fixture";

const root = z.string().parse(process.argv[2]);
const action = z.enum(["prepare", "advance", "advance-then-crash", "query"]).parse(process.argv[3]);
const checkpointFile = z.string().parse(process.argv[4]);
const replyFile = z.string().parse(process.argv[5]);
const network = z
  .object({
    channel: z.literal("kq-evidence-test"),
    chaincode: z.literal("kq-market"),
    trust: FabricMarketTrustSchema,
    sites: z.array(Site),
  })
  .parse(JSON.parse(await readFile(join(root, "network.json"), "utf8")));
const site = Site.parse(network.sites.find((site) => site.name === "A"));
const runDirectory = join(root, "market-adapter");
await mkdir(runDirectory, { recursive: true, mode: 0o700 });
const keys = await readdir(join(site.userMsp, "keystore"));
assert(keys.length === 1 && keys[0]);
const configFile = join(root, "market-adapter.json");
await writeFile(
  configFile,
  JSON.stringify({
    adapter: {
      siteId: site.siteId,
      channel: network.channel,
      chaincode: network.chaincode,
      trust: network.trust,
    },
    peerEndpoint: `127.0.0.1:${site.peerPort}`,
    peerTlsCaFile: join(site.tls, "ca.crt"),
    tlsCertificateFile: join(site.tls, "server.crt"),
    tlsPrivateKeyFile: join(site.tls, "server.key"),
    identityCertificateFile: join(site.userMsp, "signcerts", "User1@a.kq.test-cert.pem"),
    identityPrivateKeyFile: join(site.userMsp, "keystore", keys[0]),
    recoveryKeyFile: join(root, "market-recovery.key"),
    runDirectory,
  }),
  { mode: 0o600 },
);
let close: (() => Promise<void>) | undefined;
try {
  close = await startMarketAdapter(configFile);
  const client = new UnixMarketClient(join(runDirectory, "market.sock"));
  if (action === "prepare") {
    const input = MarketProposalInputSchema.parse(
      JSON.parse(await readFile(join(root, "market-proposal.json"), "utf8")),
    );
    const checkpoint = await client.prepare(input);
    await writeFile(checkpointFile, JSON.stringify(checkpoint), { mode: 0o600 });
    await writeFile(
      replyFile,
      JSON.stringify({ state: "proposal", transactionId: checkpoint.transactionId }),
      { mode: 0o600 },
    );
  } else if (action === "query") {
    const seen = new Set<string>();
    let bookmark = "";
    for (let page = 0; ; page++) {
      assert(page < 10, "Bounded directory traversal");
      const result = await client.query({ operation: "list-demands", limit: 1, bookmark });
      assert.equal(result.operation, "list-demands");
      if (result.operation !== "list-demands") throw new Error("Wrong query response");
      assert(result.demands.length <= 1);
      for (const row of result.demands) {
        assert(!seen.has(row.demand.demandId), "No duplicate demand across pages");
        seen.add(row.demand.demandId);
        const detail = await client.query({
          operation: "get-demand",
          demandId: row.demand.demandId,
        });
        assert.equal(detail.operation, "get-demand");
        if (detail.operation !== "get-demand") throw new Error("Wrong detail response");
        assert.deepEqual(detail.demand, row);
      }
      bookmark = result.bookmark;
      if (!bookmark) break;
    }
    assert(seen.size >= 2, "Directory includes original and recovered publications");
    assert.deepEqual(await client.query({ operation: "get-demand", demandId: randomUUID() }), {
      operation: "get-demand",
      demand: null,
    });
    const checkpoint = FabricProposalCheckpointSchema.parse(
      JSON.parse(await readFile(checkpointFile, "utf8")),
    );
    await writeFile(
      replyFile,
      JSON.stringify({ state: "queried", transactionId: checkpoint.transactionId }),
      { mode: 0o600 },
    );
  } else {
    const prior = FabricProposalCheckpointSchema.parse(
      JSON.parse(await readFile(checkpointFile, "utf8")),
    );
    let next = await client.advance(prior.recovery);
    assert.equal(next.transactionId, prior.transactionId);
    if (action === "advance-then-crash") {
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
        JSON.stringify({ transactionId: next.transactionId, recovery: next.recovery }),
        {
          mode: 0o600,
        },
      );
    const summary = { ...next, ...("recovery" in next ? { recovery: undefined } : {}) };
    await writeFile(replyFile, JSON.stringify(summary), { mode: 0o600 });
  }
} catch (error) {
  process.stderr.write(
    `Market recovery probe failed: ${error instanceof Error ? error.name : "Error"}\n`,
  );
  process.exitCode = 1;
} finally {
  await close?.();
}

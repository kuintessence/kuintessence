import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CommercialAdapterProposalInputSchema,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import { FabricProposalCheckpointSchema } from "@kuintessence/shared/federation/ledger";
import { z } from "zod";
import { startCommercialAdapter } from "../packages/fabric-adapter/src/commercial-runtime";
import { UnixCommercialClient } from "../packages/server/src/federation/commercial-client";
import { Site } from "./fabric-evidence-fixture";

const root = z.string().parse(process.argv[2]);
const action = z.enum(["prepare", "advance", "advance-then-crash"]).parse(process.argv[3]);
const checkpointFile = z.string().parse(process.argv[4]);
const replyFile = z.string().parse(process.argv[5]);
const record = z
  .enum(["agreement", "payment", "dispute-freeze"])
  .default("agreement")
  .parse(process.argv[6]);
const network = z
  .object({
    channel: z.literal("kq-evidence-test"),
    chaincode: z.literal("kq-commercial"),
    trust: FabricCommercialTrustSchema,
    sites: z.array(Site),
  })
  .parse(JSON.parse(await readFile(join(root, "network.json"), "utf8")));
const site = Site.parse(network.sites.find((site) => site.name === "A"));
const runDirectory = join(root, "commercial-adapter");
await mkdir(runDirectory, { recursive: true, mode: 0o700 });
const keys = await readdir(join(site.userMsp, "keystore"));
assert(keys.length === 1 && keys[0]);
const configFile = join(root, "commercial-adapter.json");
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
    recoveryKeyFile: join(root, "commercial-recovery.key"),
    runDirectory,
  }),
  { mode: 0o600 },
);
let close: (() => Promise<void>) | undefined;
try {
  close = await startCommercialAdapter(configFile);
  const client = new UnixCommercialClient(join(runDirectory, "commercial.sock"));
  if (action === "prepare") {
    const input = CommercialAdapterProposalInputSchema.parse(
      JSON.parse(
        await readFile(
          join(
            root,
            record === "agreement"
              ? "commercial-proposal.json"
              : `commercial-${record}-proposal.json`,
          ),
          "utf8",
        ),
      ),
    );
    const checkpoint = await client.prepare(input);
    await writeFile(checkpointFile, JSON.stringify(checkpoint), { mode: 0o600 });
    await writeFile(
      replyFile,
      JSON.stringify({ state: "proposal", transactionId: checkpoint.transactionId }),
      { mode: 0o600 },
    );
  } else {
    const prior = FabricProposalCheckpointSchema.parse(
      JSON.parse(await readFile(checkpointFile, "utf8")),
    );
    let next = await client.advance(prior.recovery);
    assert.equal(next.transactionId, prior.transactionId);
    if (action === "advance-then-crash") {
      // A listening Orderer may still be electing its leader; keep the original checkpoint.
      for (let attempt = 0; attempt < 2 && next.state === "pending"; attempt++) {
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
    `Commercial recovery probe failed: ${error instanceof Error ? error.name : "Error"}\n`,
  );
  process.exitCode = 1;
} finally {
  await close?.();
}

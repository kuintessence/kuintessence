import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FabricCommercialTrustSchema } from "@kuintessence/shared/federation/commercial";
import { FabricMarketTrustSchema } from "@kuintessence/shared/federation/market";
import { z } from "zod";
import { Site } from "../fabric-evidence-fixture";

export async function startAdapters(root: string) {
  const network = z
    .object({ channel: z.string(), sites: z.array(Site), trust: FabricCommercialTrustSchema })
    .parse(await Bun.file(join(root, "network.json")).json());
  const marketTrust = FabricMarketTrustSchema.parse(
    await Bun.file(join(root, "gate-market-trust.json")).json(),
  );
  const build = await Bun.build({
    entrypoints: ["packages/fabric-adapter/src/main.ts"],
    target: "node",
    format: "esm",
    external: ["@hyperledger/fabric-gateway", "@hyperledger/fabric-protos", "@grpc/grpc-js"],
  });
  assert(build.success && build.outputs[0]);
  const entry = join(root, "live-adapter.mjs");
  await writeFile(entry, await build.outputs[0].text(), { mode: 0o600 });
  await writeFile(join(root, "live-recovery.key"), randomBytes(32), { mode: 0o600 });
  const children: Bun.Subprocess[] = [];
  const restarts: (() => Promise<{
    site: string;
    oldPid: number;
    newPid: number;
    exitCode: number;
  }>)[] = [];
  const cleanup = async () => {
    for (const child of children) {
      if (child.exitCode !== null) continue;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await child.exited;
      } finally {
        clearTimeout(timer);
      }
    }
  };
  try {
    for (const site of network.sites.filter((s) => ["A", "B"].includes(s.name))) {
      for (const kind of ["commercial", "market"]) {
        const user = kind === "market" ? "User2" : "User1";
        const msp = join(
          dirname(dirname(site.userMsp)),
          `${user}@${site.name.toLowerCase()}.kq.test`,
          "msp",
        );
        const keys = await readdir(join(msp, "keystore"));
        assert.equal(keys.length, 1);
        assert(keys[0]);
        const runDirectory = join(root, `live-${site.name}-${kind}`);
        await mkdir(runDirectory, { mode: 0o700 });
        const path = join(root, `live-${site.name}-${kind}.json`);
        await writeFile(
          path,
          JSON.stringify({
            adapter: {
              siteId: site.siteId,
              channel: network.channel,
              chaincode: `kq-${kind}`,
              trust: kind === "market" ? marketTrust : network.trust,
            },
            peerEndpoint: `127.0.0.1:${site.peerPort}`,
            peerTlsCaFile: join(site.tls, "ca.crt"),
            tlsCertificateFile: join(site.tls, "server.crt"),
            tlsPrivateKeyFile: join(site.tls, "server.key"),
            identityCertificateFile: join(
              msp,
              "signcerts",
              `${user}@${site.name.toLowerCase()}.kq.test-cert.pem`,
            ),
            identityPrivateKeyFile: join(msp, "keystore", keys[0]),
            recoveryKeyFile: join(root, "live-recovery.key"),
            runDirectory,
          }),
          { mode: 0o600 },
        );
        const launch = async () => {
          const fd = openSync(join(root, `live-${site.name}-${kind}.log`), "a", 0o600);
          let child: Bun.Subprocess;
          try {
            child = Bun.spawn(["node", entry], {
              env: { ...process.env, KQ_FABRIC_ADAPTER_KIND: kind, KQ_FABRIC_ADAPTER_CONFIG: path },
              stdout: fd,
              stderr: fd,
            });
            children.push(child);
          } finally {
            closeSync(fd);
          }
          const deadline = Date.now() + 15000;
          for (;;) {
            assert.equal(child.exitCode, null, "Adapter exited before readiness");
            try {
              const response = await fetch("http://localhost/health", {
                unix: join(runDirectory, `${kind}.sock`),
                signal: AbortSignal.timeout(1000),
              });
              await response.body?.cancel();
              if (response.ok) break;
            } catch (error) {
              if (Date.now() >= deadline) throw error;
            }
            assert(Date.now() < deadline, "Adapter health timed out");
            await Bun.sleep(200);
          }
          return child;
        };
        let child = await launch();
        if (kind === "commercial")
          restarts.push(async () => {
            assert.equal(child.exitCode, null, "Expected live owned commercial Adapter");
            const oldPid = child.pid;
            child.kill("SIGKILL");
            const exitCode = await child.exited;
            assert.notEqual(exitCode, 0, "Adapter crash must not be a graceful exit");
            child = await launch();
            assert.notEqual(child.pid, oldPid);
            return { site: site.name, oldPid, newPid: child.pid, exitCode };
          });
      }
    }
    return {
      cleanup,
      restartCommercial: async () => {
        const results = [];
        for (const restart of restarts) results.push(await restart());
        return results;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

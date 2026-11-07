import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { verifyGateDatabase } from "./fabric-market-gate-database";

export async function verifyExecutionGateNetwork(
  root: string,
  controls: {
    stopOrderer(): Promise<void>;
    startOrderer(): Promise<void>;
    onCleanup(cleanup: () => Promise<void>): void;
  },
) {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fabric-market-gate-probe.ts")],
    target: "node",
    format: "esm",
    external: ["@hyperledger/fabric-gateway", "@hyperledger/fabric-protos", "@grpc/grpc-js"],
  });
  assert(build.success && build.outputs[0], "Build execution gate network probe");
  const entry = join(root, "gate-probe.mjs"),
    result = join(root, "gate-result.json");
  await writeFile(entry, await build.outputs[0].text(), { mode: 0o600 });
  const child = Bun.spawn(["node", entry, join(root, "network.json"), result], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 240000);
  try {
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timer);
    await writeFile(join(root, "gate-probe.log"), out + err, { mode: 0o600 });
    assert.equal(code, 0, "Execution gate probe failed; inspect private artifacts");
    const report = z
      .object({ passed: z.array(z.string()), probes: z.array(z.string()) })
      .parse(JSON.parse(await readFile(result, "utf8")));
    if (process.argv.includes("--database")) {
      await verifyGateDatabase(
        root,
        z.string().parse(process.env.KQ_FABRIC_DATABASE_URL),
        controls,
        (message) => report.passed.push(message),
      );
      await verifyAdapterRecovery(root, controls, ["authorize", "stop"]);
      report.passed.push(
        "production execution confirmation and stop request recover their original VALID transactions after Orderer outage and process exit",
      );
    } else {
      await verifyAdapterRecovery(root, controls);
      report.passed.push(
        "production commercial and market runtimes recover release/reserve/activate/authorize/stop across process loss; reserve, authorize and stop survive Orderer outage with the original transaction",
        "Server Unix clients read the released and ready gate hashes, confirmed absence, ACTIVE and STOPPING states",
      );
    }
    for (const file of await readdir(root)) {
      if (!/^(peer-|chaincode-|gate-chaincode-|gate-db-|orderer).*\.log$/.test(file)) continue;
      const log = await readFile(join(root, file));
      for (const probe of report.probes)
        assert(
          !log.includes(Buffer.from(probe)),
          "Fabric service log leaked private execution data",
        );
    }
    for (const item of report.passed) console.log(`PASS ${item}`);
    if (process.env.KQ_FABRIC_REPORT)
      await writeFile(
        process.env.KQ_FABRIC_REPORT,
        JSON.stringify({ passed: report.passed }, null, 2),
        { mode: 0o600 },
      );
  } finally {
    clearTimeout(timer);
  }
}

async function verifyAdapterRecovery(
  root: string,
  controls: { stopOrderer(): Promise<void>; startOrderer(): Promise<void> },
  operations = ["release", "reserve", "activate", "authorize", "stop"],
) {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fabric-market-gate-recovery-probe.ts")],
    target: "node",
    format: "esm",
    external: ["@hyperledger/fabric-gateway", "@hyperledger/fabric-protos", "@grpc/grpc-js"],
  });
  assert(build.success && build.outputs[0], "Build gate recovery probe");
  const entry = join(root, "gate-recovery-probe.mjs");
  await writeFile(entry, await build.outputs[0].text(), { mode: 0o600 });
  await writeFile(join(root, "gate-recovery.key"), randomBytes(32), { mode: 0o600 });
  let ordinal = 0;
  const probe = async (operation: string, action: string) => {
    const name = `gate-recovery-${++ordinal}`;
    const reply = join(root, `${name}.json`);
    const child = Bun.spawn(["node", entry, root, operation, action, reply], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const limit = setTimeout(() => child.kill("SIGKILL"), 60000);
    try {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await writeFile(join(root, `${name}.log`), out + err, { mode: 0o600 });
      assert.equal(code, action === "crash" ? 86 : 0, `Gate adapter ${operation}/${action}`);
      return action === "crash"
        ? null
        : z
            .object({
              state: z.string(),
              transactionId: z.string().optional(),
              blockNumber: z.string().optional(),
            })
            .parse(JSON.parse(await readFile(reply, "utf8")));
    } finally {
      clearTimeout(limit);
    }
  };
  for (const operation of operations) {
    const proposal = await probe(operation, "prepare");
    const prepared = await probe(operation, "advance");
    assert.equal(proposal?.state, "proposal");
    assert.equal(prepared?.state, "prepared");
    assert.equal(prepared?.transactionId, proposal?.transactionId);
    if (operation === "reserve" || operation === "authorize" || operation === "stop") {
      await controls.stopOrderer();
      try {
        const pending = await probe(operation, "advance");
        assert.equal(pending?.state, "pending");
        assert.equal(pending?.transactionId, proposal?.transactionId);
      } finally {
        await controls.startOrderer();
      }
    }
    await probe(operation, "crash");
    const resumed = await probe(operation, "advance");
    assert.equal(resumed?.state, "committed");
    assert.equal(resumed?.transactionId, proposal?.transactionId);
    assert.deepEqual(await probe(operation, "advance"), resumed);
    assert.equal((await probe(operation, "query"))?.state, "queried");
  }
}

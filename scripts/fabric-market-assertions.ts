import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
export async function verifyMarketNetwork(
  root: string,
  controls: { stopOrderer(): Promise<void>; startOrderer(): Promise<void> },
) {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fabric-market-probe.ts")],
    target: "node",
    format: "esm",
    external: ["@hyperledger/fabric-gateway", "@hyperledger/fabric-protos", "@grpc/grpc-js"],
  });
  assert(build.success && build.outputs[0], "Build market network probe");
  const entry = join(root, "market-probe.mjs"),
    result = join(root, "market-result.json");
  await writeFile(entry, await build.outputs[0].text(), { mode: 0o600 });
  const child = Bun.spawn(["node", entry, join(root, "network.json"), result], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
  try {
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await writeFile(join(root, "market-probe.log"), out + err, { mode: 0o600 });
    assert.equal(code, 0, "Market network probe failed; inspect private artifacts");
    const report = z
      .object({ passed: z.array(z.string()) })
      .parse(JSON.parse(await readFile(result, "utf8")));
    const recoveryBuild = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "fabric-market-recovery-probe.ts")],
      target: "node",
      format: "esm",
      external: ["@hyperledger/fabric-gateway", "@hyperledger/fabric-protos", "@grpc/grpc-js"],
    });
    assert(recoveryBuild.success && recoveryBuild.outputs[0]);
    const recoveryEntry = join(root, "market-recovery-probe.mjs");
    await writeFile(recoveryEntry, await recoveryBuild.outputs[0].text(), { mode: 0o600 });
    await writeFile(join(root, "market-recovery.key"), randomBytes(32), { mode: 0o600 });
    const checkpoint = join(root, "market-checkpoint.json");
    let ordinal = 0;
    const probe = async (action: string) => {
      const name = `market-recovery-${++ordinal}`,
        reply = join(root, `${name}.json`);
      const child = Bun.spawn(["node", recoveryEntry, root, action, checkpoint, reply], {
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
        assert.equal(code, action === "advance-then-crash" ? 86 : 0, `Market recovery ${action}`);
        return action === "advance-then-crash"
          ? null
          : z
              .object({
                state: z.string(),
                transactionId: z.string(),
                blockNumber: z.string().optional(),
              })
              .parse(JSON.parse(await readFile(reply, "utf8")));
      } finally {
        clearTimeout(limit);
      }
    };
    const proposal = await probe("prepare"),
      prepared = await probe("advance");
    assert.equal(proposal?.state, "proposal");
    assert.equal(prepared?.state, "prepared");
    assert.equal(proposal?.transactionId, prepared?.transactionId);
    await controls.stopOrderer();
    const pending = await probe("advance");
    assert.equal(pending?.state, "pending");
    assert.equal(pending?.transactionId, proposal?.transactionId);
    await controls.startOrderer();
    await probe("advance-then-crash");
    const resumed = await probe("advance");
    assert.equal(resumed?.state, "committed");
    assert.equal(resumed?.transactionId, proposal?.transactionId);
    const repeated = await probe("advance");
    assert.deepEqual(repeated, resumed);
    report.passed.push(
      "production Node market adapter and Server Unix client resume one transaction across outage, new processes and lost committed response",
    );
    for (const item of report.passed) console.log(`PASS ${item}`);
    if (process.env.KQ_FABRIC_REPORT)
      await writeFile(process.env.KQ_FABRIC_REPORT, JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
  } finally {
    clearTimeout(timer);
  }
}

import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

export async function verifyExecutionGateNetwork(root: string) {
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
    await writeFile(join(root, "gate-probe.log"), out + err, { mode: 0o600 });
    assert.equal(code, 0, "Execution gate probe failed; inspect private artifacts");
    const report = z
      .object({ passed: z.array(z.string()), probes: z.array(z.string()) })
      .parse(JSON.parse(await readFile(result, "utf8")));
    for (const file of await readdir(root)) {
      if (!/^(peer-|chaincode-|gate-chaincode-|orderer).*\.log$/.test(file)) continue;
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

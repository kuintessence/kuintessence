import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
export async function verifyMarketNetwork(root: string) {
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
    for (const item of report.passed) console.log(`PASS ${item}`);
    if (process.env.KQ_FABRIC_REPORT)
      await writeFile(process.env.KQ_FABRIC_REPORT, JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
  } finally {
    clearTimeout(timer);
  }
}

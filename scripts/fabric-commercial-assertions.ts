import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

export async function verifyCommercialNetwork(root: string) {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fabric-commercial-probe.ts")],
    target: "node",
    format: "esm",
    external: ["@hyperledger/fabric-gateway", "@hyperledger/fabric-protos", "@grpc/grpc-js"],
  });
  assert(build.success && build.outputs[0], "Build commercial network probe");
  const entry = join(root, "commercial-probe.mjs");
  await writeFile(entry, await build.outputs[0].text(), { mode: 0o600 });
  const child = Bun.spawn(
    ["node", entry, join(root, "network.json"), join(root, "commercial-result.json")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await writeFile(join(root, "commercial-probe.log"), stdout + stderr, { mode: 0o600 });
    assert.equal(code, 0, "Commercial network probe failed; inspect private artifacts");
    const result = z
      .object({ passed: z.array(z.string()), probes: z.array(z.string()) })
      .parse(JSON.parse(await readFile(join(root, "commercial-result.json"), "utf8")));
    for (const filename of await readdir(root))
      if (filename.endsWith(".log")) {
        const bytes = await readFile(join(root, filename));
        for (const marker of result.probes)
          assert(
            !bytes.includes(Buffer.from(marker)),
            `Private commercial content leaked into ${filename}`,
          );
      }
    if (process.env.KQ_FABRIC_REPORT)
      await writeFile(
        process.env.KQ_FABRIC_REPORT,
        JSON.stringify(
          {
            fabricVersion: "3.1.5",
            chaincode: "kq-commercial",
            checks: [...result.passed, "Owned process logs contain no commercial probes"],
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    for (const name of result.passed) console.log(`PASS ${name}`);
    console.log(
      "PASS owned process logs contain no private contract, price, usage or signature probes",
    );
  } finally {
    clearTimeout(timer);
  }
}

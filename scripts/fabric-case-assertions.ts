import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

export async function verifyCaseNetwork(
  root: string,
  controls: {
    stopOrderer(): Promise<void>;
    startOrderer(): Promise<void>;
  },
) {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fabric-case-probe.ts")],
    target: "node",
    format: "esm",
    external: ["@hyperledger/fabric-gateway", "@hyperledger/fabric-protos", "@grpc/grpc-js"],
  });
  assert(build.success && build.outputs[0]);
  const entry = join(root, "case-probe.mjs");
  await writeFile(entry, await build.outputs[0].text(), { mode: 0o600 });
  let index = 0;
  async function probe(action: string) {
    const name = `case-${++index}-${action}`,
      reply = join(root, `${name}.json`);
    const child = Bun.spawn(["node", entry, root, action, reply], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), action === "inspect" ? 180000 : 120000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await writeFile(join(root, `${name}.log`), stdout + stderr, { mode: 0o600 });
      if (action === "crash") {
        assert.equal(child.signalCode, "SIGKILL", `Expected intentional crash: ${name}`);
        assert(!stderr.includes("failed:"), "Crash probe must reach committed state");
        return null;
      }
      assert.equal(code, 0, `Case network probe failed: ${name}; inspect private artifacts`);
      return z
        .object({
          state: z.string().optional(),
          transactionId: z.string().optional(),
          blockNumber: z.string().optional(),
        })
        .parse(JSON.parse(await readFile(reply, "utf8")));
    } finally {
      clearTimeout(timer);
    }
  }
  await probe("verify");
  console.log(
    "PASS case publication, arbitration commitment, native endorsement and concurrent revocation checks",
  );
  const proposal = await probe("prepare");
  assert.equal(proposal?.state, "proposal");
  const prepared = await probe("advance");
  assert.equal(prepared?.state, "prepared");
  assert.equal(prepared?.transactionId, proposal?.transactionId);
  const checkpoint = join(root, "case-checkpoint.json"),
    bytes = await readFile(checkpoint);
  await controls.stopOrderer();
  try {
    const waiting = await probe("advance");
    assert.equal(waiting?.state, "pending");
    assert.equal(waiting?.transactionId, proposal?.transactionId);
    assert(
      bytes.equals(await readFile(checkpoint)),
      "Orderer outage must preserve original checkpoint",
    );
  } finally {
    await controls.startOrderer();
  }
  await probe("crash");
  assert.deepEqual(JSON.parse(await readFile(join(root, "case-crash-committed.json"), "utf8")), {
    transactionId: proposal?.transactionId,
    state: "committed",
  });
  assert(
    bytes.equals(await readFile(checkpoint)),
    "SIGKILL after commit must leave pre-submit checkpoint unchanged",
  );
  const recovered = await probe("advance");
  assert.equal(recovered?.state, "committed");
  assert.equal(recovered?.transactionId, proposal?.transactionId);
  assert.deepEqual(await probe("advance"), recovered);
  await writeFile(join(root, "case-recovered.json"), JSON.stringify(recovered), { mode: 0o600 });
  await probe("inspect");
  const result = z
    .object({ passed: z.string().array(), probes: z.string().array() })
    .parse(JSON.parse(await readFile(join(root, "case-results.json"), "utf8")));
  result.passed.push(
    "production case Unix Adapter recovers one VALID transaction through Orderer outage and post-commit SIGKILL",
  );
  for (const name of await readdir(root))
    if (name.endsWith(".log")) {
      const log = await readFile(join(root, name));
      for (const marker of result.probes)
        assert(!log.includes(Buffer.from(marker)), `Private case material leaked in ${name}`);
    }
  result.passed.push(
    "owned process logs contain no private contract, price or original signatures",
  );
  if (process.env.KQ_FABRIC_REPORT)
    await writeFile(
      process.env.KQ_FABRIC_REPORT,
      JSON.stringify(
        {
          fabricVersion: "3.1.5",
          chaincodes: ["kq-commercial", "kq-cases"],
          checks: result.passed,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  for (const check of result.passed) console.log(`PASS ${check}`);
}

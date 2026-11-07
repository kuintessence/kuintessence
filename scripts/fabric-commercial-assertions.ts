import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { verifyCommercialDatabase } from "./fabric-commercial-database";

export async function verifyCommercialNetwork(
  root: string,
  controls: {
    stopOrderer(): Promise<void>;
    startOrderer(): Promise<void>;
    onCleanup(cleanup: () => Promise<void>): void;
  },
) {
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
    const recoveryBuild = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "fabric-commercial-recovery-probe.ts")],
      target: "node",
      format: "esm",
      external: ["@hyperledger/fabric-gateway", "@hyperledger/fabric-protos", "@grpc/grpc-js"],
    });
    assert(recoveryBuild.success && recoveryBuild.outputs[0]);
    const recoveryEntry = join(root, "commercial-recovery-probe.mjs");
    await writeFile(recoveryEntry, await recoveryBuild.outputs[0].text(), { mode: 0o600 });
    await writeFile(join(root, "commercial-recovery.key"), randomBytes(32), { mode: 0o600 });
    let index = 0;
    async function probe(action: string, checkpointFile: string) {
      const name = `commercial-recovery-${++index}`,
        reply = join(root, `${name}.json`);
      const process = Bun.spawn(["node", recoveryEntry, root, action, checkpointFile, reply], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const deadline = setTimeout(() => process.kill("SIGKILL"), 35000);
      try {
        const [code, output, error] = await Promise.all([
          process.exited,
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
        ]);
        await writeFile(join(root, `${name}.log`), output + error, { mode: 0o600 });
        assert.equal(
          code,
          action === "advance-then-crash" ? 86 : 0,
          `Recovery probe failed: ${name}`,
        );
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
        clearTimeout(deadline);
      }
    }
    const checkpoint = join(root, "commercial-checkpoint.json");
    const proposal = await probe("prepare", checkpoint);
    assert(proposal?.state === "proposal");
    const prepared = await probe("advance", checkpoint);
    assert(prepared?.state === "prepared");
    assert.equal(prepared.transactionId, proposal.transactionId);
    const persisted = await readFile(checkpoint);
    await probe("advance-then-crash", checkpoint);
    assert(
      persisted.equals(await readFile(checkpoint)),
      "Crash must leave the pre-submit checkpoint unchanged",
    );
    const recovered = await probe("advance", checkpoint);
    assert(recovered?.state === "committed");
    assert.equal(recovered.transactionId, proposal.transactionId);
    assert.deepEqual(await probe("advance", checkpoint), recovered);
    result.passed.push(
      "production Unix client and fresh Node adapters recover original VALID transaction after commit-before-checkpoint process exit",
    );
    const offline = join(root, "commercial-offline-checkpoint.json");
    const pendingProposal = await probe("prepare", offline);
    assert(pendingProposal?.state === "proposal");
    assert.equal((await probe("advance", offline))?.state, "prepared");
    const original = await readFile(offline);
    await controls.stopOrderer();
    const pending = await probe("advance", offline);
    assert.equal(pending?.state, "pending");
    assert.equal(pending?.transactionId, pendingProposal.transactionId);
    assert(
      original.equals(await readFile(offline)),
      "Unknown submit must preserve original checkpoint",
    );
    await controls.startOrderer();
    let final = await probe("advance", offline);
    for (let attempt = 0; attempt < 2 && final?.state === "pending"; attempt++)
      final = await probe("advance", offline);
    assert.equal(final?.state, "committed");
    assert.equal(final?.transactionId, pendingProposal.transactionId);
    result.passed.push(
      "orderer outage retains the same encrypted checkpoint and transaction ID until VALID after restart",
    );
    if (process.argv.includes("--database")) {
      assert(process.env.KQ_FABRIC_DATABASE_URL);
      await verifyCommercialDatabase(root, process.env.KQ_FABRIC_DATABASE_URL, controls, (name) =>
        result.passed.push(name),
      );
    }
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

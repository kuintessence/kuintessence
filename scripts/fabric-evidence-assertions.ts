import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { verifyDatabaseAttestation } from "./fabric-evidence-database";

interface NetworkControls {
  onCleanup(cleanup: () => Promise<void>): void;
  stopOrderer(): Promise<void>;
  startOrderer(): Promise<void>;
}

const Reply = z.object({
  ready: z.boolean().optional(),
  state: z.string().optional(),
  transactionId: z.string().optional(),
  blockNumber: z.string().optional(),
  successful: z.boolean().optional(),
  validationCode: z.number().optional(),
  rejected: z.boolean().optional(),
  reason: z.string().optional(),
  privateWrites: z.number().optional(),
  privateContainsEnvelope: z.boolean().optional(),
  publicContainsEnvelope: z.boolean().optional(),
});

/** Each probe is a new Node process: only persisted signed checkpoints survive. */
export async function verifyEvidenceNetwork(root: string, controls: NetworkControls) {
  const executable = join(root, "probe.mjs");
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fabric-evidence-probe.ts")],
    target: "node",
    format: "esm",
    external: ["@hyperledger/fabric-gateway", "@hyperledger/fabric-protos", "@grpc/grpc-js"],
  });
  assert(build.success && build.outputs[0], "Build real Gateway probe");
  await writeFile(executable, await build.outputs[0].text(), { mode: 0o600 });
  await writeFile(join(root, "recovery.key"), randomBytes(32), { mode: 0o600 });
  const passed: string[] = [];
  let ordinal = 0;
  async function probe(input: Record<string, unknown>) {
    const name = `probe-${++ordinal}`;
    const request = join(root, `${name}-request.json`);
    const response = join(root, `${name}-response.json`);
    await writeFile(request, JSON.stringify(input), { mode: 0o600 });
    const child = Bun.spawn(["node", executable, join(root, "network.json"), request, response], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 35_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await writeFile(join(root, `${name}.log`), stdout + stderr, { mode: 0o600 });
      assert.equal(code, 0, `Probe failed: inspect ${name}.log in private artifacts`);
      return Reply.parse(JSON.parse(await readFile(response, "utf8")));
    } finally {
      clearTimeout(timeout);
    }
  }
  const pass = (name: string) => {
    passed.push(name);
    console.log(`PASS ${name}`);
  };
  async function batch(name: string, sequence: number) {
    const batchFile = join(root, `${name}-batch.json`);
    await probe({ action: "createBatch", sequence: String(sequence), batchFile });
    return batchFile;
  }
  async function prepare(name: string, batchFile: string) {
    const checkpointFile = join(root, `${name}-checkpoint.json`);
    const proposal = await probe({ action: "prepare", batchFile, checkpointFile });
    assert.equal(proposal.state, "proposal");
    assert(proposal.transactionId);
    const endorsed = await probe({ action: "advance", checkpointFile });
    assert.equal(endorsed.state, "prepared");
    assert.equal(endorsed.transactionId, proposal.transactionId);
    return { checkpointFile, transactionId: proposal.transactionId };
  }
  const advance = (value: { checkpointFile: string }) =>
    probe({ action: "advance", checkpointFile: value.checkpointFile });
  const readinessDeadline = Date.now() + 45_000;
  for (;;) {
    if ((await probe({ action: "ready" })).ready) break;
    assert(Date.now() < readinessDeadline, "Both organizations must be discovered and ready");
    await Bun.sleep(1_000);
  }
  const first = await batch("first", 1);
  const missing = await probe({ action: "missingEndorsement", batchFile: first });
  assert.equal(missing.successful, false);
  assert.equal(missing.validationCode, 10);
  pass("native commit rejects a transaction missing B's endorsement");

  const prepared = await prepare("first", first);
  const committed = await advance(prepared);
  assert.equal(committed.state, "anchored");
  assert.equal(committed.transactionId, prepared.transactionId);
  assert(committed.blockNumber);
  const recovered = await advance(prepared);
  assert.deepEqual(recovered, committed);
  pass("fresh processes recover the exact transaction and VALID receipt");

  for (const [identity, endpoint, expected] of [
    ["A", "A", true],
    ["B", "B", true],
    ["C", "A", false],
    ["A", "C", false],
    ["C", "C", false],
  ] as const) {
    const privacy = await probe({
      action: "privateBlock",
      identity,
      endpoint,
      blockNumber: committed.blockNumber,
      batchFile: first,
    });
    assert.equal(privacy.privateContainsEnvelope, expected);
    assert.equal(privacy.publicContainsEnvelope, false);
    assert.equal(privacy.privateWrites, expected ? 3 : 0);
    pass(
      `native block delivery: identity ${identity}, peer ${endpoint}, private data ${expected ? "present" : "absent"}`,
    );
  }

  const replay = await prepare("replay", first);
  assert.notEqual(replay.transactionId, prepared.transactionId);
  assert.equal((await advance(replay)).state, "anchored");
  const missingReplay = await probe({ action: "missingEndorsement", batchFile: first });
  assert.equal(missingReplay.validationCode, 10);
  pass("idempotent batch replay still requires both native endorsements");

  // Both read the same cursor before either transaction is submitted.
  const left = await prepare("left", await batch("left", 2));
  const rightBatch = await batch("right", 2);
  const right = await prepare("right", rightBatch);
  assert.equal((await advance(left)).state, "anchored");
  const conflict = await advance(right);
  assert.equal(conflict.state, "invalid");
  assert.equal(conflict.validationCode, 11);
  assert.equal(conflict.transactionId, right.transactionId);
  const retryFile = join(root, "conflict-retry.json");
  await probe({ action: "prepare", batchFile: rightBatch, checkpointFile: retryFile });
  assert.deepEqual(await advance({ checkpointFile: retryFile }), {
    rejected: true,
    reason: "OPERATION_CONFLICT",
  });
  pass("native MVCC rejects a competing cursor update; stale sequence cannot be re-endorsed");

  const outage = await prepare("outage", await batch("outage", 3));
  await controls.stopOrderer();
  try {
    const pending = await advance(outage);
    assert.equal(pending.state, "pending");
    assert.equal(pending.transactionId, outage.transactionId);
  } finally {
    await controls.startOrderer();
  }
  let resumed = await advance(outage);
  const deadline = Date.now() + 45_000;
  while (resumed.state === "pending" && Date.now() < deadline) {
    assert.equal(resumed.transactionId, outage.transactionId);
    await Bun.sleep(1_000);
    resumed = await advance(outage);
  }
  assert.equal(resumed.state, "anchored");
  assert.equal(resumed.transactionId, outage.transactionId);
  pass("real orderer outage remains pending; restart recovers the original transaction");

  if (process.env.KQ_FABRIC_DATABASE_URL)
    await verifyDatabaseAttestation(root, process.env.KQ_FABRIC_DATABASE_URL, controls, pass);

  for (const [identity, administrator, reason] of [
    ["A", false, "UNTRUSTED_IDENTITY"],
    ["C", true, "POLICY_DENIED"],
  ] as const) {
    const denied = await probe({ action: "revoke", identity, target: "A", administrator });
    assert.deepEqual(denied, { rejected: true, reason });
  }
  pass("ordinary clients and other organizations cannot revoke A's signing key");
  const revocationBatch = await batch("revocation", 4);
  const stale = await prepare("revocation", revocationBatch);
  const revoked = await probe({
    action: "revoke",
    identity: "A",
    target: "A",
    administrator: true,
  });
  assert.equal(revoked.successful, true);
  assert.equal(revoked.validationCode, 0);
  const rejected = await advance(stale);
  assert.equal(rejected.state, "invalid");
  assert.equal(rejected.validationCode, 11);
  const afterRevocation = join(root, "revoked-key.json");
  await probe({ action: "prepare", batchFile: revocationBatch, checkpointFile: afterRevocation });
  assert.deepEqual(await advance({ checkpointFile: afterRevocation }), {
    rejected: true,
    reason: "UNTRUSTED_IDENTITY",
  });
  pass(
    "own-MSP revocation invalidates an already endorsed transaction and prevents new endorsement",
  );

  const report = { fabricVersion: "3.1.5", completedAt: new Date().toISOString(), passed };
  const reportPath = process.env.KQ_FABRIC_REPORT;
  if (reportPath)
    await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`Fabric evidence network: ${passed.length} checks passed`);
}

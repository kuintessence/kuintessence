import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ExecutionFixtureSchema } from "./fixture";

assert.equal(
  process.env.KQ_FEDERATION_EXECUTION_LAB,
  "1",
  "Explicit disposable local k3s opt-in required",
);
const repo = resolve(import.meta.dir, "../..");
await mkdir(join(repo, "temp"), { recursive: true });
const root = await mkdtemp(join(repo, "temp", "federation-direct-"));
await chmod(root, 0o700);
let child: Bun.Subprocess | undefined;
let stopping: Promise<void> | undefined;
const stop = () =>
  (stopping ??= (async () => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 120000);
    try {
      await child.exited;
    } finally {
      clearTimeout(timer);
    }
  })());
let cancelled = false;
const interrupted = () => {
  cancelled = true;
  void stop();
};
process.on("SIGINT", interrupted);
process.on("SIGTERM", interrupted);
try {
  const sites = [];
  for (const name of ["A", "B"] as const) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const path = join(root, `${name}-business.pem`);
    await writeFile(path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    sites.push({ name, siteId: randomUUID(), businessKeyFile: path });
  }
  await writeFile(
    join(root, "execution-fixture.json"),
    JSON.stringify(ExecutionFixtureSchema.parse({ domainId: randomUUID(), sites })),
    { mode: 0o600 },
  );
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.startsWith("KQ_FABRIC_") || name.startsWith("FEDERATION_") || name.startsWith("LAB_"))
      delete env[name];
  assert(!cancelled, "Direct lab interrupted before startup");
  child = Bun.spawn(["python3", join(import.meta.dir, "run.py")], {
    cwd: repo,
    env: { ...env, LAB_MODE: "bilateral_direct", LAB_SCENARIO: "success", LAB_FIXTURE_ROOT: root },
    stdout: "inherit",
    stderr: "inherit",
  });
  const timer = setTimeout(interrupted, 1200000);
  try {
    assert.equal(await child.exited, 0, "Real direct cooperation failed");
  } finally {
    clearTimeout(timer);
  }
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
  process.off("SIGINT", interrupted);
  process.off("SIGTERM", interrupted);
}

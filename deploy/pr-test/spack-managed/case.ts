import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  inspectSpackLock,
  SPACK_LOCK_MAX_BYTES,
  SpackMaterialBindingSchema,
  SpackMaterialManifestSchema,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import { z } from "zod";
import {
  type SpackInstallRecord,
  SpackInstallRecordSchema,
  type SpackInstallReport,
  SpackInstallReportSchema,
} from "../../../packages/agent/src/spack/install-contract";
import { SpackInstallStore } from "../../../packages/agent/src/spack/install-store";
import { SpackMaterialCache } from "../../../packages/agent/src/spack/material-cache";
import { caseDirectory, login, ReleaseSchema } from "../spack-case/api";
import { managedApi } from "./api-helper";
import { diagnoseManagedInstall } from "./diagnostic";
import { verifyManagedCacheIntegrity } from "./integrity";

const PhaseSchema = z.enum(["install", "restart", "uninstall"]);
const statePath = `${caseDirectory}/managed-result.json`;
const cacheDirectory = "/var/lib/kuintessence/spack-materials";
const store = new SpackInstallStore("/srv/kq/spack");
const StateSchema = z.strictObject({
  version: z.literal(1),
  binding: SpackMaterialBindingSchema,
  target: z.string().min(1),
  record: SpackInstallRecordSchema,
  queueId: z.string().uuid(),
});
type Release = z.infer<typeof ReleaseSchema>;
type State = z.infer<typeof StateSchema>;
type Stage =
  | "guard"
  | "release"
  | "cache"
  | "connect"
  | "install"
  | "report"
  | "store"
  | "inventory"
  | "state"
  | "import_preinstalled"
  | "load"
  | "job"
  | "integrity"
  | "uninstall";
let stage: Stage = "guard";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function emptyCache() {
  try {
    const entry = await lstat(cacheDirectory);
    assert(entry.isDirectory() && !entry.isSymbolicLink(), "Invalid initial material cache");
    assert((await readdir(cacheDirectory)).length === 0, "Initial material cache is not empty");
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function verifyReport(report: SpackInstallReport, release: Release) {
  assert(report.action === "verify", "Managed installation did not return a verify report");
  assert(
    report.manifestDigest === release.binding.manifestDigest &&
      report.root.spec === release.spec &&
      report.root.arch === release.target,
    "Managed report does not match the published release",
  );
  assert(
    report.root.name === "hello" && report.root.version === "2.12.1",
    "Managed report is not the GNU Hello acceptance release",
  );
}

async function verifyCachedMaterials(release: Release, report: SpackInstallReport) {
  const cache = new SpackMaterialCache(cacheDirectory);
  const signal = AbortSignal.timeout(120_000);
  const bytes = await cache.readMetadata(
    { digest: release.binding.manifestDigest, size: release.manifestSize },
    2 * 1024 ** 2,
    signal,
  );
  const manifest = SpackMaterialManifestSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  assert(
    manifest.spec === release.spec &&
      manifest.target === release.target &&
      manifest.spackVersion === "1.0.0" &&
      manifest.recipes.some(
        (recipe) => recipe.repositoryId === release.recipeId && recipe.commit === release.commit,
      ),
    "Cached manifest does not match the published release",
  );
  for (const blob of new Map(spackMaterialBlobs(manifest).map((item) => [item.digest, item])).values()) {
    assert(await cache.reuse(blob, signal), "Declared material blob is missing from Agent cache");
  }
  const lock = inspectSpackLock(
    await cache.readMetadata(manifest.lockfile, SPACK_LOCK_MAX_BYTES, signal),
    manifest,
  );
  assert(
    lock.valid && lock.rootHash === report.root.hash,
    "Managed root does not match the published lock",
  );
}

async function readyRecord(release: Release, expected?: SpackInstallRecord) {
  const records = (await store.list()).filter(
    (record) => record.spec === release.spec && record.state !== "removed",
  );
  assert(records.length === 1, "Expected one active managed release record");
  const record = records[0];
  assert(record?.state === "ready" && record.report, "Managed release record is not ready");
  verifyReport(record.report, release);
  assert(
    record.manifestDigest === release.binding.manifestDigest &&
      record.manifestSize === release.manifestSize &&
      record.report.storePath === store.path(record.id),
    "Managed record binding mismatch",
  );
  if (expected) {
    assert(isDeepStrictEqual(record, expected), "Persisted managed release record changed");
  }
  for (const path of [store.path(record.id), record.report.prefix]) {
    const entry = await lstat(path);
    assert(
      entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        entry.uid === process.getuid?.() &&
        (entry.mode & 0o022) === 0 &&
        (await realpath(path)) === path,
      "Managed release directory or prefix is unsafe",
    );
  }
  return { record, report: record.report };
}

async function readState(release: Release): Promise<State> {
  const state = StateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
  assert(
    isDeepStrictEqual(state.binding, release.binding) &&
      state.target === release.target &&
      state.record.spec === release.spec &&
      state.record.state === "ready" &&
      state.record.manifestDigest === release.binding.manifestDigest &&
      state.record.manifestSize === release.manifestSize,
    "Saved managed state does not match the published release",
  );
  return state;
}

async function noReleaseDirectory(record: SpackInstallRecord) {
  try {
    await lstat(store.path(record.id));
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  assert.fail("Managed release directory remains after uninstall");
}

async function main() {
  assert(process.env.KQ_PR_TEST === "1", "Managed case requires the disposable PR environment");
  // The image pins kq to UID 1000. Bun 1.3.13's userInfo().username reads USER,
  // which Docker exec --user does not update; it is not process identity.
  assert(
    process.getuid?.() === 1000 && process.geteuid?.() === 1000,
    "Managed case must run as the nonroot Agent user",
  );
  assert(
    process.env.AGENT_SPACK_INSTALL_ENABLED === "true",
    "Managed installation must be enabled",
  );
  assert(process.argv.length === 3, "Expected exactly one managed case phase");
  const phase = PhaseSchema.parse(process.argv[2]);
  stage = "release";
  const release = ReleaseSchema.parse(
    JSON.parse(await readFile("/case-control/release.json", "utf8")),
  );
  if (phase === "install") {
    stage = "cache";
    await emptyCache();
  }
  stage = "connect";
  const api = managedApi(await login("https://server:3443"));
  await api.online();

  let state: State;
  if (phase === "install") {
    stage = "install";
    const operation = await api.operation("install", release.spec);
    stage = "report";
    assert(operation.stdout !== null, "Managed install report is missing");
    const report = SpackInstallReportSchema.parse(JSON.parse(operation.stdout));
    verifyReport(report, release);
    await verifyCachedMaterials(release, report);
    stage = "store";
    const ready = await readyRecord(release);
    assert(isDeepStrictEqual(ready.report, report), "API and persisted verify reports differ");
    stage = "inventory";
    await api.inventory(report.root.spec, true);
    stage = "job";
    state = StateSchema.parse({
      version: 1,
      binding: release.binding,
      target: release.target,
      record: ready.record,
      queueId: await api.createQueue(),
    });
  } else {
    stage = "state";
    state = await readState(release);
    stage = "store";
    await readyRecord(release, state.record);
  }

  if (phase === "uninstall") {
    stage = "uninstall";
    await api.operation("uninstall", `/${state.record.rootHash}`);
    stage = "inventory";
    await api.inventory(state.record.spec, false);
    stage = "store";
    const records = await store.list();
    const removed = records.find((record) => record.id === state.record.id);
    assert(removed?.state === "removed", "Managed record was not marked removed");
    assert(
      !records.some((record) => record.rootHash === state.record.rootHash && record.state === "ready"),
      "Managed root remains in ready inventory",
    );
    await noReleaseDirectory(state.record);
  } else {
    if (phase === "restart") {
      // Registry persistence/restart is exercised by the main harness, not this Agent-side case.
      stage = "import_preinstalled";
      const imported = await api.operation("import_preinstalled", `/${state.record.rootHash}`);
      stage = "report";
      assert(imported.stdout !== null, "Managed import report is missing");
      const report = SpackInstallReportSchema.parse(JSON.parse(imported.stdout));
      verifyReport(report, release);
      assert(
        isDeepStrictEqual(report, state.record.report),
        "Restart verification changed the managed report",
      );
      await verifyCachedMaterials(release, report);
      stage = "store";
      await readyRecord(release, state.record);
      stage = "inventory";
      await api.inventory(state.record.spec, true);
    }
    stage = "load";
    const loaded = await api.operation("load", `/${state.record.rootHash}`);
    assert(loaded.stdout !== null, "Managed load shell is missing");
    stage = "store";
    const ready = await readyRecord(release, state.record);
    stage = "job";
    await api.hello(state.queueId, ready.report.prefix, loaded.stdout);
    stage = "store";
    await readyRecord(release, state.record);
    if (phase === "install") {
      stage = "integrity";
      state.record = await verifyManagedCacheIntegrity({
        release,
        record: state.record,
        api,
      });
      await readyRecord(release, state.record);
      stage = "state";
      // Persist only typed public release metadata; never tokens, operation output or load shell.
      await mkdir(caseDirectory, { recursive: true, mode: 0o700 });
      await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    }
  }
  console.log(`Spack managed case: phase=${phase} status=succeeded`);
}

try {
  await main();
} catch (error) {
  // Do not print messages, stacks, Zod issues, assertion values, stdout or stderr.
  const code =
    error instanceof z.ZodError
      ? "SCHEMA_INVALID"
      : error instanceof assert.AssertionError
        ? "ASSERTION_FAILED"
        : error instanceof SyntaxError
          ? "INVALID_JSON"
          : "CASE_FAILED";
  console.error(`Spack managed case: stage=${stage} code=${code}`);
  if (stage === "install") await diagnoseManagedInstall();
  process.exit(1);
}

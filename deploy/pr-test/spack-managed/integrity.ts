import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdtemp, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  type SpackMaterialBlob,
  SpackMaterialBlobSchema,
  SpackMaterialManifestSchema,
} from "@kuintessence/shared";
import type { z } from "zod";
import {
  type SpackInstallRecord,
  SpackInstallRecordSchema,
  SpackInstallReportSchema,
} from "../../../packages/agent/src/spack/install-contract";
import { SpackInstallStore } from "../../../packages/agent/src/spack/install-store";
import { SpackMaterialCache } from "../../../packages/agent/src/spack/material-cache";
import { waitFor } from "../runtime";
import { ReleaseSchema } from "../spack-case/api";
import type { managedApi } from "./api-helper";

const cacheRoot = "/var/lib/kuintessence/spack-materials";
const digestDirectory = `${cacheRoot}/sha256`;
const storeRoot = "/srv/kq/spack";
const maximumSourceBytes = 64 * 1024 ** 2;
const StableRecordSchema = SpackInstallRecordSchema.omit({ state: true, updatedAt: true }).strip();
type Scenario = "missing-source" | "corrupt-source";
type Substage =
  | "guard"
  | "baseline"
  | "negative-load"
  | "unavailable-wait"
  | "record-check"
  | "inventory-withdrawal"
  | "restored-unavailable"
  | "recovery-verify"
  | "ready-wait"
  | "inventory-recovery";

export interface ManagedIntegrityInput {
  release: z.infer<typeof ReleaseSchema>;
  record: SpackInstallRecord;
  api: Pick<ReturnType<typeof managedApi>, "operation" | "inventory">;
}

async function controlledCache() {
  for (const path of [
    "/var",
    "/var/lib",
    "/var/lib/kuintessence",
    cacheRoot,
    digestDirectory,
  ]) {
    const entry = await lstat(path);
    assert(
      entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        (entry.uid === 0 || entry.uid === 1000) &&
        (entry.mode & 0o022) === 0 &&
        (await realpath(path)) === path,
      "Integrity case cache path is not controlled",
    );
    if (path === cacheRoot || path === digestDirectory) {
      assert(
        entry.uid === 1000 && (entry.mode & 0o077) === 0,
        "Integrity case requires an Agent-private cache",
      );
    }
  }
}

function sameFile(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function assertSource(entry: Stats, size: number) {
  const mode = entry.mode & 0o7777;
  assert(
    entry.isFile() &&
      !entry.isSymbolicLink() &&
      entry.uid === 1000 &&
      entry.nlink === 1 &&
      entry.size === size &&
      (mode === 0o400 || mode === 0o600),
    "Integrity case source is not an exclusive private regular file",
  );
}

async function damagedSource(
  cache: SpackMaterialCache,
  source: SpackMaterialBlob,
  scenario: Scenario,
  exercise: () => Promise<void>,
) {
  const blob = SpackMaterialBlobSchema.parse(source);
  assert(blob.size <= maximumSourceBytes, "Integrity case source exceeds the byte limit");
  const path = `${digestDirectory}/${blob.digest.slice(7)}`;
  await controlledCache();
  const original = await lstat(path);
  assertSource(original, blob.size);
  const bytes = await cache.readMetadata(blob, maximumSourceBytes, AbortSignal.timeout(60_000));
  const checked = await lstat(path);
  assertSource(checked, blob.size);
  assert(
    sameFile(original, checked) &&
      original.mode === checked.mode &&
      original.gid === checked.gid &&
      original.mtimeMs === checked.mtimeMs &&
      original.ctimeMs === checked.ctimeMs,
    "Integrity case source changed during verification",
  );
  assert(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` === blob.digest,
    "Integrity case source digest mismatch",
  );

  const directory = await mkdtemp(`${cacheRoot}/.integrity-`);
  const backup = `${directory}/source`;
  let moved = false;
  let replacement: Stats | undefined;
  try {
    await controlledCache();
    const current = await lstat(path);
    assertSource(current, blob.size);
    assert(
      sameFile(current, checked) &&
        current.mode === checked.mode &&
        current.mtimeMs === checked.mtimeMs &&
        current.ctimeMs === checked.ctimeMs,
      "Integrity case source changed before mutation",
    );
    // Preserve the verified original inode, bytes and mode; never modify it in place.
    await rename(path, backup);
    moved = true;
    if (scenario === "corrupt-source") {
      const corrupted = Uint8Array.from(bytes);
      const first = corrupted[0];
      assert(first !== undefined, "Integrity case source is empty");
      corrupted[0] = first ^ 0xff;
      assert(
        `sha256:${createHash("sha256").update(corrupted).digest("hex")}` !== blob.digest,
        "Integrity case corruption did not change the digest",
      );
      const file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        original.mode & 0o7777,
      );
      try {
        replacement = await file.stat();
        await file.writeFile(corrupted);
        await file.chmod(original.mode & 0o7777);
        await file.sync();
        const written = await file.stat();
        assertSource(written, blob.size);
        assert(
          written.mode === original.mode && sameFile(written, await lstat(path)),
          "Integrity case corruption changed size, mode or file identity",
        );
      } finally {
        await file.close();
      }
    }
    await exercise();
  } finally {
    if (moved) {
      await controlledCache();
      const saved = await lstat(backup);
      assertSource(saved, blob.size);
      assert(
        sameFile(saved, original) && saved.mode === original.mode && saved.gid === original.gid,
        "Integrity case backup identity changed",
      );
      if (replacement) {
        const current = await lstat(path);
        assert(
          current.isFile() &&
            current.uid === 1000 &&
            current.nlink === 1 &&
            sameFile(current, replacement),
          "Integrity case refuses to remove an unrelated replacement",
        );
        await unlink(path);
      }
      // Unlike rename, link refuses to overwrite an unexpected file at the cache path.
      // Keep the backup if restoration fails; never recursively delete this directory.
      await link(backup, path);
      const restored = await lstat(path);
      assert(
        sameFile(restored, original) &&
          restored.mode === original.mode &&
          restored.gid === original.gid,
        "Integrity case did not restore the original file and mode",
      );
      const restoredBytes = await cache.readMetadata(
        blob,
        maximumSourceBytes,
        AbortSignal.timeout(60_000),
      );
      assert(isDeepStrictEqual(restoredBytes, bytes), "Integrity case source bytes were not restored");
      await unlink(backup);
      assertSource(await lstat(path), blob.size);
    }
    await rmdir(directory);
  }
}

async function readRecord(store: SpackInstallStore, expected: SpackInstallRecord) {
  const records = (await store.list()).filter(
    (record) =>
      record.state !== "removed" &&
      (record.rootHash === expected.rootHash || record.spec === expected.spec),
  );
  const record = records[0];
  assert(
    records.length === 1 && record?.id === expected.id,
    "Integrity case managed record identity changed",
  );
  return record;
}

function unchangedRecord(
  actual: SpackInstallRecord,
  previous: SpackInstallRecord,
  state: "ready" | "unavailable",
) {
  assert(actual.state === state, "Integrity case managed record state mismatch");
  assert(
    isDeepStrictEqual(StableRecordSchema.parse(actual), StableRecordSchema.parse(previous)),
    "Integrity case changed immutable record fields or the verify report",
  );
}

/** Run after the initial positive load/Slurm job; persist the returned real ready record. */
export async function verifyManagedCacheIntegrity(
  input: ManagedIntegrityInput,
): Promise<SpackInstallRecord> {
  let scenario: Scenario | "guard" = "guard";
  let substage: Substage = "guard";
  let observedState: SpackInstallRecord["state"] | "unobserved" = "unobserved";
  try {
    assert(
      process.env.KQ_PR_TEST === "1" &&
        process.getuid?.() === 1000 &&
        process.geteuid?.() === 1000,
      "Integrity case requires the disposable nonroot Agent identity",
    );
    const release = ReleaseSchema.parse(input.release);
    let record = SpackInstallRecordSchema.parse(input.record);
    const report = SpackInstallReportSchema.parse(record.report);
    const store = new SpackInstallStore(storeRoot);
    assert(
      record.state === "ready" &&
        report.action === "verify" &&
        report.root.name === "hello" &&
        report.root.version === "2.12.1" &&
        record.spec === release.spec &&
        record.manifestDigest === release.binding.manifestDigest &&
        record.manifestSize === release.manifestSize &&
        report.manifestDigest === record.manifestDigest &&
        report.siteProfileDigest === record.siteProfileDigest &&
        report.root.hash === record.rootHash &&
        report.root.spec === record.spec &&
        report.root.arch === release.target &&
        report.storePath === store.path(record.id),
      "Integrity case requires the published ready GNU Hello release",
    );
    assert(
      isDeepStrictEqual(await readRecord(store, record), record),
      "Integrity case input does not match the durable ready record",
    );
    await controlledCache();
    const cache = new SpackMaterialCache(cacheRoot);
    const manifestBytes = await cache.readMetadata(
      { digest: record.manifestDigest, size: record.manifestSize },
      2 * 1024 ** 2,
      AbortSignal.timeout(60_000),
    );
    const manifest = SpackMaterialManifestSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
    );
    assert(
      manifest.repository.startsWith("public/") &&
        manifest.redistribution === "unrestricted" &&
        manifest.spec === release.spec &&
        manifest.target === release.target &&
        manifest.spackVersion === "1.0.0" &&
        manifest.recipes.some(
          (recipe) => recipe.repositoryId === release.recipeId && recipe.commit === release.commit,
        ),
      "Integrity case manifest does not match the published public release",
    );
    const metadata = new Set([
      record.manifestDigest,
      manifest.lockfile.digest,
      ...manifest.recipes.map((recipe) => recipe.archive.digest),
    ]);
    const source = manifest.sources.find(
      (entry) => entry.blob.size <= maximumSourceBytes && !metadata.has(entry.blob.digest),
    )?.blob;
    assert(source, "Integrity case requires a bounded source-only blob");

    for (const test of ["missing-source", "corrupt-source"] as const) {
      scenario = test;
      substage = "baseline";
      const before = await readRecord(store, record);
      observedState = before.state;
      assert(isDeepStrictEqual(before, record), "Integrity case ready baseline changed");
      assert(before.state === "ready", "Integrity case must begin with a ready record");
      await input.api.inventory(record.spec, true);
      await damagedSource(cache, source, test, async () => {
        substage = "negative-load";
        const failed = await input.api.operation("load", `/${record.rootHash}`, {
          expectedStatus: "failed",
        });
        assert(
          failed.stdout === null || failed.stdout.trim() === "",
          "Integrity case failed load returned a shell",
        );
        substage = "unavailable-wait";
        const unavailable = await waitFor(
          "integrity case unavailable record",
          async () => {
            const current = await readRecord(store, record);
            observedState = current.state;
            return current;
          },
          (value) => value.state === "unavailable",
        );
        substage = "record-check";
        unchangedRecord(unavailable, record, "unavailable");
        substage = "inventory-withdrawal";
        await input.api.inventory(record.spec, false);
      });

      // Restoring cache bytes alone must not publish readiness.
      substage = "restored-unavailable";
      unchangedRecord(await readRecord(store, record), record, "unavailable");
      substage = "recovery-verify";
      const imported = await input.api.operation("import_preinstalled", `/${record.rootHash}`);
      assert(imported.stdout !== null, "Integrity case recovery report is missing");
      const recoveredReport = SpackInstallReportSchema.parse(JSON.parse(imported.stdout));
      assert(
        recoveredReport.action === "verify" && isDeepStrictEqual(recoveredReport, report),
        "Integrity case recovery verify report changed",
      );
      substage = "ready-wait";
      const recovered = await waitFor(
        "integrity case recovered ready record",
        async () => {
          const current = await readRecord(store, record);
          observedState = current.state;
          return current;
        },
        (value) => value.state === "ready",
      );
      unchangedRecord(recovered, record, "ready");
      substage = "inventory-recovery";
      await input.api.inventory(record.spec, true);
      record = recovered;
      console.log(`Spack managed integrity: scenario=${test} status=succeeded`);
    }
    return record;
  } catch {
    // Do not propagate filesystem errors, assertion values, JSON input or operation output.
    console.error(
      `Spack managed integrity: scenario=${scenario} substage=${substage} state=${observedState} code=INTEGRITY_FAILED`,
    );
    throw new Error("Managed cache integrity acceptance failed");
  }
}

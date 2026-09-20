import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { SpackMaterialManifestSchema, spackMaterialBlobs } from "@kuintessence/shared";
import { realSpackAuditProcess, type SpackAuditProcess } from "../../../packages/agent/src/spack/audit-process";
import { IsolatedSpackInstallRunner } from "../../../packages/agent/src/spack/install-runner";
import { loadSpackInstallSiteProfile } from "../../../packages/agent/src/spack/install-site-profile";
import { SpackInstallStore } from "../../../packages/agent/src/spack/install-store";
import { SpackMaterialCache, type SpackMaterialCacheRef } from "../../../packages/agent/src/spack/material-cache";
import { SpackSourceAuditor } from "../../../packages/agent/src/spack/source-auditor";
import { ReleaseSchema } from "../spack-case/api";

const diagnosticProcess: SpackAuditProcess = {
  async run(command, options) {
    const entry = command.findIndex((value) =>
      value === "/kq/input/install_worker.py" || value === "/kq/input/source_audit.py");
    assert(entry >= 0);
    await copyFile(
      "deploy/pr-test/spack-managed/diagnostic.py",
      join(options.cwd, "input", "diagnostic.py"),
    );
    const result = await realSpackAuditProcess.run(
      command.map((value, index) => index === entry ? "/kq/input/diagnostic.py" : value),
      options,
    );
    for (const line of result.stderr.split("\n")) {
      if (
        /^ci-worker-error:(AuditError|KeyError|ValueError|TypeError|AttributeError|OSError|PermissionError|FileNotFoundError|InstallError|SystemExit|Exception)$/.test(line) ||
        /^ci-worker-location:(install_worker|source_audit)\.py:\d{1,5}$/.test(line) ||
        /^ci-writable-mount:location=(root|devices|null-device|zero-device|random-device|urandom-device|tty-device|passwd|group|resolver|hosts|localtime|cgroups|tmp|var-tmp|work|other) filesystem=(overlay|ext4|xfs|fuse\.squashfuse|fuse\.squashfuse_ll|fuse-overlayfs|fuse\.fuse-overlayfs|cgroup2|devtmpfs|ramfs|other)$/.test(line)
      ) console.error(line);
    }
    return result;
  },
};

/** Reproduce a failed operation without creating/updating any managed ledger entry. */
export async function diagnoseManagedInstall(): Promise<void> {
  let stage = "input";
  let directory: string | undefined;
  try {
    assert.equal(process.env.KQ_PR_TEST, "1");
    assert.equal(process.getuid?.(), 1000);
    const release = ReleaseSchema.parse(
      JSON.parse(await readFile("/case-control/release.json", "utf8")),
    );
    const store = new SpackInstallStore("/srv/kq/spack");
    for (const record of await store.list()) {
      // States are schema-validated enums; do not print report data or paths.
      console.log(`Managed diagnostic ledger: state=${record.state}`);
    }
    const cacheRoot = "/var/lib/kuintessence/spack-materials";
    const cache = new SpackMaterialCache(cacheRoot);
    const signal = AbortSignal.timeout(10 * 60_000);
    const manifestBytes = await cache.readMetadata(
      { digest: release.binding.manifestDigest, size: release.manifestSize },
      2 * 1024 ** 2, signal,
    );
    const manifest = SpackMaterialManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
    const refs = [...new Map(spackMaterialBlobs(manifest).map((blob) => [blob.digest, blob])).values()];
    const blobs: SpackMaterialCacheRef[] = [];
    for (const blob of refs) {
      const verified = await cache.reuse(blob, signal);
      assert(verified, "Diagnostic materials are missing");
      blobs.push(verified);
    }
    const prepared = {
      manifest, manifestDigest: release.binding.manifestDigest,
      manifestSize: release.manifestSize,
      manifestPath: join(cacheRoot, "sha256", release.binding.manifestDigest.slice(7)),
      blobs,
    };
    const values = Object.fromEntries(
      (await readFile("/etc/kuintessence/managed/runtime.env", "utf8"))
        .trim().split("\n").map((line) => line.split("=")),
    );
    const runtime = {
      apptainerPath: values.AGENT_SPACK_AUDIT_APPTAINER_PATH ?? "",
      apptainerSha256: values.AGENT_SPACK_AUDIT_APPTAINER_SHA256 ?? "",
      sifPath: values.AGENT_SPACK_AUDIT_SIF_PATH ?? "",
      sifSha256: values.AGENT_SPACK_AUDIT_SIF_SHA256 ?? "",
    };
    const input = {
      operationId: randomUUID(), ticket: "", manifestDigest: release.binding.manifestDigest,
      spec: release.spec, spackVersion: "1.0.0", signal,
    };
    stage = "source-audit";
    const audit = await new SpackSourceAuditor({
      profile: runtime, process: diagnosticProcess,
    }).audit(prepared, input);
    console.log(`Managed diagnostic audit: passed=${audit.passed} verified=${audit.verifiedNodeCount}`);
    for (const issue of audit.issues) {
      if (new Set([
        "source-verification-failed", "package-hash-mismatch", "package-hash-unsupported",
        "unsupported-fetcher", "native-node-mismatch", "root-spec-mismatch",
        "root-binding-mismatch", "native-root-mismatch", "issue-limit",
      ]).has(issue.code)) console.log(`Managed diagnostic audit issue: ${issue.code}`);
    }
    assert(audit.passed);
    stage = "site";
    const site = await loadSpackInstallSiteProfile({
      path: values.AGENT_SPACK_INSTALL_SITE_PROFILE_PATH ?? "",
      sha256: values.AGENT_SPACK_INSTALL_SITE_PROFILE_SHA256 ?? "",
      runtime,
    }, signal);
    const root = await lstat(site.profile.storeRoot);
    assert(root.isDirectory() && !root.isSymbolicLink() && root.uid === 1000);
    assert.equal(site.profile.storeRoot, "/srv/kq/spack");
    directory = store.path(randomUUID());
    await mkdir(directory, { mode: 0o700 });
    stage = "install";
    const runner = new IsolatedSpackInstallRunner({
      runtime,
      process: diagnosticProcess,
    });
    await runner.run("install", prepared, input, site, directory);
    stage = "verify";
    await runner.run("verify", prepared, input, site, directory);
    console.log("Managed diagnostic worker: install-and-verify-completed (original API case still failed)");
  } catch {
    console.error(`Managed diagnostic failed: stage=${stage}`);
  } finally {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        console.error("Managed diagnostic failed: stage=cleanup");
      }
    }
  }
}

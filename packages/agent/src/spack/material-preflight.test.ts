import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPACK_LOCK_MAX_BYTES, type SpackMaterialManifest } from "@kuintessence/shared";
import { SpackManager } from "./index";
import { SpackMaterialClient } from "./material-client";
import { preflightSpackMaterials } from "./material-preflight";
import type { SpackSourceAuditReport } from "./source-audit-report";

const hash = "a".repeat(32);
const lock = JSON.stringify({
  _meta: { "file-type": "spack-lockfile", "lockfile-version": 6, "specfile-version": 5 },
  spack: { version: "1.0.0", type: "release" },
  roots: [{ spec: "hello@1.0", hash }],
  concrete_specs: {
    [hash]: {
      name: "hello",
      version: "1.0",
      namespace: "builtin",
      hash,
      arch: { platform: "linux", platform_os: "ubuntu24.04", target: "x86_64" },
      parameters: {},
    },
  },
});
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const blob = (text: string) => ({ digest: digest(text), size: Buffer.byteLength(text) });
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(lockText = lock, target = "linux-ubuntu24.04-x86_64") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kq-lock-preflight-")));
  directories.push(root);
  const archive = "opaque recipe archive; never extracted";
  const source = "opaque source; never executed";
  const manifest: SpackMaterialManifest = {
    version: 1,
    repository: "public/test",
    spec: "hello@1.0",
    spackVersion: "1.0.0",
    target,
    redistribution: "unrestricted",
    recipes: [
      {
        repositoryId: "b".repeat(64),
        commit: "c".repeat(40),
        roots: ["."],
        archive: blob(archive),
      },
    ],
    sources: [{ path: "hello/hello-1.0.tar.gz", blob: blob(source) }],
    lockfile: blob(lockText),
  };
  const text = JSON.stringify(manifest, null, 2);
  const input = {
    operationId: "operation-1",
    ticket: "fixture-ticket",
    manifestDigest: digest(text),
    spec: manifest.spec,
    spackVersion: manifest.spackVersion,
  };
  const values = new Map([archive, source, lockText].map((text) => [digest(text), text]));
  const client = new SpackMaterialClient({
    cacheDir: join(root, "cache"),
    serverUrl: "https://server.example",
    fetch: async (url) =>
      new Response(url.endsWith("/manifest") ? text : values.get(url.split("/").at(-1) ?? "")),
  });
  const prepared = await client.prepare(input);
  const lockPath = prepared.blobs.find((ref) => ref.digest === manifest.lockfile.digest)?.path;
  if (!lockPath) throw new Error("Missing lock fixture");
  return { root, client, prepared, input, lockPath };
}

describe("Agent managed material preflight", () => {
  test("revalidates cached manifest/lock and returns static facts without extracting or executing", async () => {
    const f = await fixture();
    const report = await preflightSpackMaterials(f.prepared, f.input);
    expect(report).toMatchObject({
      validation: "static-only",
      valid: true,
      rootHash: hash,
      nodeCount: 1,
      architectures: ["linux-ubuntu24.04-x86_64"],
    });
    expect(report.diagnostics.some((item) => item.severity === "warning")).toBe(true);
  });

  test("valid preflight still cannot start a managed installation or report success", async () => {
    const f = await fixture();
    const commands: string[][] = [];
    const manager = await SpackManager.bootstrap({
      requireServerMaterials: true,
      materialClient: f.client,
      spawner: {
        async run(command) {
          commands.push(command);
          return { exitCode: 0, stdout: "1.0.0", stderr: "" };
        },
      },
    });
    expect(await manager.runSoftwareOperation("install", f.input.spec, f.input)).toEqual({
      outcome: "rejected",
      reason: "managed offline Spack execution is not enabled yet",
    });
    expect(commands).toEqual([["spack", "--version"]]);
  });

  test.each([
    "passed",
    "failed",
    "exception",
    "denied",
    "invalid-lock",
  ])("optional source auditor %s never installs or bypasses policy/preflight", async (mode) => {
    const f = await fixture(mode === "invalid-lock" ? "invalid" : lock);
    let audits = 0;
    const commands: string[][] = [];
    const auditReport: SpackSourceAuditReport = {
      version: 1,
      validation: "isolated-source-audit",
      manifestDigest: f.input.manifestDigest,
      spackVersion: "1.0.0",
      rootHash: hash,
      nodeCount: 1,
      externalCount: 0,
      verifiedNodeCount: mode === "failed" ? 0 : 1,
      passed: mode !== "failed",
      issues: mode === "failed" ? [{ severity: "error", code: "source-unavailable", hash }] : [],
    };
    const manager = await SpackManager.bootstrap({
      requireServerMaterials: true,
      materialClient: f.client,
      materialAuditor: {
        async audit(prepared, input) {
          audits++;
          expect(prepared).toEqual(f.prepared);
          expect(input).toEqual(f.input);
          if (mode === "exception") throw new Error("secret upstream URL");
          return auditReport;
        },
      },
      spawner: {
        async run(command) {
          commands.push(command);
          return { exitCode: 0, stdout: "1.0.0", stderr: "" };
        },
      },
    });
    if (mode === "denied") {
      await manager.applyPolicy({
        policyVersion: "deny",
        lockEnabled: false,
        denyList: ["hello@*"],
      });
    }
    const result = await manager.runSoftwareOperation("install", f.input.spec, f.input);
    if (mode === "passed") {
      expect(result).toEqual({
        outcome: "rejected",
        reason: "managed offline Spack execution is not enabled yet",
        stdout: JSON.stringify(auditReport),
      });
    } else if (mode === "failed") {
      expect(result).toMatchObject({
        outcome: "failed",
        exitCode: 1,
        stderr: "Spack source audit failed: source-unavailable",
      });
    } else if (mode === "exception") {
      expect(result).toEqual({
        outcome: "failed",
        exitCode: 1,
        stderr: "Spack source audit could not complete in the configured isolated runtime",
      });
    } else {
      expect(result.outcome).toBe(mode === "denied" ? "rejected" : "failed");
    }
    expect(audits).toBe(mode === "denied" || mode === "invalid-lock" ? 0 : 1);
    expect(commands).toEqual([["spack", "--version"]]);
  });

  test.each([
    ["invalid-json", "opaque", "linux-ubuntu24.04-x86_64"],
    ["wrong-spec", lock.replace("hello@1.0", "other@1.0"), "linux-ubuntu24.04-x86_64"],
    ["wrong-target", lock, "linux-ubuntu24.04-aarch64"],
    [
      "unknown-version",
      lock.replace('"version":"1.0.0"', '"version":"9.0.0"'),
      "linux-ubuntu24.04-x86_64",
    ],
  ])("%s lock fails despite matching SHA-256 and never starts Spack", async (_label, text, target) => {
    const f = await fixture(text, target);
    const report = await preflightSpackMaterials(f.prepared, f.input);
    expect(report.valid).toBe(false);
    const commands: string[][] = [];
    const manager = await SpackManager.bootstrap({
      requireServerMaterials: true,
      materialClient: f.client,
      spawner: {
        async run(command) {
          commands.push(command);
          return { exitCode: 0, stdout: "1.0.0", stderr: "" };
        },
      },
    });
    expect(await manager.runSoftwareOperation("install", f.input.spec, f.input)).toMatchObject({
      outcome: "failed",
      stderr: expect.stringContaining("Spack lock preflight failed"),
    });
    expect(commands).toEqual([["spack", "--version"]]);
  });

  test.each([
    "manifest",
    "lock",
  ])("rejects replaced %s bytes between prepare and preflight", async (kind) => {
    const f = await fixture();
    const path = kind === "manifest" ? f.prepared.manifestPath : f.lockPath;
    const bytes = await readFile(path);
    await chmod(path, 0o600);
    await writeFile(path, Buffer.alloc(bytes.length, 120));
    await expect(preflightSpackMaterials(f.prepared, f.input)).rejects.toThrow("SHA-256");
  });

  test.each(["manifest", "lock"])("rejects symlinked %s cache entries", async (kind) => {
    const f = await fixture();
    const path = kind === "manifest" ? f.prepared.manifestPath : f.lockPath;
    const outside = join(f.root, "outside");
    await writeFile(outside, await readFile(path), { mode: 0o400 });
    await rm(path);
    await symlink(outside, path);
    await expect(preflightSpackMaterials(f.prepared, f.input)).rejects.toThrow("symlink");
  });

  test("rejects altered in-memory metadata, references, and bindings", async () => {
    const f = await fixture();
    for (const prepared of [
      { ...f.prepared, manifestDigest: `sha256:${"f".repeat(64)}` },
      { ...f.prepared, manifestPath: join(f.root, "unrelated") },
      { ...f.prepared, manifest: { ...f.prepared.manifest, spec: "other@1.0" } },
      { ...f.prepared, manifest: { ...f.prepared.manifest, target: "linux-other-x86_64" } },
      { ...f.prepared, blobs: [] },
      { ...f.prepared, blobs: [...f.prepared.blobs, ...f.prepared.blobs] },
      { ...f.prepared, blobs: f.prepared.blobs.map((ref) => ({ ...ref, path: "/outside" })) },
      { ...f.prepared, blobs: f.prepared.blobs.map((ref) => ({ ...ref, size: ref.size + 1 })) },
      { ...f.prepared, manifestSize: 2 * 1024 ** 2 + 1 },
    ]) {
      await expect(preflightSpackMaterials(prepared, f.input)).rejects.toThrow();
    }
  });

  test("rejects group-readable metadata and honors cancellation", async () => {
    const f = await fixture();
    await chmod(f.lockPath, 0o440);
    await expect(preflightSpackMaterials(f.prepared, f.input)).rejects.toThrow("group/other");
    await expect(
      preflightSpackMaterials(f.prepared, {
        ...f.input,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });

  test("bounds parsed lock bytes independently of the general blob limit", async () => {
    expect(SPACK_LOCK_MAX_BYTES).toBe(16 * 1024 ** 2);
    const f = await fixture();
    const lockfile = { ...f.prepared.manifest.lockfile, size: SPACK_LOCK_MAX_BYTES + 1 };
    const prepared = {
      ...f.prepared,
      manifest: { ...f.prepared.manifest, lockfile },
      blobs: f.prepared.blobs.map((ref) =>
        ref.digest === lockfile.digest ? { ...ref, size: lockfile.size } : ref,
      ),
    };
    await expect(preflightSpackMaterials(prepared, f.input)).rejects.toThrow();
  });
});

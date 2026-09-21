import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpackMaterialManifest } from "@kuintessence/shared";
import type { SpackAuditProcess } from "./audit-process";
import type {
  SpackAuditFileIdentity,
  SpackAuditRuntimeDeps,
  SpackAuditRuntimeProfile,
} from "./audit-runtime";
import { type PreparedSpackMaterials, SpackMaterialClient } from "./material-client";
import type { SpackSourceAuditReport } from "./source-audit-report";
import { SpackSourceAuditor, type SpackSourceAuditorOptions } from "./source-auditor";

type Run = SpackAuditProcess["run"];
type RunResult = Awaited<ReturnType<Run>>;
const rootHash = "a".repeat(32);
const prefix = "KQ_SPACK_AUDIT_RESULT:";
const profile: SpackAuditRuntimeProfile = {
  apptainerPath: "/usr/bin/apptainer",
  apptainerSha256: "a".repeat(64),
  sifPath: "/srv/kq/runtime.sif",
  sifSha256: "b".repeat(64),
};
const namespaces = { hostNetworkNamespace: "net:[100]", hostPidNamespace: "pid:[200]" };
const digest = (text: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;
const blob = (text: string) => ({ digest: digest(text), size: Buffer.byteLength(text) });
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function lock(external = false) {
  return JSON.stringify({
    _meta: { "file-type": "spack-lockfile", "lockfile-version": 6, "specfile-version": 5 },
    spack: { version: "1.0.0", type: "release" },
    roots: [{ spec: "hello@1.0", hash: rootHash }],
    concrete_specs: {
      [rootHash]: {
        name: "hello",
        version: "1.0",
        namespace: "builtin",
        hash: rootHash,
        arch: { platform: "linux", platform_os: "ubuntu24.04", target: "x86_64" },
        parameters: {},
        ...(external ? { external: { path: "/fixture/external", module: null } } : {}),
      },
    },
  });
}

async function fixture(lockText = lock()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kq-source-auditor-")));
  roots.push(root);
  const archive = "opaque recipe archive; never extracted";
  const source = "opaque source archive; never executed";
  const manifest: SpackMaterialManifest = {
    version: 1,
    repository: "public/test",
    spec: "hello@1.0",
    spackVersion: "1.0.0",
    target: "linux-ubuntu24.04-x86_64",
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
  const manifestText = JSON.stringify(manifest, null, 2);
  const input = {
    operationId: "source-audit-fixture",
    ticket: "fixture-private-ticket",
    manifestDigest: digest(manifestText),
    spec: manifest.spec,
    spackVersion: manifest.spackVersion,
  };
  const values = new Map([archive, source, lockText].map((text) => [digest(text), text]));
  const cacheDir = join(root, "cache");
  const client = new SpackMaterialClient({
    cacheDir,
    serverUrl: "https://server.example",
    fetch: async (url) => {
      const text = url.endsWith("/manifest")
        ? manifestText
        : values.get(url.split("/").at(-1) ?? "");
      if (text === undefined) throw new Error("Unexpected fixture fetch");
      return new Response(text);
    },
  });
  const prepared = await client.prepare(input);
  return { root, cacheDir, prepared, input, manifestText, values };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function report(f: Fixture, changed: Partial<SpackSourceAuditReport> = {}): SpackSourceAuditReport {
  return {
    version: 1,
    validation: "isolated-source-audit",
    manifestDigest: f.input.manifestDigest,
    spackVersion: "1.0.0",
    rootHash,
    nodeCount: 1,
    externalCount: 0,
    verifiedNodeCount: 1,
    passed: true,
    issues: [
      { severity: "warning", code: "host-target-unverified" },
      { severity: "warning", code: "solver-unverified" },
    ],
    ...changed,
  };
}

const wire = (value: unknown, exitCode = 0): RunResult => ({
  exitCode,
  stdout: `${prefix}${JSON.stringify(value)}\n`,
  stderr: "",
});
const identity = (path: string): SpackAuditFileIdentity => ({
  canonicalPath: path,
  uid: 0,
  mode: path === profile.apptainerPath ? 0o100755 : 0o100444,
  regular: true,
  symlink: false,
  protectedParents: true,
  sha256: path === profile.apptainerPath ? profile.apptainerSha256 : profile.sifSha256,
});

function harness(
  f: Fixture,
  options: Partial<Omit<SpackSourceAuditorOptions, "process">> & { run?: Run } = {},
) {
  const calls: { command: string[]; options: Parameters<Run>[1] }[] = [];
  const inspections: { path: string; signal: AbortSignal }[] = [];
  let execute: Run = options.run ?? (async () => wire(report(f)));
  const auditor = new SpackSourceAuditor({
    profile: options.profile ?? profile,
    runtimeContext: options.runtimeContext ?? (async () => namespaces),
    runtimeDeps: {
      platform: "linux",
      uid: 1000,
      ...options.runtimeDeps,
      inspect: async (path, signal) => {
        inspections.push({ path, signal });
        return options.runtimeDeps?.inspect?.(path, signal) ?? identity(path);
      },
    },
    process: {
      async run(command, options) {
        calls.push({ command, options });
        return execute(command, options);
      },
    },
  });
  return {
    auditor,
    calls,
    inspections,
    setRun: (run: Run) => {
      execute = run;
    },
  };
}

async function runDirectories(f: Fixture): Promise<string[]> {
  try {
    return await readdir(join(f.cacheDir, "audits"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function expectClean(f: Fixture) {
  expect(await runDirectories(f)).toEqual([]);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("SpackSourceAuditor input boundary", () => {
  test("uses exact clean env and only read-only release input and cgroup binds", async () => {
    const f = await fixture();
    const agentUid = process.getuid?.();
    if (agentUid === undefined) throw new Error("Fixture requires a POSIX uid");
    const unrelated = "another release's private material";
    const unrelatedPath = join(f.cacheDir, "sha256", digest(unrelated).slice(7));
    await writeFile(unrelatedPath, unrelated, { flag: "wx", mode: 0o400 });
    const secretKey = "KQ_SOURCE_AUDITOR_PARENT_SECRET";
    const previous = process.env[secretKey];
    process.env[secretKey] = "parent-only-secret";
    const h = harness(f, {
      run: async (command, options) => {
        const input = join(options.cwd, "input");
        expect(options.cwd.startsWith(join(f.cacheDir, "audits", "run-"))).toBe(true);
        expect(options.env).toEqual({
          PATH: "/usr/bin:/bin",
          HOME: options.cwd,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          XDG_RUNTIME_DIR: "/run/user/1000",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        });
        expect(options.timeoutMs).toBe(30 * 60_000);
        expect(options.maxOutputBytes).toBe(2 * 1024 ** 2);
        expect(options.signal?.aborted).toBe(false);
        expect(command).toEqual([
          profile.apptainerPath,
          "exec",
          "--containall",
          "--userns",
          "--cleanenv",
          "--no-home",
          "--no-eval",
          "--disable-cache",
          "--writable-tmpfs",
          "--no-mount",
          "bind-paths,hostfs,cwd,home,sys",
          "--net",
          "--network",
          "none",
          "--drop-caps",
          "all",
          "--security",
          "no-new-privs",
          "--pids-limit",
          "128",
          "--memory",
          "2147483648",
          "--memory-swap",
          "2147483648",
          "--cpus",
          "2",
          "--pwd",
          "/kq/work",
          "--bind",
          `${input}:/kq/input:ro`,
          "--bind",
          "/sys/fs/cgroup:/sys/fs/cgroup:ro",
          "--env",
          "HOME=/kq/work/home",
          "--env",
          "SPACK_DISABLE_LOCAL_CONFIG=1",
          "--env",
          "SPACK_USER_CONFIG_PATH=/kq/work/config",
          "--env",
          "SPACK_USER_CACHE_PATH=/kq/work/cache",
          "--env",
          "PYTHONDONTWRITEBYTECODE=1",
          "--env",
          "XDG_RUNTIME_DIR=/kq/work/run",
          "--env",
          "DBUS_SESSION_BUS_ADDRESS=",
          profile.sifPath,
          "/opt/spack/bin/spack",
          "python",
          "/kq/input/source_audit.py",
          f.input.manifestDigest,
        ]);
        expect(
          command.flatMap((argument, index) => (argument === "--bind" ? [command[index + 1]] : [])),
        ).toEqual([`${input}:/kq/input:ro`, "/sys/fs/cgroup:/sys/fs/cgroup:ro"]);
        expect(JSON.stringify({ command, options })).not.toContain(f.input.ticket);
        expect(JSON.stringify({ command, options })).not.toContain("parent-only-secret");
        expect((await readdir(options.cwd)).sort()).toEqual(["input"]);
        expect((await readdir(input)).sort()).toEqual([
          "blobs",
          "manifest.json",
          "runtime.json",
          "source_audit.py",
        ]);
        expect((await readdir(join(input, "blobs"))).sort()).toEqual(
          f.prepared.blobs.map((ref) => ref.digest.slice(7)).sort(),
        );
        for (const path of [options.cwd, input, join(input, "blobs")]) {
          expect((await lstat(path)).mode & 0o777).toBe(0o700);
        }
        expect(await readFile(join(input, "manifest.json"), "utf8")).toBe(f.manifestText);
        expect(JSON.parse(await readFile(join(input, "runtime.json"), "utf8"))).toEqual(namespaces);
        expect(await readFile(join(input, "source_audit.py"), "utf8")).toBe(
          await readFile(new URL("./worker/source_audit.py", import.meta.url), "utf8"),
        );
        for (const name of ["manifest.json", "runtime.json", "source_audit.py"]) {
          expect((await lstat(join(input, name))).mode & 0o777).toBe(0o400);
        }
        for (const ref of f.prepared.blobs) {
          const staged = join(input, "blobs", ref.digest.slice(7));
          const stat = await lstat(staged);
          const cached = await lstat(ref.path);
          expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true);
          expect(stat.mode & 0o777).toBe(0o400);
          expect(stat.uid).toBe(agentUid);
          expect([stat.dev, stat.ino]).toEqual([cached.dev, cached.ino]);
          expect(stat.nlink).toBe(2);
          expect(digest(await readFile(staged))).toBe(ref.digest);
        }
        expect(h.inspections.map(({ path }) => path)).toEqual([
          profile.apptainerPath,
          profile.sifPath,
          profile.apptainerPath,
          profile.sifPath,
        ]);
        expect(h.inspections.every(({ signal }) => signal === options.signal)).toBe(true);
        return wire(report(f));
      },
    });
    try {
      expect(await h.auditor.audit(f.prepared, f.input)).toEqual(report(f));
    } finally {
      if (previous === undefined) delete process.env[secretKey];
      else process.env[secretKey] = previous;
    }
    expect(h.calls).toHaveLength(1);
    await expectClean(f);
    expect(await readFile(unrelatedPath, "utf8")).toBe(unrelated);
    expect(await readFile(f.prepared.manifestPath, "utf8")).toBe(f.manifestText);
    for (const ref of f.prepared.blobs) {
      const expected = f.values.get(ref.digest);
      if (expected === undefined) throw new Error("Missing fixture blob bytes");
      expect(await readFile(ref.path, "utf8")).toBe(expected);
      expect((await lstat(ref.path)).nlink).toBe(1);
    }
  });

  test("rejects an invalid static lock before runtime inspection or execution", async () => {
    const f = await fixture("opaque invalid lock");
    const h = harness(f);
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("valid static lock");
    expect(h.inspections).toEqual([]);
    expect(h.calls).toEqual([]);
    await expectClean(f);
  });

  test("rejects forged prepared metadata, references and requested bindings before execution", async () => {
    const f = await fixture();
    const h = harness(f);
    const variants: PreparedSpackMaterials[] = [
      { ...f.prepared, manifestDigest: `sha256:${"f".repeat(64)}` },
      { ...f.prepared, manifestPath: join(f.root, "unrelated") },
      { ...f.prepared, manifestSize: f.prepared.manifestSize + 1 },
      { ...f.prepared, manifest: { ...f.prepared.manifest, spec: "other@1.0" } },
      { ...f.prepared, manifest: { ...f.prepared.manifest, target: "linux-other-x86_64" } },
      { ...f.prepared, blobs: [] },
      { ...f.prepared, blobs: [...f.prepared.blobs, ...f.prepared.blobs] },
      { ...f.prepared, blobs: f.prepared.blobs.map((ref) => ({ ...ref, path: "/outside" })) },
      { ...f.prepared, blobs: f.prepared.blobs.map((ref) => ({ ...ref, size: ref.size + 1 })) },
    ];
    for (const prepared of variants) {
      await expect(h.auditor.audit(prepared, f.input)).rejects.toThrow();
    }
    for (const changed of [
      { manifestDigest: `sha256:${"e".repeat(64)}` },
      { spec: "other@1.0" },
      { spackVersion: "9.0.0" },
    ]) {
      await expect(h.auditor.audit(f.prepared, { ...f.input, ...changed })).rejects.toThrow();
    }
    expect(h.inspections).toEqual([]);
    expect(h.calls).toEqual([]);
    await expectClean(f);
    expect((await h.auditor.audit(f.prepared, f.input)).passed).toBe(true);
  });

  test.each([
    "manifest",
    "lock",
    "recipe",
    "source",
  ])("rehashes altered %s cache bytes and cleans partially staged input", async (kind) => {
    const f = await fixture();
    const h = harness(f);
    const target =
      kind === "lock"
        ? f.prepared.manifest.lockfile.digest
        : kind === "recipe"
          ? f.prepared.manifest.recipes[0]?.archive.digest
          : f.prepared.manifest.sources[0]?.blob.digest;
    const path =
      kind === "manifest"
        ? f.prepared.manifestPath
        : f.prepared.blobs.find((ref) => ref.digest === target)?.path;
    if (!path) throw new Error("Missing fixture blob");
    const original = await readFile(path);
    await chmod(path, 0o600);
    await writeFile(path, Buffer.alloc(original.length, 120));
    await chmod(path, 0o400);
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("SHA-256");
    expect(h.calls).toEqual([]);
    await expectClean(f);
    await chmod(path, 0o600);
    await writeFile(path, original);
    await chmod(path, 0o400);
    expect((await h.auditor.audit(f.prepared, f.input)).passed).toBe(true);
  });

  test("rejects missing or symlinked source cache entries without following outside files", async () => {
    const f = await fixture();
    const h = harness(f);
    const source = f.prepared.blobs.find(
      (ref) => ref.digest === f.prepared.manifest.sources[0]?.blob.digest,
    );
    if (!source) throw new Error("Missing fixture source");
    const outside = join(f.root, "outside");
    await writeFile(outside, await readFile(source.path), { mode: 0o400 });
    await rm(source.path);
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("missing");
    await expectClean(f);
    await symlink(outside, source.path);
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("symlink");
    expect(h.calls).toEqual([]);
    expect(digest(await readFile(outside))).toBe(source.digest);
    await expectClean(f);
  });
});

describe("SpackSourceAuditor report boundary", () => {
  test("returns a valid failed report only with exit 1 and cleans the run", async () => {
    const f = await fixture();
    const expected = report(f, {
      passed: false,
      verifiedNodeCount: 0,
      issues: [{ severity: "error", code: "source-verification-failed", hash: rootHash }],
    });
    const h = harness(f, { run: async () => wire(expected, 1) });
    expect(await h.auditor.audit(f.prepared, f.input)).toEqual(expected);
    await expectClean(f);
  });

  test("binds external counts without claiming external nodes were verified", async () => {
    const f = await fixture(lock(true));
    const expected = report(f, {
      externalCount: 1,
      verifiedNodeCount: 0,
      issues: [{ severity: "warning", code: "external-unverified", hash: rootHash }],
    });
    const h = harness(f, { run: async () => wire(expected) });
    expect(await h.auditor.audit(f.prepared, f.input)).toEqual(expected);
    await expectClean(f);
  });

  test.each([
    { manifestDigest: `sha256:${"f".repeat(64)}` },
    { rootHash: "b".repeat(32) },
    { nodeCount: 2, verifiedNodeCount: 2 },
    { externalCount: 1, verifiedNodeCount: 0 },
  ])("rejects a schema-valid report with altered bindings: %j", async (changed) => {
    const f = await fixture();
    const h = harness(f, { run: async () => wire(report(f, changed)) });
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("binding or exit status");
    await expectClean(f);
  });

  test.each([
    { passed: true, exitCode: 1 },
    { passed: true, exitCode: 2 },
    { passed: true, exitCode: -1 },
    { passed: false, exitCode: 0 },
    { passed: false, exitCode: 2 },
    { passed: false, exitCode: 137 },
  ])("rejects report/exit disagreement: %j", async ({ passed, exitCode }) => {
    const f = await fixture();
    const value = passed
      ? report(f)
      : report(f, {
          passed: false,
          verifiedNodeCount: 0,
          issues: [{ severity: "error", code: "source-verification-failed" }],
        });
    const h = harness(f, { run: async () => wire(value, exitCode) });
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("binding or exit status");
    await expectClean(f);
  });

  test.each([
    "empty",
    "no-prefix",
    "leading-log",
    "invalid-json",
    "trailing-log",
    "two-reports",
  ])("rejects %s stdout without accepting stderr reports or echoing private output", async (kind) => {
    const f = await fixture();
    const valid = wire(report(f)).stdout;
    const outputs: Record<string, string> = {
      empty: "",
      "no-prefix": JSON.stringify(report(f)),
      "leading-log": `private-output\n${valid}`,
      "invalid-json": `${prefix}private-output`,
      "trailing-log": `${valid}private-output`,
      "two-reports": valid + valid,
    };
    const h = harness(f, {
      run: async () => ({
        exitCode: 0,
        stdout: outputs[kind] ?? "",
        stderr: `${valid}private-stderr`,
      }),
    });
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow(
      /^Spack source audit (failed without a valid report|returned an invalid report)$/,
    );
    await expectClean(f);
  });

  test.each([
    ["wrong version", { version: 2 }],
    ["wrong validation", { validation: "static-only" }],
    ["wrong Spack version", { spackVersion: "2.0.0" }],
    ["invalid digest", { manifestDigest: "not-a-digest" }],
    ["invalid root hash", { rootHash: "0".repeat(32) }],
    ["zero nodes", { nodeCount: 0 }],
    ["fractional nodes", { nodeCount: 1.5 }],
    ["too many nodes", { nodeCount: 10_001 }],
    ["negative external count", { externalCount: -1 }],
    ["external count exceeds nodes", { externalCount: 2 }],
    ["fractional external count", { externalCount: 0.5 }],
    ["negative verified count", { verifiedNodeCount: -1 }],
    ["success with incomplete verification", { verifiedNodeCount: 0 }],
    ["verified count exceeds nodes", { verifiedNodeCount: 2 }],
    ["fractional verified count", { verifiedNodeCount: 0.5 }],
    ["non-boolean passed", { passed: "true" }],
    ["failed report without issues", { passed: false, issues: [] }],
    [
      "failed report with warnings only",
      {
        passed: false,
        issues: [{ severity: "warning", code: "warning-only" }],
      },
    ],
    [
      "successful report with errors",
      {
        issues: [{ severity: "error", code: "source-verification-failed" }],
      },
    ],
    ["unknown severity", { issues: [{ severity: "info", code: "unknown" }] }],
    ["empty code", { issues: [{ severity: "warning", code: "" }] }],
    ["oversized code", { issues: [{ severity: "warning", code: "a".repeat(65) }] }],
    ["path in code", { issues: [{ severity: "warning", code: "private/path" }] }],
    ["newline in code", { issues: [{ severity: "warning", code: "warning\n" }] }],
    [
      "invalid issue hash",
      { issues: [{ severity: "warning", code: "bad", hash: "0".repeat(32) }] },
    ],
    [
      "unstructured issue detail",
      {
        issues: [{ severity: "warning", code: "bad", message: "private-message" }],
      },
    ],
    [
      "too many issues",
      {
        issues: Array.from({ length: 101 }, () => ({ severity: "warning", code: "warning" })),
      },
    ],
    ["non-array issues", { issues: null }],
    ["unknown report field", { privateField: "private-value" }],
    ["missing required field", { verifiedNodeCount: undefined }],
  ] as const)("enforces report schema: %s", async (_name, changed) => {
    const f = await fixture();
    const h = harness(f, { run: async () => wire({ ...report(f), ...changed }) });
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow(
      /^Spack source audit returned an invalid report$/,
    );
    await expectClean(f);
  });

  test("accepts exactly 100 bounded issues", async () => {
    const f = await fixture();
    const expected = report(f, {
      issues: Array.from({ length: 100 }, () => ({ severity: "warning", code: "warning" })),
    });
    const h = harness(f, { run: async () => wire(expected) });
    expect(await h.auditor.audit(f.prepared, f.input)).toEqual(expected);
    await expectClean(f);
  });
});

describe("SpackSourceAuditor lifecycle", () => {
  test("cleans up after process rejection and releases the slot for the next audit", async () => {
    const f = await fixture();
    const h = harness(f, {
      run: async () => {
        throw new Error("fixture process failed");
      },
    });
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("fixture process failed");
    await expectClean(f);
    h.setRun(async () => wire(report(f)));
    expect((await h.auditor.audit(f.prepared, f.input)).passed).toBe(true);
    expect(h.calls[0]?.options.cwd).not.toBe(h.calls[1]?.options.cwd);
    await expectClean(f);
  });

  test("rejects concurrent calls without deleting an active run, then permits reuse", async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const release = deferred<RunResult>();
    const h = harness(f, {
      run: async () => {
        entered.resolve();
        return release.promise;
      },
    });
    const first = h.auditor.audit(f.prepared, f.input);
    try {
      await entered.promise;
      await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("already running");
      expect(h.calls).toHaveLength(1);
      expect(await runDirectories(f)).toHaveLength(1);
    } finally {
      release.resolve(wire(report(f)));
      await first;
    }
    await expectClean(f);
    h.setRun(async () => wire(report(f)));
    expect((await h.auditor.audit(f.prepared, f.input)).passed).toBe(true);
    await expectClean(f);
  });

  test("pre-aborted input never inspects runtime or executes and does not retain the slot", async () => {
    const f = await fixture();
    const h = harness(f);
    await expect(
      h.auditor.audit(f.prepared, {
        ...f.input,
        signal: AbortSignal.abort(new Error("fixture canceled")),
      }),
    ).rejects.toThrow("fixture canceled");
    expect(h.inspections).toEqual([]);
    expect(h.calls).toEqual([]);
    await expectClean(f);
    expect((await h.auditor.audit(f.prepared, f.input)).passed).toBe(true);
  });

  test("forwards cancellation to a running process, cleans input and permits the next audit", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const entered = deferred<void>();
    const h = harness(f, {
      run: async (_command, { signal }) =>
        new Promise<RunResult>((_resolve, reject) => {
          if (!signal) throw new Error("Missing process signal");
          signal.addEventListener("abort", () => reject(new Error("fixture canceled")), {
            once: true,
          });
          entered.resolve();
        }),
    });
    const result = h.auditor.audit(f.prepared, { ...f.input, signal: controller.signal });
    await entered.promise;
    controller.abort(new Error("fixture canceled"));
    await expect(result).rejects.toThrow("fixture canceled");
    expect(h.calls[0]?.options.signal?.aborted).toBe(true);
    await expectClean(f);
    h.setRun(async () => wire(report(f)));
    expect((await h.auditor.audit(f.prepared, f.input)).passed).toBe(true);
  });

  test("rejects cancellation even when the process returns a valid successful report", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const h = harness(f, {
      run: async () => {
        controller.abort(new Error("fixture canceled"));
        return wire(report(f));
      },
    });
    await expect(
      h.auditor.audit(f.prepared, {
        ...f.input,
        signal: controller.signal,
      }),
    ).rejects.toThrow("fixture canceled");
    await expectClean(f);
  });

  test("cancellation at final runtime verification prevents dispatch and cleans staged input", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let inspected = 0;
    const h = harness(f, {
      runtimeDeps: {
        inspect: async (path, signal) => {
          signal.throwIfAborted();
          if (++inspected === 4) controller.abort(new Error("fixture canceled"));
          return identity(path);
        },
      },
    });
    await expect(
      h.auditor.audit(f.prepared, {
        ...f.input,
        signal: controller.signal,
      }),
    ).rejects.toThrow("fixture canceled");
    await expectClean(f);
    expect(h.calls).toHaveLength(0);
  });
});

describe("SpackSourceAuditor runtime rejection", () => {
  test.each([
    { platform: "darwin" },
    { platform: "win32" },
    { uid: 0 },
  ])("fails closed before inspection on unsupported runtime %j", async (runtimeDeps) => {
    const f = await fixture();
    const h = harness(f, { runtimeDeps });
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("non-root Linux");
    expect(h.inspections).toEqual([]);
    expect(h.calls).toEqual([]);
    await expectClean(f);
  });

  test.each([
    { apptainerPath: "apptainer" },
    { sifPath: "/tmp/../runtime.sif" },
    { sifPath: "/tmp/runtime:unsafe.sif" },
    { apptainerSha256: "not-a-hash" },
    { sifSha256: "A".repeat(64) },
    { sifPath: profile.apptainerPath },
  ])("rejects malformed runtime profile %j", async (changed) => {
    const f = await fixture();
    const h = harness(f, { profile: { ...profile, ...changed } });
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("runtime profile");
    expect(h.inspections).toEqual([]);
    expect(h.calls).toEqual([]);
    await expectClean(f);
  });

  test.each([
    "apptainer",
    "sif",
  ])("rejects %s identity changes on the second verification and cleans staged input", async (kind) => {
    const f = await fixture();
    const path = kind === "apptainer" ? profile.apptainerPath : profile.sifPath;
    let visits = 0;
    const h = harness(f, {
      runtimeDeps: {
        inspect: async (current) => {
          if (current === path && ++visits === 2) {
            expect(await runDirectories(f)).toHaveLength(1);
            return { ...identity(current), sha256: "f".repeat(64) };
          }
          return identity(current);
        },
      },
    });
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("identity");
    expect(h.calls).toEqual([]);
    await expectClean(f);
    expect((await h.auditor.audit(f.prepared, f.input)).passed).toBe(true);
  });

  test.each([
    { uid: 1000 },
    { mode: 0o100777 },
    { regular: false },
    { symlink: true },
    { protectedParents: false },
    { canonicalPath: "/untrusted" },
    { sha256: "f".repeat(64) },
  ])("rejects unsafe runtime metadata %j", async (changed) => {
    const f = await fixture();
    const runtimeDeps: SpackAuditRuntimeDeps = {
      inspect: async (path) => ({ ...identity(path), ...changed }),
    };
    const h = harness(f, { runtimeDeps });
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("identity");
    expect(h.calls).toEqual([]);
    await expectClean(f);
  });

  test("propagates runtime inspection/context exceptions without executing", async () => {
    const f = await fixture();
    for (const options of [
      {
        runtimeDeps: {
          inspect: async () => {
            throw new Error("fixture runtime unavailable");
          },
        },
      },
      {
        runtimeContext: async () => {
          throw new Error("fixture runtime unavailable");
        },
      },
    ]) {
      const h = harness(f, options);
      await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow(
        "fixture runtime unavailable",
      );
      expect(h.calls).toEqual([]);
      await expectClean(f);
    }
  });

  test.each([
    { hostNetworkNamespace: "unknown" },
    { hostPidNamespace: "net:[200]" },
    { hostPidNamespace: "pid:[not-numeric]" },
  ])("rejects malformed host namespace metadata %j", async (changed) => {
    const f = await fixture();
    const h = harness(f, { runtimeContext: async () => ({ ...namespaces, ...changed }) });
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("bind host namespaces");
    expect(h.calls).toEqual([]);
    await expectClean(f);
  });

  test.each(["permissions", "symlink"])("rejects an unsafe audits directory (%s)", async (kind) => {
    const f = await fixture();
    const audits = join(f.cacheDir, "audits");
    const outside = join(f.root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "sentinel"), "untouched");
    if (kind === "symlink") await symlink(outside, audits);
    else {
      await mkdir(audits, { mode: 0o700 });
      await chmod(audits, 0o755);
    }
    const h = harness(f);
    await expect(h.auditor.audit(f.prepared, f.input)).rejects.toThrow("Agent-private");
    expect(h.calls).toEqual([]);
    expect(await readdir(outside)).toEqual(["sentinel"]);
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("untouched");
  });
});

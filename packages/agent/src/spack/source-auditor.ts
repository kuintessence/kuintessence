/// <reference path="./python.d.ts" />
import { link, lstat, mkdir, mkdtemp, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { realSpackAuditProcess, type SpackAuditProcess } from "./audit-process";
import {
  buildSpackAuditCommand,
  isSpackAuditPath,
  type SpackAuditRuntimeDeps,
  type SpackAuditRuntimeProfile,
  verifySpackAuditRuntime,
} from "./audit-runtime";
import { SpackMaterialCache } from "./material-cache";
import type { PreparedSpackMaterials, SpackMaterialPrepareInput } from "./material-client";
import { preflightSpackMaterials } from "./material-preflight";
import {
  SPACK_AUDIT_RESULT_PREFIX,
  type SpackSourceAuditReport,
  SpackSourceAuditReportSchema,
} from "./source-audit-report";
import workerSource from "./worker/source_audit.py" with { type: "text" };

export interface SpackMaterialAuditor {
  audit(
    prepared: PreparedSpackMaterials,
    input: SpackMaterialPrepareInput,
  ): Promise<SpackSourceAuditReport>;
}

interface RuntimeContext {
  hostNetworkNamespace: string;
  hostPidNamespace: string;
}

export interface SpackSourceAuditorOptions {
  profile: SpackAuditRuntimeProfile;
  process?: SpackAuditProcess;
  runtimeDeps?: SpackAuditRuntimeDeps;
  runtimeContext?: () => Promise<RuntimeContext>;
}

async function privateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  ) {
    throw new Error("Spack audit directory must be canonical and Agent-private");
  }
}

async function runtimeContext(): Promise<RuntimeContext> {
  return {
    hostNetworkNamespace: await readlink("/proc/self/ns/net"),
    hostPidNamespace: await readlink("/proc/self/ns/pid"),
  };
}

/** An opt-in source auditor, not an installation executor or a trust certificate for recipes. */
export class SpackSourceAuditor implements SpackMaterialAuditor {
  private active = false;
  private readonly process: SpackAuditProcess;

  constructor(private readonly options: SpackSourceAuditorOptions) {
    this.process = options.process ?? realSpackAuditProcess;
  }

  async audit(
    prepared: PreparedSpackMaterials,
    input: SpackMaterialPrepareInput,
  ): Promise<SpackSourceAuditReport> {
    if (this.active) throw new Error("Spack source audit is already running on this Agent");
    this.active = true;
    const deadline = AbortSignal.timeout(30 * 60_000);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    let directory: string | undefined;
    try {
      const preflight = await preflightSpackMaterials(prepared, { ...input, signal });
      if (!preflight.valid) throw new Error("Spack source audit requires a valid static lock");
      await verifySpackAuditRuntime(this.options.profile, signal, this.options.runtimeDeps);
      const context = await (this.options.runtimeContext ?? runtimeContext)();
      if (
        !/^net:\[\d+\]$/.test(context.hostNetworkNamespace) ||
        !/^pid:\[\d+\]$/.test(context.hostPidNamespace)
      ) {
        throw new Error("Spack audit cannot bind host namespaces");
      }
      const cacheDir = dirname(dirname(prepared.manifestPath));
      if (!isSpackAuditPath(cacheDir)) throw new Error("Spack audit cache path is not bind-safe");
      const cache = new SpackMaterialCache(cacheDir);
      await cache.initialize();
      const runs = join(cacheDir, "audits");
      await privateDirectory(runs);
      directory = await mkdtemp(join(runs, "run-"));
      const inputs = join(directory, "input");
      await privateDirectory(inputs);
      await privateDirectory(join(inputs, "blobs"));
      const manifestBytes = await cache.readMetadata(
        { digest: input.manifestDigest, size: prepared.manifestSize },
        2 * 1024 ** 2,
        signal,
      );
      await writeFile(join(inputs, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o400 });
      await writeFile(join(inputs, "runtime.json"), JSON.stringify(context), {
        flag: "wx",
        mode: 0o400,
      });
      await writeFile(join(inputs, "source_audit.py"), workerSource, { flag: "wx", mode: 0o400 });
      for (const blob of prepared.blobs) {
        const verified = await cache.reuse(blob, signal);
        if (!verified || verified.path !== blob.path)
          throw new Error("Spack audit material is missing");
        // Only this release's whitelisted bytes are visible; the worker rehashes each bound inode.
        await link(verified.path, join(inputs, "blobs", blob.digest.slice(7)));
      }
      signal.throwIfAborted();
      // Runtime hashing is repeated immediately before execution, never cached across operations.
      await verifySpackAuditRuntime(this.options.profile, signal, this.options.runtimeDeps);
      signal.throwIfAborted();
      const uid = this.options.runtimeDeps?.uid ?? process.getuid?.();
      const result = await this.process.run(
        buildSpackAuditCommand(this.options.profile, inputs, input.manifestDigest),
        {
          cwd: directory,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: directory,
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            XDG_RUNTIME_DIR: `/run/user/${uid}`,
            DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
          },
          timeoutMs: 30 * 60_000,
          maxOutputBytes: 2 * 1024 ** 2,
          signal,
        },
      );
      signal.throwIfAborted();
      const output = result.stdout.trim();
      if (!output.startsWith(SPACK_AUDIT_RESULT_PREFIX)) {
        throw new Error("Spack source audit failed without a valid report");
      }
      let report: SpackSourceAuditReport;
      try {
        report = SpackSourceAuditReportSchema.parse(
          JSON.parse(output.slice(SPACK_AUDIT_RESULT_PREFIX.length)),
        );
      } catch {
        throw new Error("Spack source audit returned an invalid report");
      }
      if (
        report.manifestDigest !== input.manifestDigest ||
        report.rootHash !== preflight.rootHash ||
        report.nodeCount !== preflight.nodeCount ||
        report.externalCount !== preflight.externalCount ||
        (report.passed ? result.exitCode !== 0 : result.exitCode !== 1)
      ) {
        throw new Error("Spack source audit report binding or exit status mismatch");
      }
      return report;
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        this.active = false;
      }
    }
  }
}

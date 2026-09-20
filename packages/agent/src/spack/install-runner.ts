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
import {
  SPACK_INSTALL_RESULT_PREFIX,
  type SpackInstallReport,
  SpackInstallReportSchema,
  type SpackInstallSiteProfile,
} from "./install-contract";
import { SpackMaterialCache } from "./material-cache";
import type { PreparedSpackMaterials, SpackMaterialPrepareInput } from "./material-client";
import { preflightSpackMaterials } from "./material-preflight";
import installWorker from "./worker/install_worker.py" with { type: "text" };
import auditWorker from "./worker/source_audit.py" with { type: "text" };

export interface VerifiedSpackInstallSite {
  profile: SpackInstallSiteProfile;
  digest: string;
  bytes: Uint8Array;
}

export interface SpackInstallRunner {
  run(
    action: SpackInstallReport["action"],
    prepared: PreparedSpackMaterials,
    input: SpackMaterialPrepareInput,
    site: VerifiedSpackInstallSite,
    storePath: string,
  ): Promise<SpackInstallReport>;
}

export function buildSpackInstallCommand(
  runtime: SpackAuditRuntimeProfile,
  inputs: string,
  digest: string,
  site: SpackInstallSiteProfile,
  storePath: string,
  action: SpackInstallReport["action"],
): string[] {
  const prefix = `${site.storeRoot}/releases/`;
  if (
    !storePath.startsWith(prefix) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      storePath.slice(prefix.length),
    ) ||
    !isSpackAuditPath(storePath) ||
    !["install", "verify", "load"].includes(action)
  ) {
    throw new Error("Invalid managed Spack store binding");
  }
  const command = buildSpackAuditCommand(runtime, inputs, digest);
  // Retain the audit isolation flags, replacing only its fixed Python entrypoint.
  return [
    ...command.slice(0, -5).filter((argument) => argument !== "--writable-tmpfs"),
    // Apptainer 1.4.3 otherwise adds an implied rw overlay, even without writable-tmpfs.
    "--underlay",
    "--scratch",
    "/kq/work",
    "--bind",
    `${storePath}:${storePath}:${action === "install" ? "rw" : "ro"}`,
    runtime.sifPath,
    "/opt/spack/bin/spack",
    "python",
    "/kq/input/install_worker.py",
  ];
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
    throw new Error("Managed Spack staging directory is not private");
  }
}

export class IsolatedSpackInstallRunner implements SpackInstallRunner {
  constructor(
    private readonly options: {
      runtime: SpackAuditRuntimeProfile;
      process?: SpackAuditProcess;
      runtimeDeps?: SpackAuditRuntimeDeps;
      runtimeContext?: () => Promise<{ hostNetworkNamespace: string; hostPidNamespace: string }>;
    },
  ) {}

  async run(
    action: SpackInstallReport["action"],
    prepared: PreparedSpackMaterials,
    input: SpackMaterialPrepareInput,
    site: VerifiedSpackInstallSite,
    storePath: string,
  ): Promise<SpackInstallReport> {
    const deadline = AbortSignal.timeout(30 * 60_000);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    let directory: string | undefined;
    try {
      const preflight = await preflightSpackMaterials(prepared, { ...input, signal });
      if (!preflight.valid || site.profile.target !== prepared.manifest.target) {
        throw new Error("Managed Spack target or lock mismatch");
      }
      await verifySpackAuditRuntime(this.options.runtime, signal, this.options.runtimeDeps);
      const context = this.options.runtimeContext
        ? await this.options.runtimeContext()
        : {
            hostNetworkNamespace: await readlink("/proc/self/ns/net"),
            hostPidNamespace: await readlink("/proc/self/ns/pid"),
          };
      if (
        !/^net:\[\d+\]$/.test(context.hostNetworkNamespace) ||
        !/^pid:\[\d+\]$/.test(context.hostPidNamespace)
      ) {
        throw new Error("Invalid managed Spack namespace binding");
      }
      const cacheDir = dirname(dirname(prepared.manifestPath));
      if (!isSpackAuditPath(cacheDir)) throw new Error("Invalid managed Spack cache path");
      const cache = new SpackMaterialCache(cacheDir);
      await cache.initialize();
      const runs = join(cacheDir, "installs");
      await privateDirectory(runs);
      directory = await mkdtemp(join(runs, "run-"));
      const inputs = join(directory, "input");
      await privateDirectory(inputs);
      await privateDirectory(join(inputs, "blobs"));
      const manifest = await cache.readMetadata(
        { digest: input.manifestDigest, size: prepared.manifestSize },
        2 * 1024 ** 2,
        signal,
      );
      const lockBytes = await cache.readMetadata(
        prepared.manifest.lockfile,
        16 * 1024 ** 2,
        signal,
      );
      const lock = JSON.parse(new TextDecoder().decode(lockBytes)) as {
        concrete_specs: Record<string, { name: string; version: string; external?: unknown }>;
      };
      const expectedHashes = Object.entries(lock.concrete_specs)
        .filter(([, value]) => !Object.hasOwn(value, "external"))
        .map(([hash]) => hash)
        .sort();
      const root = lock.concrete_specs[preflight.rootHash ?? ""];
      if (!root || Object.hasOwn(root, "external"))
        throw new Error("Managed Spack root cannot be external");
      const files: Record<string, string | Uint8Array> = {
        "manifest.json": manifest,
        "runtime.json": JSON.stringify(context),
        "site-profile.json": site.bytes,
        "request.json": JSON.stringify({
          version: 1,
          action,
          manifestDigest: input.manifestDigest,
          siteProfileDigest: site.digest,
          storePath,
          siteProfile: site.profile,
        }),
        "source_audit.py": auditWorker,
        "install_worker.py": installWorker,
      };
      for (const [name, bytes] of Object.entries(files)) {
        await writeFile(join(inputs, name), bytes, { mode: 0o400, flag: "wx" });
      }
      for (const blob of prepared.blobs) {
        const verified = await cache.reuse(blob, signal);
        if (!verified || verified.path !== blob.path)
          throw new Error("Missing managed Spack material");
        await link(verified.path, join(inputs, "blobs", blob.digest.slice(7)));
      }
      const stat = await lstat(storePath);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o022) !== 0 ||
        (await realpath(storePath)) !== storePath
      ) {
        throw new Error("Unsafe managed Spack store directory");
      }
      await verifySpackAuditRuntime(this.options.runtime, signal, this.options.runtimeDeps);
      signal.throwIfAborted();
      const uid = this.options.runtimeDeps?.uid ?? process.getuid?.();
      const result = await (this.options.process ?? realSpackAuditProcess).run(
        buildSpackInstallCommand(
          this.options.runtime,
          inputs,
          input.manifestDigest,
          site.profile,
          storePath,
          action,
        ),
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
      if (result.exitCode !== 0 || !result.stdout.trim().startsWith(SPACK_INSTALL_RESULT_PREFIX)) {
        throw new Error("Managed Spack worker did not complete successfully");
      }
      let report: SpackInstallReport;
      try {
        report = SpackInstallReportSchema.parse(
          JSON.parse(result.stdout.trim().slice(SPACK_INSTALL_RESULT_PREFIX.length)),
        );
      } catch {
        throw new Error("Invalid managed Spack worker report");
      }
      if (
        report.action !== action ||
        report.manifestDigest !== input.manifestDigest ||
        report.siteProfileDigest !== site.digest ||
        report.storePath !== storePath ||
        report.root.hash !== preflight.rootHash ||
        report.root.spec !== input.spec ||
        report.root.name !== root.name ||
        report.root.version !== root.version ||
        report.root.arch !== prepared.manifest.target ||
        JSON.stringify([...report.installedHashes].sort()) !== JSON.stringify(expectedHashes)
      ) {
        throw new Error("Managed Spack worker report binding mismatch");
      }
      return report;
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}

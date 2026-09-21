import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  type InstalledSpec,
  SpackMaterialManifestSchema,
  type SpackPolicy,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import {
  type SpackInstallRecord,
  SpackInstallReportSchema,
  type SpackManagedInstallation,
} from "./install-contract";
import type { SpackInstallRunner, VerifiedSpackInstallSite } from "./install-runner";
import {
  loadSpackInstallSiteProfile,
  loadSpackInstallStoreLocator,
  type SpackInstallSiteProfileOptions,
} from "./install-site-profile";
import { SpackInstallStore } from "./install-store";
import type { SoftwareOperationOutcome } from "./installer";
import { SpackMaterialCache } from "./material-cache";
import type { PreparedSpackMaterials, SpackMaterialPrepareInput } from "./material-client";
import { preflightSpackMaterials } from "./material-preflight";
import { decidePolicy } from "./policy";

interface ManagedInstallationOptions {
  cacheDir: string;
  site: SpackInstallSiteProfileOptions;
  runner: SpackInstallRunner;
  loadSite?: typeof loadSpackInstallSiteProfile;
}

const failure = (): Extract<SoftwareOperationOutcome, { outcome: "failed" }> => ({
  outcome: "failed",
  exitCode: 1,
  stderr: "Managed Spack operation failed; inspect the installation record before retrying",
});

function matchRecords(records: SpackInstallRecord[], spec: string): SpackInstallRecord[] {
  const candidates = records.filter(
    (record) =>
      record.state !== "removed" &&
      (`release:${record.id}` === spec ||
        record.spec === spec ||
        `/${record.rootHash}` === spec ||
        record.report?.root.name === spec),
  );
  const published = candidates.filter(
    (record) => record.state === "ready" || record.state === "unavailable",
  );
  return published.length ? published : candidates;
}

/** Coordinates durable metadata; recipe processes never receive this store's parent or records. */
export class ManagedSpackInstallation implements SpackManagedInstallation {
  constructor(private readonly options: ManagedInstallationOptions) {}

  private async site(signal = AbortSignal.timeout(30 * 60_000)): Promise<VerifiedSpackInstallSite> {
    const site = await (this.options.loadSite ?? loadSpackInstallSiteProfile)(
      this.options.site,
      signal,
    );
    signal.throwIfAborted();
    this.assertCacheBoundary(site.profile.storeRoot);
    return site;
  }

  private assertCacheBoundary(a: string): void {
    const b = this.options.cacheDir;
    if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
      throw new Error("Spack installation and private material cache must not overlap");
    }
  }

  private async withdrawAfterSiteFailure(
    spec: string,
    action: "install" | "load" | "uninstall" | "import_preinstalled",
    policy: SpackPolicy = { lockEnabled: false },
  ): Promise<SoftwareOperationOutcome> {
    let invalidatedHashes: string[] | undefined;
    try {
      const locator = await loadSpackInstallStoreLocator(
        this.options.site,
        AbortSignal.timeout(30_000),
      );
      this.assertCacheBoundary(locator.storeRoot);
      const store = new SpackInstallStore(locator.storeRoot);
      // Do not initialize or recreate a store while its execution profile is invalid.
      await store.withLock(async () => {
        const matches = matchRecords(await store.list(), spec);
        const record = matches[0];
        if (
          matches.length !== 1 ||
          !record ||
          record.siteProfileDigest !== locator.digest ||
          (record.state !== "ready" && record.state !== "unavailable") ||
          (action !== "import_preinstalled" && decidePolicy(record.spec, policy) !== "allow")
        ) {
          return;
        }
        invalidatedHashes = [record.rootHash];
        if (record.state === "ready") {
          await store.save({
            ...record,
            state: "unavailable",
            updatedAt: new Date().toISOString(),
          });
        }
      });
    } catch {
      return { ...failure(), ...(invalidatedHashes ? { invalidatedHashes } : {}) };
    }
    return { ...failure(), ...(invalidatedHashes ? { invalidatedHashes } : {}) };
  }

  private async store(site: VerifiedSpackInstallSite): Promise<SpackInstallStore> {
    const store = new SpackInstallStore(site.profile.storeRoot);
    await store.initialize();
    return store;
  }

  private async inventory(
    store: SpackInstallStore,
    site: VerifiedSpackInstallSite,
  ): Promise<InstalledSpec[]> {
    const result: InstalledSpec[] = [];
    for (const record of await store.list()) {
      if (record.state !== "ready" || record.siteProfileDigest !== site.digest || !record.report)
        continue;
      const path = store.path(record.id);
      for (const directory of [path, record.report.prefix]) {
        const stat = await lstat(directory);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o022) !== 0 ||
          (await realpath(directory)) !== directory
        ) {
          throw new Error("Managed Spack installed prefix is unavailable or unsafe");
        }
      }
      result.push(record.report.root);
    }
    return result;
  }

  async installedList(): Promise<InstalledSpec[]> {
    const site = await this.site();
    return this.inventory(await this.store(site), site);
  }

  async install(
    prepared: PreparedSpackMaterials,
    input: SpackMaterialPrepareInput,
  ): Promise<SoftwareOperationOutcome> {
    let invalidatedHashes: string[] | undefined;
    try {
      input.signal?.throwIfAborted();
      let site: VerifiedSpackInstallSite;
      try {
        site = await this.site(input.signal);
      } catch {
        if (input.signal?.aborted) return failure();
        return this.withdrawAfterSiteFailure(input.spec, "install");
      }
      if (prepared.manifest.target !== site.profile.target) return failure();
      const preflight = await preflightSpackMaterials(prepared, input);
      if (!preflight.valid || !preflight.rootHash) return failure();
      const rootHash = preflight.rootHash;
      const store = await this.store(site);
      return await store.withLock(async () => {
        input.signal?.throwIfAborted();
        const existing = (await store.list()).find(
          (record) =>
            (record.state === "ready" || record.state === "unavailable") &&
            (record.spec === input.spec || record.rootHash === rootHash),
        );
        if (existing) {
          if (
            existing.manifestDigest !== input.manifestDigest ||
            existing.siteProfileDigest !== site.digest
          ) {
            return {
              outcome: "rejected",
              reason:
                "A different managed release is installed; explicitly uninstall it before replacement",
            };
          }
          const result = await this.verifyExisting(
            existing,
            store,
            site,
            "verify",
            input,
            prepared,
          );
          if ("invalidatedHashes" in result) invalidatedHashes = result.invalidatedHashes;
          return result;
        }
        let record = await store.create({
          manifestDigest: input.manifestDigest,
          manifestSize: prepared.manifestSize,
          siteProfileDigest: site.digest,
          spec: input.spec,
          rootHash,
        });
        try {
          input.signal?.throwIfAborted();
          const build = await this.options.runner.run(
            "install",
            prepared,
            input,
            site,
            store.path(record.id),
          );
          this.assertReport(record, build, store, "install");
          input.signal?.throwIfAborted();
          record = { ...record, state: "verifying", updatedAt: new Date().toISOString() };
          await store.save(record);
          input.signal?.throwIfAborted();
          const report = await this.options.runner.run(
            "verify",
            prepared,
            input,
            site,
            store.path(record.id),
          );
          this.assertReport(record, report, store, "verify");
          if (
            build.prefix !== report.prefix ||
            JSON.stringify([...build.installedHashes].sort()) !==
              JSON.stringify([...report.installedHashes].sort())
          ) {
            throw new Error("Managed Spack build/verification mismatch");
          }
          await this.site(input.signal);
          input.signal?.throwIfAborted();
          await store.publishFiles(record.id);
          input.signal?.throwIfAborted();
          record = { ...record, state: "ready", report, updatedAt: new Date().toISOString() };
          await store.save(record);
          input.signal?.throwIfAborted();
          const installed = await this.inventory(store, site);
          input.signal?.throwIfAborted();
          return {
            outcome: "succeeded",
            stdout: JSON.stringify(report),
            installed,
          };
        } catch {
          // Publication can have succeeded before a later inventory error. Never delete a ready store here.
          const current = (await store.list()).find((entry) => entry.id === record.id);
          if (current && (current.state === "building" || current.state === "verifying")) {
            await store.save({ ...current, state: "failed", updatedAt: new Date().toISOString() });
            await store.removeFiles(current.id);
          } else if (current?.state === "ready" && input.signal?.aborted) {
            invalidatedHashes = [current.rootHash];
            await store.save({
              ...current,
              state: "unavailable",
              updatedAt: new Date().toISOString(),
            });
          }
          return { ...failure(), ...(invalidatedHashes ? { invalidatedHashes } : {}) };
        }
      });
    } catch {
      return { ...failure(), ...(invalidatedHashes ? { invalidatedHashes } : {}) };
    }
  }

  private assertReport(
    record: SpackInstallRecord,
    value: unknown,
    store: SpackInstallStore,
    action: "install" | "verify" | "load",
  ): void {
    const report = SpackInstallReportSchema.parse(value);
    if (
      report.action !== action ||
      report.manifestDigest !== record.manifestDigest ||
      report.siteProfileDigest !== record.siteProfileDigest ||
      report.storePath !== store.path(record.id) ||
      report.root.hash !== record.rootHash ||
      report.root.spec !== record.spec
    ) {
      throw new Error("Managed Spack report does not match its transaction");
    }
    if (record.report && record.report.prefix !== report.prefix) {
      throw new Error("Managed Spack published prefix changed");
    }
  }

  private async verifyExisting(
    record: SpackInstallRecord,
    store: SpackInstallStore,
    site: VerifiedSpackInstallSite,
    action: "verify" | "load",
    input?: SpackMaterialPrepareInput,
    materials?: PreparedSpackMaterials,
    signal?: AbortSignal,
  ): Promise<SoftwareOperationOutcome> {
    try {
      const abortSignal = input?.signal ?? signal;
      abortSignal?.throwIfAborted();
      const prepared = materials ?? (await this.materials(record, abortSignal));
      const request = input ?? {
        operationId: record.id,
        ticket: "",
        manifestDigest: record.manifestDigest,
        spec: record.spec,
        spackVersion: prepared.manifest.spackVersion,
        signal: abortSignal,
      };
      const report = await this.options.runner.run(
        action,
        prepared,
        request,
        site,
        store.path(record.id),
      );
      this.assertReport(record, report, store, action);
      await this.site(request.signal);
      request.signal?.throwIfAborted();
      if (record.state === "unavailable") {
        await store.save({
          ...record,
          state: "ready",
          report,
          updatedAt: new Date().toISOString(),
        });
      }
      request.signal?.throwIfAborted();
      const installed = await this.inventory(store, site);
      request.signal?.throwIfAborted();
      return {
        outcome: "succeeded",
        stdout: action === "load" ? (report.loadShell ?? "") : JSON.stringify(report),
        installed,
      };
    } catch {
      // Even transient verification errors withdraw readiness; recovery requires an explicit verify.
      try {
        await store.save({ ...record, state: "unavailable", updatedAt: new Date().toISOString() });
      } catch {
        return {
          outcome: "failed",
          exitCode: 1,
          invalidatedHashes: [record.rootHash],
          stderr: "Managed Spack verification failed and unavailable state could not be persisted",
        };
      }
      return {
        outcome: "failed",
        exitCode: 1,
        invalidatedHashes: [record.rootHash],
        stderr:
          "Managed Spack verification failed; release is unavailable pending explicit verification",
      };
    }
  }

  private async materials(
    record: SpackInstallRecord,
    signal?: AbortSignal,
  ): Promise<PreparedSpackMaterials> {
    signal?.throwIfAborted();
    const cache = new SpackMaterialCache(this.options.cacheDir);
    await cache.initialize();
    const bytes = await cache.readMetadata(
      { digest: record.manifestDigest, size: record.manifestSize },
      2 * 1024 ** 2,
      signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    );
    const manifest = SpackMaterialManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    const blobs = [
      ...new Map(spackMaterialBlobs(manifest).map((ref) => [ref.digest, ref])).values(),
    ];
    return {
      manifest,
      manifestDigest: record.manifestDigest,
      manifestSize: record.manifestSize,
      manifestPath: join(this.options.cacheDir, "sha256", record.manifestDigest.slice(7)),
      blobs: blobs.map((ref) => ({
        ...ref,
        path: join(this.options.cacheDir, "sha256", ref.digest.slice(7)),
      })),
    };
  }

  async operation(
    action: "load" | "uninstall" | "import_preinstalled",
    spec: string,
    policy: SpackPolicy = { lockEnabled: false },
    signal?: AbortSignal,
  ): Promise<SoftwareOperationOutcome | null> {
    let invalidatedHashes: string[] | undefined;
    try {
      signal?.throwIfAborted();
      let site: VerifiedSpackInstallSite;
      try {
        site = await this.site(signal);
      } catch {
        if (signal?.aborted) return failure();
        return this.withdrawAfterSiteFailure(spec, action, policy);
      }
      const store = await this.store(site);
      return await store.withLock(async () => {
        signal?.throwIfAborted();
        const records = (await store.list()).filter((record) => record.state !== "removed");
        const matches = matchRecords(records, spec);
        if (matches.length === 0) {
          const name = spec
            .trim()
            .split(/[@%+~^ \t]/)[0]
            ?.split(".")
            .at(-1);
          if (
            records.some(
              (record) =>
                (record.report?.root.name ??
                  record.spec
                    .split(/[@%+~^ \t]/)[0]
                    ?.split(".")
                    .at(-1)) === name,
            )
          ) {
            return {
              outcome: "rejected",
              reason: "Use the exact managed spec or full /DAG-hash selector",
            };
          }
          return null;
        }
        if (matches.length !== 1)
          return { outcome: "rejected", reason: "Managed Spack selector is ambiguous" };
        let record = matches[0];
        if (!record) throw new Error("Missing managed installation");
        if (action !== "import_preinstalled") {
          const decision = decidePolicy(record.spec, policy);
          if (decision !== "allow") return { outcome: "rejected", reason: decision.reject };
        }
        if (action === "uninstall") {
          invalidatedHashes = record.report ? [record.rootHash] : [];
          try {
            if (record.state === "building" || record.state === "verifying") {
              record = { ...record, state: "failed", updatedAt: new Date().toISOString() };
              await store.save(record);
            }
            record = { ...record, state: "removing", updatedAt: new Date().toISOString() };
            await store.save(record);
            await store.removeFiles(record.id);
            await store.save({ ...record, state: "removed", updatedAt: new Date().toISOString() });
            return {
              outcome: "succeeded",
              stdout: "",
              installed: await this.inventory(store, site),
              invalidatedHashes,
            };
          } catch {
            return { ...failure(), invalidatedHashes };
          }
        }
        if (
          (record.state !== "ready" &&
            !(record.state === "unavailable" && action === "import_preinstalled")) ||
          record.siteProfileDigest !== site.digest
        ) {
          return {
            outcome: "rejected",
            reason: "Managed Spack installation is not ready for this site profile",
          };
        }
        const result = await this.verifyExisting(
          record,
          store,
          site,
          action === "load" ? "load" : "verify",
          undefined,
          undefined,
          signal,
        );
        if ("invalidatedHashes" in result) invalidatedHashes = result.invalidatedHashes;
        return result;
      });
    } catch {
      return { ...failure(), ...(invalidatedHashes ? { invalidatedHashes } : {}) };
    }
  }
}

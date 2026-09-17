import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { TrustedReadonlyMountDriver } from "./data-market/data-delivery";

export interface LicensedMaterialMountRequest {
  selectorId: string;
  targetPath: string;
  fingerprint: string;
  requiredElements?: string[];
}

export interface LicensedMaterialResolverOptions {
  restrictedRoot: string;
  registry: Record<string, { localRelativePath: string }>;
  readonlyMountDriver?: TrustedReadonlyMountDriver;
}

export interface PreparedLicensedMaterialMount {
  selectorId: string;
  targetPath: string;
  sourcePath: string;
}

export interface LicensedMaterialCleanup {
  selectorId: string;
  targetPath: string;
}

export interface LicensedMaterialPrepareOptions {
  beforeMount?: (mount: LicensedMaterialCleanup) => Promise<void>;
}

/**
 * Resolves only provider-local licensed bytes. The Server transports selectors and
 * fingerprints, never paths or contents; bytes enter jobs only through trusted
 * read-only bind mounts.
 */
export class LicensedMaterialResolver {
  constructor(private readonly options: LicensedMaterialResolverOptions) {}

  async prepare(
    requests: LicensedMaterialMountRequest[],
    workRoot: string,
    options: LicensedMaterialPrepareOptions = {},
  ): Promise<PreparedLicensedMaterialMount[]> {
    const driver = this.options.readonlyMountDriver;
    if (!driver?.trusted) {
      throw new Error("Licensed material requires a trusted readonly mount driver");
    }
    const root = await this.restrictedRoot();
    const canonicalWorkRoot = await this.preparePrivateWorkRoot(workRoot);
    const targets = new Set<string>();
    const prepared: PreparedLicensedMaterialMount[] = [];
    try {
      for (const request of requests) {
        if (!request.selectorId.trim()) throw new Error("Licensed material selector is required");
        const mapping = this.options.registry[request.selectorId];
        if (!mapping)
          throw new Error(`Licensed material selector is not configured: ${request.selectorId}`);
        const sourcePath = await this.resolveRestrictedFile(root, mapping.localRelativePath);
        const targetPath = this.resolveTarget(canonicalWorkRoot, request.targetPath);
        if (targets.has(targetPath)) throw new Error("Licensed material target path is duplicated");
        targets.add(targetPath);
        validateRequiredElements(request.requiredElements ?? []);
        if ((await sha256(sourcePath)) !== normalizeFingerprint(request.fingerprint)) {
          throw new Error(`Licensed material fingerprint mismatch for ${request.selectorId}`);
        }
        await ensureDirectoryWithinWorkRoot(canonicalWorkRoot, dirname(targetPath));
        const targetStat = await lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (targetStat) throw new Error(`Licensed material target already exists: ${targetPath}`);
        await options.beforeMount?.({ selectorId: request.selectorId, targetPath });
        const targetHandle = await open(targetPath, "wx", 0o600);
        await targetHandle.close();
        try {
          await driver.mountReadonly(sourcePath, targetPath);
        } catch (error) {
          await unlink(targetPath).catch(() => undefined);
          throw error;
        }
        prepared.push({ selectorId: request.selectorId, targetPath, sourcePath });
      }
      return prepared;
    } catch (error) {
      try {
        await this.release(prepared);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Licensed material preparation and cleanup failed",
        );
      }
      throw error;
    }
  }

  async release(mounts: readonly LicensedMaterialCleanup[]): Promise<void> {
    const driver = this.options.readonlyMountDriver;
    if (!driver?.trusted) {
      throw new Error("Licensed material readonly mount driver is unavailable during cleanup");
    }
    const results = await Promise.allSettled(
      [...mounts].reverse().map(async (mount) => {
        const stat = await lstat(mount.targetPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!stat) return;
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`Licensed material mount was replaced: ${mount.targetPath}`);
        }
        await driver.unmount(mount.targetPath);
        await unlink(mount.targetPath);
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Licensed material mount cleanup failed");
    }
  }

  private async restrictedRoot(): Promise<string> {
    await mkdir(this.options.restrictedRoot, { recursive: true, mode: 0o700 });
    return realpath(this.options.restrictedRoot);
  }

  private async preparePrivateWorkRoot(workRoot: string): Promise<string> {
    if (!isAbsolute(workRoot)) {
      throw new Error("Licensed material work root must be an absolute Agent-managed path");
    }
    const resolved = resolve(workRoot);
    const initial = await lstat(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (initial?.isSymbolicLink()) {
      throw new Error("Licensed material work root contains a symbolic link");
    }
    if (!initial) {
      await mkdir(resolved, { recursive: true, mode: 0o700 });
    }
    const canonical = await realpath(resolved);
    const stat = await lstat(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Licensed material work root must be an Agent-managed directory");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("Licensed material work root must be private to the Agent");
    }
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error("Licensed material work root must be owned by the Agent");
    }
    return canonical;
  }

  private resolveTarget(workRoot: string, targetPath: string): string {
    if (!targetPath || isAbsolute(targetPath) || targetPath.split(/[\\/]/).includes("..")) {
      throw new Error("Licensed material target path is invalid");
    }
    const target = resolve(workRoot, targetPath);
    if (!inside(workRoot, target) || target === workRoot) {
      throw new Error("Licensed material target path escapes the Agent-managed work root");
    }
    return target;
  }

  private async resolveRestrictedFile(root: string, localRelativePath: string): Promise<string> {
    if (
      !localRelativePath ||
      localRelativePath.startsWith("/") ||
      localRelativePath.split(/[\\/]/).includes("..")
    ) {
      throw new Error("Licensed material local path is invalid");
    }
    const candidate = resolve(root, localRelativePath);
    if (!inside(root, candidate))
      throw new Error("Licensed material local path escapes restricted root");
    await assertPathHasNoSymlinks(root, candidate);
    const canonical = await realpath(candidate);
    if (!inside(root, canonical))
      throw new Error("Licensed material resolves outside restricted root");
    const stat = await lstat(canonical);
    if (!stat.isFile()) throw new Error("Licensed material must be a regular file");
    if ((stat.mode & 0o222) !== 0) {
      throw new Error("Licensed material source must be read-only");
    }
    return canonical;
  }
}

async function assertPathHasNoSymlinks(root: string, target: string): Promise<void> {
  const relativeTarget = target.slice(root.length).replace(/^[/\\]+/, "");
  let current = root;
  for (const segment of relativeTarget.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, segment);
    const value = await lstat(current);
    if (value.isSymbolicLink()) {
      throw new Error("Licensed material path contains a symbolic link");
    }
  }
}

async function ensureDirectoryWithinWorkRoot(workRoot: string, directory: string): Promise<void> {
  if (!inside(workRoot, directory)) {
    throw new Error("Licensed material target path escapes the Agent-managed work root");
  }
  const relative = directory.slice(workRoot.length).replace(/^[/\\]+/, "");
  let current = workRoot;
  for (const segment of relative.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, segment);
    const value = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!value) {
      await mkdir(current, { mode: 0o700 });
    }
    await assertDirectoryWithinWorkRoot(workRoot, current);
  }
}

async function assertDirectoryWithinWorkRoot(workRoot: string, directory: string): Promise<void> {
  const value = await lstat(directory);
  if (value.isSymbolicLink() || !value.isDirectory()) {
    throw new Error("Licensed material target path contains a symbolic link");
  }
  const canonical = await realpath(directory);
  if (!inside(workRoot, canonical)) {
    throw new Error("Licensed material target path escapes the Agent-managed work root");
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function normalizeFingerprint(fingerprint: string): string {
  return fingerprint
    .trim()
    .replace(/^sha256:/i, "")
    .toLowerCase();
}

function validateRequiredElements(elements: string[]): void {
  const trimmed = elements.map((element) => element.trim());
  const normalized = trimmed.map(
    (element) => `${element.slice(0, 1).toUpperCase()}${element.slice(1).toLowerCase()}`,
  );
  if (
    trimmed.some((element) => !/^[A-Za-z]{1,2}$/.test(element)) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error("Licensed material required elements are invalid");
  }
}

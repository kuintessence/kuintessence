import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { DataDeliveryBinding } from "@kuintessence/proto";
import type { Spawner } from "../adapters/base";
import type { AgentDataRoots } from "./local-data-security";

export interface TrustedReadonlyMountDriver {
  readonly trusted: true;
  mountReadonly(sourcePath: string, targetPath: string): Promise<void>;
  unmount(targetPath: string): Promise<void>;
}

export class LinuxBindReadonlyMountDriver implements TrustedReadonlyMountDriver {
  readonly trusted = true as const;

  constructor(private readonly spawner: Spawner) {}

  async mountReadonly(sourcePath: string, targetPath: string): Promise<void> {
    await runChecked(this.spawner, ["mount", "--bind", sourcePath, targetPath], "bind mount");
    try {
      await runChecked(
        this.spawner,
        ["mount", "-o", "remount,bind,ro", targetPath],
        "readonly bind remount",
      );
    } catch (error) {
      await this.unmount(targetPath).catch(() => undefined);
      throw error;
    }
  }

  async unmount(targetPath: string): Promise<void> {
    await runChecked(this.spawner, ["umount", targetPath], "bind unmount");
  }
}

export interface PreparedDataDelivery {
  bindingId: string;
  targetPath: string;
  method: "object-download" | "stage-copy" | "readonly-mount";
  protectedPath: boolean;
}

export interface DataDeliveryExecutorOptions {
  roots: AgentDataRoots;
  readonlyMountDriver?: TrustedReadonlyMountDriver;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface DataDeliveryPrepareOptions {
  beforeSideEffect?: (delivery: PreparedDataDelivery) => Promise<void>;
}

/**
 * Materializes immutable Data Market bindings below an Agent-owned job root.
 * It deliberately accepts only Server-resolved wire bindings; user paths never
 * become filesystem paths without both root and relative-path validation.
 */
export class DataDeliveryExecutor {
  private readonly fetchImpl: typeof fetch;
  private readonly preparedMounts = new Map<
    string,
    { jobRoot: string; items: PreparedDataDelivery[] }
  >();
  private readonly now: () => number;

  constructor(private readonly options: DataDeliveryExecutorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async prepare(
    jobId: string,
    bindings: readonly DataDeliveryBinding[],
    options: DataDeliveryPrepareOptions = {},
  ): Promise<PreparedDataDelivery[]> {
    const jobRoot = await this.options.roots.prepareJobRoot(jobId);
    const prepared: PreparedDataDelivery[] = [];
    try {
      for (const binding of bindings) {
        this.assertLeaseValid(binding);
        prepared.push(...(await this.prepareOne(jobRoot, binding, options)));
      }
      const previous = this.preparedMounts.get(jobId);
      this.preparedMounts.set(jobId, {
        jobRoot,
        items: [...(previous?.items ?? []), ...prepared],
      });
      return prepared;
    } catch (error) {
      await this.releasePrepared(jobRoot, prepared);
      throw error;
    }
  }

  async release(jobId: string): Promise<void> {
    const prepared = this.preparedMounts.get(jobId);
    this.preparedMounts.delete(jobId);
    if (prepared) await this.releasePrepared(prepared.jobRoot, prepared.items);
  }

  async recover(
    jobId: string,
    protectedDeliveries: readonly PreparedDataDelivery[],
  ): Promise<void> {
    const jobRoot = await this.options.roots.prepareJobRoot(jobId);
    const recovered: PreparedDataDelivery[] = [];
    for (const delivery of protectedDeliveries) {
      assertInside(jobRoot, delivery.targetPath, "Persisted protected data path");
      recovered.push({ ...delivery, protectedPath: true });
    }
    if (recovered.length > 0) this.preparedMounts.set(jobId, { jobRoot, items: recovered });
  }

  private async prepareOne(
    jobRoot: string,
    binding: DataDeliveryBinding,
    options: DataDeliveryPrepareOptions,
  ): Promise<PreparedDataDelivery[]> {
    const method = deliveryMethod(binding);
    const stageRoot = resolveTarget(jobRoot, binding.stagePath);
    if (!binding.bindingId || !binding.versionId || !binding.manifestDigest) {
      throw new Error("Data delivery binding is missing immutable identifiers");
    }
    this.assertLeaseValid(binding);
    if (binding.selectedEntries.length === 0)
      throw new Error("Data delivery binding has no manifest entries");
    if (method === "object-download") {
      if (binding.managedRootId || binding.relativePath) {
        throw new Error("Object data delivery must not contain CP-local path fields");
      }
      const prepared: PreparedDataDelivery[] = [];
      try {
        for (const entry of binding.selectedEntries) {
          if (!entry.objectDownloadUrl) {
            throw new Error("Object data delivery entry is missing a presigned URL");
          }
          const target = resolveTarget(stageRoot, entry.path);
          const cleanup: PreparedDataDelivery = {
            bindingId: binding.bindingId,
            targetPath: target,
            method,
            protectedPath: binding.restricted,
          };
          await options.beforeSideEffect?.(cleanup);
          this.assertLeaseValid(binding);
          await downloadVerified(
            this.fetchImpl,
            entry.objectDownloadUrl,
            target,
            entry.sha256,
            entry.sizeBytes,
          );
          this.assertLeaseValid(binding);
          prepared.push(cleanup);
        }
        return prepared;
      } catch (error) {
        await this.releasePrepared(jobRoot, prepared);
        throw error;
      }
    }
    if (!binding.managedRootId || !binding.relativePath) {
      throw new Error("CP-local data delivery is missing its managed root selector");
    }
    const sourceRoot = await this.options.roots.resolveManagedDataPath(
      binding.managedRootId,
      binding.relativePath,
    );
    const prepared: PreparedDataDelivery[] = [];
    try {
      for (const entry of binding.selectedEntries) {
        const source = resolveTarget(sourceRoot, entry.path);
        await verifyLocalEntry(source, entry.sha256, entry.sizeBytes);
        const target = resolveTarget(stageRoot, entry.path);
        const cleanup: PreparedDataDelivery = {
          bindingId: binding.bindingId,
          targetPath: target,
          method,
          protectedPath: method === "readonly-mount",
        };
        if (method === "stage-copy") {
          if (binding.restricted)
            throw new Error("Restricted CP-local data requires a readonly mount");
          await options.beforeSideEffect?.(cleanup);
          this.assertLeaseValid(binding);
          await copyManagedData(source, target);
          await verifyLocalEntry(target, entry.sha256, entry.sizeBytes).catch(async (error) => {
            await removeDeliveryTarget(jobRoot, target);
            throw error;
          });
          prepared.push(cleanup);
          continue;
        }
        if (method !== "readonly-mount") throw new Error("Unsupported data delivery method");
        const driver = this.options.readonlyMountDriver;
        if (!driver?.trusted)
          throw new Error("Readonly data delivery requires a trusted mount driver");
        await options.beforeSideEffect?.(cleanup);
        this.assertLeaseValid(binding);
        try {
          await createMountTarget(source, target);
          await driver.mountReadonly(source, target);
          await verifyLocalEntry(source, entry.sha256, entry.sizeBytes);
        } catch (error) {
          await driver.unmount(target).catch(() => undefined);
          await removeDeliveryTarget(jobRoot, target);
          throw error;
        }
        prepared.push(cleanup);
      }
      return prepared;
    } catch (error) {
      await this.releasePrepared(jobRoot, prepared);
      throw error;
    }
  }

  private assertLeaseValid(binding: DataDeliveryBinding): void {
    if (!binding.leaseId || !/^[a-f0-9-]{36}$/i.test(binding.leaseId)) {
      throw new Error("Data delivery lease is missing or invalid");
    }
    if (binding.leaseExpiresAtUnixMs <= BigInt(this.now())) {
      throw new Error("Data delivery lease has expired");
    }
  }

  private async releasePrepared(
    jobRoot: string,
    prepared: readonly PreparedDataDelivery[],
  ): Promise<void> {
    const driver = this.options.readonlyMountDriver;
    const results = await Promise.allSettled(
      [...prepared].reverse().map(async (item) => {
        if (item.method === "readonly-mount") {
          if (!driver) throw new Error("Readonly data mount driver is unavailable during cleanup");
          const target = await lstat(item.targetPath).catch(() => undefined);
          if (target) await driver.unmount(item.targetPath);
        }
        await removeDeliveryTarget(jobRoot, item.targetPath);
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Data delivery cleanup failed");
    }
  }
}

function deliveryMethod(binding: DataDeliveryBinding): PreparedDataDelivery["method"] {
  switch (binding.method) {
    case 1:
      return "object-download";
    case 2:
      return "stage-copy";
    case 3:
      return "readonly-mount";
    default:
      throw new Error("Data delivery binding method is unspecified");
  }
}

function resolveTarget(root: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("Data delivery target path must be relative without parent traversal");
  }
  const target = resolve(root, path);
  assertInside(root, target, "Data delivery target path");
  return target;
}

function assertInside(root: string, target: string, label: string): void {
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escapes the Agent job root`);
  }
}

async function downloadVerified(
  fetchImpl: typeof fetch,
  url: string,
  target: string,
  expectedSha256: string,
  expectedSize: bigint,
): Promise<void> {
  if (!/^https?:\/\//.test(url)) throw new Error("Data object URL must be HTTP(S)");
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error("Data delivery digest is invalid");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await assertNoSymlinkAncestor(dirname(target));
  const temporary = `${target}.part-${randomUUID()}`;
  try {
    const response = await fetchImpl(url, { redirect: "error" });
    if (!response.ok || !response.body) {
      throw new Error(`Data object download failed with HTTP ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && BigInt(contentLength) !== expectedSize) {
      throw new Error("Downloaded data content length does not match");
    }
    const hash = createHash("sha256");
    let size = 0n;
    const handle = await open(temporary, "wx", 0o600);
    try {
      const reader = response.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += BigInt(next.value.byteLength);
        if (size > expectedSize) {
          await reader.cancel("Data object exceeds the frozen manifest size");
          throw new Error("Downloaded data exceeds the frozen manifest size");
        }
        hash.update(next.value);
        await handle.write(next.value);
      }
    } finally {
      await handle.close();
    }
    const digest = hash.digest("hex");
    if (digest !== expectedSha256.toLowerCase())
      throw new Error("Downloaded data digest does not match");
    if (size !== expectedSize) throw new Error("Downloaded data size does not match");
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function copyManagedData(source: string, target: string): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink())
    throw new Error("CP-local data source cannot be a symbolic link");
  if (sourceStat.isDirectory()) {
    try {
      await copyDirectory(source, target);
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
    return;
  }
  if (!sourceStat.isFile())
    throw new Error("CP-local data source must be a regular file or directory");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await assertNoSymlinkAncestor(dirname(target));
  const existing = await lstat(target).catch(() => undefined);
  if (existing) throw new Error("CP-local delivery target must not already exist");
  const temporary = `${target}.part-${randomUUID()}`;
  try {
    await copyFile(source, temporary, 0);
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function verifyLocalEntry(
  source: string,
  expectedSha256: string,
  expectedSize: bigint,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error("Data delivery digest is invalid");
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("CP-local selected data entry must be a regular non-symlink file");
  }
  if (BigInt(sourceStat.size) !== expectedSize)
    throw new Error("CP-local data size does not match");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  const digest = hash.digest("hex");
  if (digest !== expectedSha256.toLowerCase())
    throw new Error("CP-local data digest does not match");
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourceChild = resolve(source, entry.name);
    const targetChild = resolve(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error("CP-local data source contains a symbolic link");
    if (entry.isDirectory()) {
      await copyDirectory(sourceChild, targetChild);
    } else if (entry.isFile()) {
      await copyFile(sourceChild, targetChild);
    } else {
      throw new Error("CP-local data source contains a non-regular entry");
    }
  }
}

async function createMountTarget(source: string, target: string): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink())
    throw new Error("Readonly mount source cannot be a symbolic link");
  if (sourceStat.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    await assertNoSymlinkAncestor(target);
    return;
  }
  if (!sourceStat.isFile()) throw new Error("Readonly mount source must be regular data");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await assertNoSymlinkAncestor(dirname(target));
  await Bun.write(target, new Uint8Array());
}

async function runChecked(spawner: Spawner, argv: string[], label: string): Promise<void> {
  const result = await spawner.run(argv, { timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed: ${result.stderr.trim() || result.stdout.trim() || result.exitCode}`,
    );
  }
}

async function assertNoSymlinkAncestor(path: string): Promise<void> {
  let current = path;
  while (true) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw new Error("Data delivery target ancestor cannot be a symbolic link");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function removeDeliveryTarget(jobRoot: string, targetPath: string): Promise<void> {
  assertInside(jobRoot, targetPath, "Data delivery cleanup target");
  const target = await lstat(targetPath).catch(() => undefined);
  if (!target) return;
  if (target.isSymbolicLink()) {
    throw new Error("Data delivery cleanup refuses a symbolic link target");
  }
  await rm(targetPath, { recursive: target.isDirectory(), force: true });
}

import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SpackAuditRuntimeProfile } from "./audit-runtime";
import {
  SpackInstallPathSchema,
  type SpackInstallSiteProfile,
  SpackInstallSiteProfileSchema,
} from "./install-contract";

const PROFILE_MAXIMUM = 128 * 1024;
const HOST_MAXIMUM = 16 * 1024 ** 3;
const FAILURE = "Spack install site profile verification failed";
const ABORTED = "Spack install site profile load aborted";
const digestPattern = /^[a-f0-9]{64}$/;

export interface SpackInstallSiteProfileOptions {
  path: string;
  sha256: string;
  runtime: SpackAuditRuntimeProfile;
  inspect?: (
    path: string,
    maximum: number,
    collect: boolean,
    signal: AbortSignal,
  ) => Promise<{ sha256: string; bytes?: Uint8Array }>;
}

type Inspect = NonNullable<SpackInstallSiteProfileOptions["inspect"]>;
interface ProtectedResolution {
  original: string;
  canonical: string;
  entry: BigIntStats;
  snapshots: Map<string, BigIntStats>;
  bindings: Set<string>;
}

function requireValid(valid: boolean): asserts valid {
  if (!valid) throw new Error(FAILURE);
}

function sameIdentity(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function protectedEntry(entry: BigIntStats): boolean {
  return entry.uid === 0n && (entry.mode & 0o022n) === 0n;
}

async function verifyResolution(
  resolution: ProtectedResolution,
  signal: AbortSignal,
): Promise<void> {
  for (const [path, before] of resolution.snapshots) {
    signal.throwIfAborted();
    requireValid(sameIdentity(before, await lstat(path, { bigint: true })));
  }
  requireValid((await realpath(resolution.original)) === resolution.canonical);
  signal.throwIfAborted();
}

async function resolveProtectedFile(
  path: string,
  signal: AbortSignal,
): Promise<ProtectedResolution> {
  signal.throwIfAborted();
  requireValid(SpackInstallPathSchema.safeParse(path).success);
  let current = "/";
  let entry = await lstat(current, { bigint: true });
  requireValid(entry.isDirectory() && protectedEntry(entry));
  const snapshots = new Map([[current, entry]]);
  const bindings = new Set([path]);
  const pending = path.split("/").slice(1);
  let links = 0;

  // Check the entire resolution chain, not only realpath's final target.
  while (pending.length) {
    signal.throwIfAborted();
    const part = pending.shift();
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, part);
    entry = await lstat(candidate, { bigint: true });
    const previous = snapshots.get(candidate);
    requireValid(!previous || sameIdentity(previous, entry));
    snapshots.set(candidate, entry);
    if (entry.isSymbolicLink()) {
      // POSIX symlink mode bits are not access controls; the link's owner and
      // protected containing directory control replacement of the link.
      requireValid(entry.uid === 0n && ++links <= 40);
      bindings.add(candidate);
      const target = await readlink(candidate);
      requireValid(target.length <= 4096 && /^[A-Za-z0-9_+./-]+$/.test(target));
      if (target.startsWith("/")) current = "/";
      pending.unshift(...target.split("/"));
    } else {
      requireValid(protectedEntry(entry));
      requireValid(pending.length ? entry.isDirectory() : entry.isFile());
      current = candidate;
    }
  }
  const canonical = await realpath(path);
  requireValid(canonical === current && SpackInstallPathSchema.safeParse(canonical).success);
  entry = await lstat(canonical, { bigint: true });
  const previous = snapshots.get(canonical);
  requireValid(!!previous && sameIdentity(previous, entry) && entry.isFile());
  bindings.add(canonical);
  const resolution = { original: path, canonical, entry, snapshots, bindings };
  await verifyResolution(resolution, signal);
  return resolution;
}

async function inspectProtectedFile(
  path: string,
  maximum: number,
  collect: boolean,
  signal: AbortSignal,
  resolutions: ProtectedResolution[],
): ReturnType<Inspect> {
  const resolution = await resolveProtectedFile(path, signal);
  const limit = Math.min(maximum, collect ? PROFILE_MAXIMUM : HOST_MAXIMUM);
  requireValid(resolution.entry.size >= 0n && resolution.entry.size <= BigInt(limit));
  signal.throwIfAborted();
  const handle = await open(
    resolution.canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    signal.throwIfAborted();
    const opened = await handle.stat({ bigint: true });
    requireValid(opened.isFile() && sameIdentity(resolution.entry, opened));
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = collect ? new Uint8Array(Number(opened.size)) : undefined;
    let total = 0;
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, limit - total + 1),
      );
      signal.throwIfAborted();
      if (!bytesRead) break;
      requireValid(total + bytesRead <= limit && total + bytesRead <= Number(opened.size));
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      bytes?.set(chunk, total);
      total += bytesRead;
    }
    requireValid(total === Number(opened.size));
    requireValid(sameIdentity(opened, await handle.stat({ bigint: true })));
    await verifyResolution(resolution, signal);
    resolutions.push(resolution);
    return { sha256: hash.digest("hex"), ...(bytes ? { bytes } : {}) };
  } finally {
    await handle.close();
  }
}

async function inspectWithAbort(
  inspect: Inspect,
  path: string,
  maximum: number,
  collect: boolean,
  signal: AbortSignal,
): ReturnType<Inspect> {
  signal.throwIfAborted();
  let onAbort = () => {};
  const canceled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(ABORTED));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const inspection = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return inspect(path, maximum, collect, signal);
    });
    const result = await Promise.race([inspection, canceled]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function overlaps(first: string, second: string): boolean {
  return (
    first === second ||
    first === "/" ||
    second === "/" ||
    first.startsWith(`${second}/`) ||
    second.startsWith(`${first}/`)
  );
}

async function canonicalStorePath(path: string, signal: AbortSignal): Promise<string> {
  const missing: string[] = [];
  let ancestor = path;
  while (true) {
    signal.throwIfAborted();
    let entry: BigIntStats;
    try {
      entry = await lstat(ancestor, { bigint: true });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      requireValid(parent !== ancestor);
      missing.unshift(ancestor.slice(parent === "/" ? 1 : parent.length + 1));
      ancestor = parent;
      continue;
    }
    // Do not reinterpret broken links or non-directory ancestors as missing.
    const canonical = await realpath(ancestor);
    if (entry.isSymbolicLink()) entry = await lstat(canonical, { bigint: true });
    requireValid(entry.isDirectory());
    return join(canonical, ...missing);
  }
}

export interface SpackInstallStoreLocator {
  storeRoot: string;
  digest: string;
}

export async function loadSpackInstallStoreLocator(
  options: SpackInstallSiteProfileOptions,
  signal: AbortSignal,
): Promise<SpackInstallStoreLocator> {
  const site = await inspectSiteProfile(options, signal, false);
  return { storeRoot: site.profile.storeRoot, digest: site.digest };
}

export async function loadSpackInstallSiteProfile(
  options: SpackInstallSiteProfileOptions,
  signal: AbortSignal,
): Promise<{ profile: SpackInstallSiteProfile; digest: string; bytes: Uint8Array }> {
  return inspectSiteProfile(options, signal, true);
}

async function inspectSiteProfile(
  options: SpackInstallSiteProfileOptions,
  signal: AbortSignal,
  verifyHostContents: boolean,
): Promise<{ profile: SpackInstallSiteProfile; digest: string; bytes: Uint8Array }> {
  try {
    signal.throwIfAborted();
    const { path, sha256 } = options;
    const runtime = { ...options.runtime };
    requireValid(
      SpackInstallPathSchema.safeParse(path).success &&
        digestPattern.test(sha256) &&
        SpackInstallPathSchema.safeParse(runtime.apptainerPath).success &&
        SpackInstallPathSchema.safeParse(runtime.sifPath).success &&
        digestPattern.test(runtime.apptainerSha256) &&
        digestPattern.test(runtime.sifSha256) &&
        runtime.apptainerPath !== runtime.sifPath,
    );
    const resolutions: ProtectedResolution[] = [];
    const injected = options.inspect;
    const inspect: Inspect =
      injected ??
      ((file, maximum, collect, abortSignal) =>
        inspectProtectedFile(file, maximum, collect, abortSignal, resolutions));
    const inspected = await inspectWithAbort(inspect, path, PROFILE_MAXIMUM, true, signal);
    requireValid(
      inspected.sha256 === sha256 &&
        inspected.bytes instanceof Uint8Array &&
        inspected.bytes.byteLength <= PROFILE_MAXIMUM,
    );
    // Own the bytes before hashing so an injected reader cannot mutate them
    // during subsequent awaits. Parsing never reserializes the pinned input.
    const bytes = Uint8Array.from(inspected.bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    requireValid(digest === sha256);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const profile = SpackInstallSiteProfileSchema.parse(JSON.parse(text));
    requireValid(profile.runtimeSifSha256 === runtime.sifSha256);
    const trustedPaths = [
      path,
      runtime.apptainerPath,
      runtime.sifPath,
      "/etc/os-release",
      ...profile.hostFiles.map((file) => file.path),
    ];
    requireValid(trustedPaths.every((file) => !overlaps(profile.storeRoot, file)));

    // An injected inspector owns filesystem trust. The default additionally
    // rejects aliases between the writable store and protected resolution chains.
    const store = injected
      ? profile.storeRoot
      : await canonicalStorePath(profile.storeRoot, signal);
    if (!injected) {
      for (const file of [runtime.apptainerPath, runtime.sifPath]) {
        resolutions.push(await resolveProtectedFile(file, signal));
      }
    }
    for (const pin of [
      { path: "/etc/os-release", sha256: profile.osReleaseSha256 },
      ...profile.hostFiles,
    ]) {
      if (verifyHostContents) {
        const result = await inspectWithAbort(inspect, pin.path, HOST_MAXIMUM, false, signal);
        requireValid(result.sha256 === pin.sha256);
      } else if (!injected) {
        // A locator can only withdraw metadata, never authorize worker execution.
        // Retain every path/alias check even when host content has drifted.
        resolutions.push(await resolveProtectedFile(pin.path, signal));
      }
    }
    if (!injected) {
      for (const resolution of resolutions) {
        requireValid(
          [...resolution.bindings].every(
            (file) => !overlaps(profile.storeRoot, file) && !overlaps(store, file),
          ),
        );
        await verifyResolution(resolution, signal);
      }
      requireValid((await canonicalStorePath(profile.storeRoot, signal)) === store);
    }
    signal.throwIfAborted();
    return { profile, digest: `sha256:${digest}`, bytes };
  } catch {
    // Never expose filesystem paths, parser input, injected errors or abort reasons.
    const error = new Error(signal.aborted ? ABORTED : FAILURE);
    if (signal.aborted) error.name = "AbortError";
    throw error;
  }
}

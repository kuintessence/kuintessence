import { dirname, join } from "node:path";
import {
  inspectSpackLock,
  SPACK_LOCK_MAX_BYTES,
  type SpackLockReport,
  SpackMaterialManifestSchema,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import { SpackMaterialCache } from "./material-cache";
import type { PreparedSpackMaterials, SpackMaterialPrepareInput } from "./material-client";

/**
 * Re-read authoritative cached bytes instead of trusting an in-memory provider result.
 * This is structural preflight only; no recipe is imported and no process is launched.
 */
export async function preflightSpackMaterials(
  prepared: PreparedSpackMaterials,
  input: SpackMaterialPrepareInput,
): Promise<SpackLockReport> {
  const deadline = AbortSignal.timeout(60_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  signal.throwIfAborted();
  if (prepared.manifestDigest !== input.manifestDigest) {
    throw new Error("Spack preflight manifest digest binding mismatch");
  }
  const cacheDir = dirname(dirname(prepared.manifestPath));
  const cache = new SpackMaterialCache(cacheDir);
  const cachePath = (digest: string) => join(cacheDir, "sha256", digest.slice(7));
  if (prepared.manifestPath !== cachePath(input.manifestDigest)) {
    throw new Error("Spack preflight manifest is outside its digest cache");
  }
  const manifest = SpackMaterialManifestSchema.parse(prepared.manifest);
  if (manifest.spec !== input.spec || manifest.spackVersion !== input.spackVersion) {
    throw new Error("Spack preflight spec/Spack version binding mismatch");
  }
  const references = new Map(spackMaterialBlobs(manifest).map((blob) => [blob.digest, blob]));
  const cached = new Map(prepared.blobs.map((blob) => [blob.digest, blob]));
  if (cached.size !== prepared.blobs.length || cached.size !== references.size) {
    throw new Error("Spack preflight cache references are incomplete or duplicated");
  }
  for (const blob of references.values()) {
    const ref = cached.get(blob.digest);
    if (!ref || ref.size !== blob.size || ref.path !== cachePath(blob.digest)) {
      throw new Error("Spack preflight blob binding mismatch");
    }
  }
  // Hash the same bounded buffer that is parsed; never verify then re-open an unchecked file.
  const manifestBytes = await cache.readMetadata(
    { digest: input.manifestDigest, size: prepared.manifestSize },
    2 * 1024 ** 2,
    signal,
  );
  const storedManifest = SpackMaterialManifestSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
  );
  if (JSON.stringify(storedManifest) !== JSON.stringify(manifest)) {
    throw new Error("Spack preflight cached manifest differs from prepared metadata");
  }
  const lockBytes = await cache.readMetadata(manifest.lockfile, SPACK_LOCK_MAX_BYTES, signal);
  signal.throwIfAborted();
  return inspectSpackLock(lockBytes, manifest);
}

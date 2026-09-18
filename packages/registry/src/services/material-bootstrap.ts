import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  SPACK_MATERIAL_IMPORT_MAX_BYTES,
  type SpackMaterialBinding,
  SpackMaterialImportSchema,
} from "@kuintessence/shared";
import {
  inspectMaterialImportFile,
  openMaterialImportFile,
  readMaterialImportManifest,
} from "./material-import-files";
import type { SpackMaterialStore } from "./spack-material-store";

export type MaterialBootstrapStore = Pick<SpackMaterialStore, "upload" | "publish" | "limits">;
export type MaterialBootstrapResult = {
  repository: string;
  spec: string;
  target: string;
} & (
  | { status: "published"; binding: SpackMaterialBinding }
  | { status: "failed"; error: "material-import-failed" }
);
const actor = { sub: "registry-material-bootstrap", role: "super_admin", orgIds: [] } as const;

export async function bootstrapSpackMaterials(
  store: MaterialBootstrapStore,
  manifestPath: string,
  signal = AbortSignal.timeout(24 * 60 * 60_000),
): Promise<MaterialBootstrapResult[]> {
  if (!isAbsolute(manifestPath) || resolve(manifestPath) !== manifestPath) {
    throw new Error("Material bootstrap manifest must be an absolute canonical local path");
  }
  const root = dirname(manifestPath);
  const manifest = SpackMaterialImportSchema.parse(
    await readMaterialImportManifest(
      root,
      basename(manifestPath),
      SPACK_MATERIAL_IMPORT_MAX_BYTES,
      signal,
    ),
  );
  // Reject the entire input layout before any upload; content/publication failures are per release.
  for (const file of manifest.files) {
    await inspectMaterialImportFile(
      root,
      file.path,
      file.blob.size,
      store.limits.maxBlobBytes,
      signal,
    );
  }
  const files = new Map(manifest.files.map((file) => [file.blob.digest, file]));
  const uploaded = new Set<string>();
  const results: MaterialBootstrapResult[] = [];
  for (const release of manifest.releases) {
    signal.throwIfAborted();
    const identity = { repository: release.repository, spec: release.spec, target: release.target };
    try {
      const references = [release.lockfile, ...release.sources.map((source) => source.blob)];
      for (const blob of references) {
        signal.throwIfAborted();
        const key = `${release.repository}:${blob.digest}`;
        if (uploaded.has(key)) continue;
        const file = files.get(blob.digest);
        if (!file) throw new Error("Missing material import file");
        const stream = await openMaterialImportFile(
          root,
          file.path,
          blob.size,
          store.limits.maxBlobBytes,
          signal,
        );
        try {
          const uploadedBlob = await store.upload(release.repository, blob.digest, stream);
          if (uploadedBlob.digest !== blob.digest || uploadedBlob.size !== blob.size) {
            throw new Error("Material import upload binding changed");
          }
          uploaded.add(key);
        } finally {
          if (!stream.locked) await stream.cancel();
        }
      }
      signal.throwIfAborted();
      const binding = await store.publish(release, { ...actor, orgIds: [] }, signal);
      signal.throwIfAborted();
      results.push({ ...identity, status: "published", binding });
    } catch {
      signal.throwIfAborted();
      results.push({ ...identity, status: "failed", error: "material-import-failed" });
    }
  }
  return results;
}

import {
  SPACK_MATERIAL_IMPORT_MAX_BYTES,
  type SpackMaterialBinding,
  type SpackMaterialImport,
  SpackMaterialImportSchema,
  SpackMaterialPathSchema,
  spackMaterialInputBlobs,
} from "@kuintessence/shared/browser";
import {
  getSpackMaterialImportStatus,
  publishSpackMaterial,
  uploadSpackMaterial,
} from "./spack-materials-client";

export class MaterialPackError extends Error {
  constructor(readonly code: "invalidManifest" | "invalidFiles" | "accessChanged") {
    super(code);
    this.name = "MaterialPackError";
  }
}

export class MissingMaterialFiles extends Error {
  constructor(readonly paths: string[]) {
    super("Missing material files");
  }
}

export async function readMaterialPack(
  file: File,
  signal?: AbortSignal,
): Promise<SpackMaterialImport> {
  signal?.throwIfAborted();
  if (file.size === 0 || file.size > SPACK_MATERIAL_IMPORT_MAX_BYTES) {
    throw new MaterialPackError("invalidManifest");
  }
  try {
    const bytes = await file.arrayBuffer();
    signal?.throwIfAborted();
    if (bytes.byteLength !== file.size) throw new MaterialPackError("invalidManifest");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return SpackMaterialImportSchema.parse(JSON.parse(text));
  } catch {
    signal?.throwIfAborted();
    throw new MaterialPackError("invalidManifest");
  }
}

export function matchMaterialFiles(
  pack: SpackMaterialImport,
  selected: readonly File[],
  mode: "files" | "directory",
  manifestName: string,
): Map<string, File> {
  if (selected.length > 20_001) throw new MaterialPackError("invalidFiles");
  const expected = new Map(pack.files.map((entry) => [entry.path, entry.blob]));
  const seen = new Set<string>();
  const matched = new Map<string, File>();
  let directory: string | undefined;
  for (const file of selected) {
    let path = file.name;
    if (mode === "directory") {
      const [root, ...segments] = file.webkitRelativePath.split("/");
      if (!root || root === "." || root === ".." || !segments.length) {
        throw new MaterialPackError("invalidFiles");
      }
      if (directory && directory !== root) throw new MaterialPackError("invalidFiles");
      directory = root;
      path = segments.join("/");
    }
    if (!SpackMaterialPathSchema.safeParse(path).success || seen.has(path)) {
      throw new MaterialPackError("invalidFiles");
    }
    seen.add(path);
    const blob = expected.get(path);
    if (!blob && mode === "directory" && path === manifestName) continue;
    if (!blob || file.size !== blob.size) throw new MaterialPackError("invalidFiles");
    matched.set(blob.digest, file);
  }
  return matched;
}

export interface MaterialImportProgress {
  index: number;
  status: "uploading" | "publishing" | "published" | "failed" | "interrupted" | "uncertain";
  verifiedFiles: number;
  totalFiles: number;
  binding?: SpackMaterialBinding;
  error?: unknown;
}

interface MaterialImportOptions {
  pack: SpackMaterialImport;
  files: ReadonlyMap<string, File>;
  indices: readonly number[];
  signal: AbortSignal;
  canWriteRepository: (repository: string) => boolean;
  onProgress: (progress: MaterialImportProgress) => void;
}

interface MaterialImportClient {
  status: typeof getSpackMaterialImportStatus;
  upload: typeof uploadSpackMaterial;
  publish: typeof publishSpackMaterial;
}

function errorStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}

export async function runMaterialImport(
  options: MaterialImportOptions,
  client: MaterialImportClient = {
    status: getSpackMaterialImportStatus,
    upload: uploadSpackMaterial,
    publish: publishSpackMaterial,
  },
): Promise<void> {
  const { signal, canWriteRepository, onProgress } = options;
  signal.throwIfAborted();
  const pack = SpackMaterialImportSchema.parse(options.pack);
  const files = new Map(options.files);
  const indices = [...options.indices];
  const checkAccess = (repository: string) => {
    signal.throwIfAborted();
    if (!canWriteRepository(repository)) throw new MaterialPackError("accessChanged");
  };
  const expected = new Map(pack.files.map((entry) => [entry.blob.digest, entry]));
  for (const [digest, file] of files) {
    if (file.size !== expected.get(digest)?.blob.size) throw new MaterialPackError("invalidFiles");
  }
  function requireFiles(missing: Iterable<string>) {
    const absent: string[] = [];
    for (const digest of missing) {
      const path = expected.get(digest)?.path;
      if (!path) throw new MaterialPackError("invalidManifest");
      if (!files.has(digest)) absent.push(path);
    }
    if (absent.length) throw new MissingMaterialFiles(absent);
  }
  if (new Set(indices).size !== indices.length) throw new MaterialPackError("invalidManifest");
  const pending = indices.map((index) => {
    const release = pack.releases[index];
    if (!Number.isInteger(index) || !release) throw new MaterialPackError("invalidManifest");
    checkAccess(release.repository);
    return { index, release };
  });
  const recovered = new Set<number>();
  function reportPublished(index: number, totalFiles: number, binding: SpackMaterialBinding) {
    onProgress({ index, totalFiles, verifiedFiles: totalFiles, status: "published", binding });
  }
  // A later release can require the same digest in another repository. Check the whole
  // partial selection before writing, then use fresh receipts as each release runs.
  if (files.size < pack.files.length && indices.length > 1) {
    const missing = new Set<string>();
    for (const { index, release } of pending) {
      const references = spackMaterialInputBlobs(release);
      if (references.every((blob) => files.has(blob.digest))) continue;
      checkAccess(release.repository);
      const status = await client.status(release, signal);
      checkAccess(release.repository);
      if (status.state === "published") {
        reportPublished(index, references.length, status.binding);
        recovered.add(index);
      } else {
        for (const digest of status.missing) missing.add(digest);
      }
    }
    requireFiles(missing);
  }
  for (const { index, release } of pending) {
    if (recovered.has(index)) continue;
    checkAccess(release.repository);
    const references = spackMaterialInputBlobs(release);
    const progress = { index, verifiedFiles: 0, totalFiles: references.length };
    let publishing = false;
    try {
      onProgress({ ...progress, status: "uploading" });
      const status = await client.status(release, signal);
      checkAccess(release.repository);
      if (status.state === "published") {
        reportPublished(index, references.length, status.binding);
        continue;
      }
      const missing = new Set(status.missing);
      requireFiles(missing);
      for (const blob of references) {
        checkAccess(release.repository);
        if (missing.has(blob.digest)) {
          const file = files.get(blob.digest);
          if (!file) throw new MaterialPackError("invalidFiles");
          const receipt = await client.upload(release.repository, blob, file, signal, checkAccess);
          checkAccess(release.repository);
          if (receipt.digest !== blob.digest || receipt.size !== blob.size) {
            throw new MaterialPackError("invalidFiles");
          }
        }
        progress.verifiedFiles++;
        onProgress({ ...progress, status: "uploading" });
      }
      checkAccess(release.repository);
      publishing = true;
      onProgress({ ...progress, status: "publishing" });
      const binding = await client.publish(release, signal);
      checkAccess(release.repository);
      onProgress({ ...progress, status: "published", binding });
    } catch (error) {
      const interrupted = signal.aborted || !canWriteRepository(release.repository);
      const status = errorStatus(error);
      const uncertain =
        publishing && (interrupted || status === undefined || status >= 500 || status === 408);
      onProgress({
        ...progress,
        status: uncertain ? "uncertain" : interrupted ? "interrupted" : "failed",
        error,
      });
      if (error instanceof MissingMaterialFiles && !interrupted) throw error;
      if (interrupted || status === 401 || status === 403) {
        throw new MaterialPackError("accessChanged");
      }
    }
  }
}

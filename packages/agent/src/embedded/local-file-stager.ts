import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** A single materialized input-staging request: copy `fileMetadataId` (in local
 *  mode, a source path) into the run dir at the package-defined `stagePath`. */
export interface StageEntry {
  fileMetadataId: string;
  stagePath: string;
}

export interface LocalFileStagerOptions {
  /** Base dir relative `fileMetadataId` paths resolve against. Defaults to CWD. */
  base?: string;
}

/**
 * Stages workflow input files for all-in-one (no-Server) local runs by plain
 * filesystem copy — there is no MinIO/NetDrive to presign against. The local
 * convention is that an input's `fileMetadataId` is a source path on this host:
 * absolute paths are used as-is, relative paths resolve against {@link base}.
 * Each file is copied to `join(workingDir, stagePath)`, parent dirs created.
 */
export class LocalFileStager {
  private readonly base: string;

  constructor(opts: LocalFileStagerOptions = {}) {
    this.base = opts.base ?? process.cwd();
  }

  async stage(inputStaging: StageEntry[], workingDir: string): Promise<void> {
    const workRoot = resolve(workingDir);
    for (const { fileMetadataId, stagePath } of inputStaging) {
      const source = isAbsolute(fileMetadataId)
        ? fileMetadataId
        : resolve(this.base, fileMetadataId);
      const dest = resolve(workRoot, stagePath);
      const within = relative(workRoot, dest);
      if (within.startsWith("..") || isAbsolute(within)) {
        throw new Error(`local file staging: stagePath "${stagePath}" escapes the run dir`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      try {
        copyFileSync(source, dest);
      } catch (err) {
        throw new Error(
          `local file staging: source not found for ${stagePath}: ${fileMetadataId}`,
          { cause: err },
        );
      }
    }
  }
}

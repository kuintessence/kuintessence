import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { usecase } from "@kuintessence/shared";
import type { Logger } from "pino";

export interface ExpectedOutput {
  descriptor: string;
  path: string;
  isBatch: boolean;
  pathsOnly?: boolean;
  protectedPaths?: readonly string[];
  protectedMounts?: readonly ProtectedPathMount[];
}

export interface ProtectedPathMount {
  selectorId: string;
  sourcePath: string;
  targetPath: string;
}

/**
 * Reads an output file's UTF-8 text given an absolute path. The host reader is
 * plain `readFile`; the container reader (`docker exec cat`) is built in
 * `index.ts`.
 */
export type ValidatedOutputReader = (
  outputPath: string,
  workingDir: string,
  protectedPaths: readonly string[],
) => Promise<string>;

export type ValidatedOutputPathValidator = (
  outputPath: string,
  workingDir: string,
  protectedPaths: readonly string[],
) => Promise<void>;

export interface OutputReader {
  (absolutePath: string): Promise<string>;
  readValidated?: ValidatedOutputReader;
  validatePath?: ValidatedOutputPathValidator;
}

export interface HostValidatedOutputReaderDeps {
  openFile?: (path: string, flags: number) => Promise<FileHandle>;
  afterOpen?: (path: string) => Promise<void>;
}

export function createHostValidatedOutputReader(
  deps: HostValidatedOutputReaderDeps = {},
): ValidatedOutputReader {
  const openFile = deps.openFile ?? ((path, flags) => open(path, flags));
  return async (outputPath, workingDir, protectedPaths) => {
    const { handle, resolvedOutput } = await openValidatedHostOutput(
      outputPath,
      workingDir,
      protectedPaths,
      openFile,
    );
    try {
      await deps.afterOpen?.(resolvedOutput);
      return new TextDecoder().decode(await handle.readFile());
    } finally {
      await handle.close();
    }
  };
}

export function createHostValidatedOutputPathValidator(
  deps: Pick<HostValidatedOutputReaderDeps, "openFile"> = {},
): ValidatedOutputPathValidator {
  const openFile = deps.openFile ?? ((path, flags) => open(path, flags));
  return async (outputPath, workingDir, protectedPaths) => {
    const { handle } = await openValidatedHostOutput(
      outputPath,
      workingDir,
      protectedPaths,
      openFile,
    );
    await handle.close();
  };
}

export const hostOutputReader: OutputReader = (p) => readFile(p, "utf8");
hostOutputReader.readValidated = createHostValidatedOutputReader();
hostOutputReader.validatePath = createHostValidatedOutputPathValidator();

/**
 * Lists the workingDir-relative paths a batched output's glob `pattern` matches.
 * The host scanner is `Bun.Glob`; tests inject a deterministic stub. Order is
 * the scanner's own — `createOutputCollector` re-sorts to a stable order.
 */
export type GlobScanner = (
  pattern: string,
  workingDir: string,
) => Iterable<string> | Promise<Iterable<string>>;

export const hostGlobScanner: GlobScanner = (pattern, workingDir) =>
  new Bun.Glob(pattern).scanSync({ cwd: workingDir });

/**
 * Build the JobRunner `collectOutputs` seam. On a completed job, map each
 * expected output to a string under its descriptor; the Server (or local engine)
 * then runs value-extraction (regex/json/whole) over these strings.
 *
 * Non-batch: read the single file's text. Relative paths resolve against the
 * job's workingDir; a missing/unreadable file is logged and skipped rather than
 * failing the already-terminal job.
 *
 * Batched (glob): expand `out.path` against the workingDir, read each match in
 * deterministic filename order, and set the descriptor to a JSON array of file
 * contents. A list/json `valueOutput` with `extract: Whole` (or JsonPath `$`)
 * then yields a CelValue list — the input to the engine's scatter-gather
 * (Generate → Loop ForEach → Reduce). Zero matches collect `"[]"` (never a
 * throw); an unreadable match is skipped, keeping the array element count
 * aligned with the readable files.
 */
export function createOutputCollector(
  read: OutputReader,
  logger?: Logger,
  scanGlob: GlobScanner = hostGlobScanner,
): (outputs: ExpectedOutput[], workingDir: string) => Promise<Record<string, string>> {
  const readValidated = read.readValidated;
  if (!readValidated) {
    throw new Error("Output reader must provide atomic path validation and reading");
  }
  return async (outputs, workingDir) => {
    const collected: Record<string, string> = {};
    for (const out of outputs) {
      if (out.isBatch) {
        if (out.pathsOnly && !read.validatePath) {
          throw new Error("Output reader must provide path-only validation");
        }
        const batch = await readBatch(
          out,
          workingDir,
          readValidated,
          read.validatePath,
          scanGlob,
          logger,
        );
        if (!out.pathsOnly) {
          collected[out.descriptor] = JSON.stringify(batch.contents);
        }
        collected[usecase.batchOutputPathsDescriptor(out.descriptor)] = JSON.stringify(batch.paths);
        continue;
      }
      const abs = out.path.startsWith("/") ? out.path : resolve(workingDir, out.path);
      if (out.pathsOnly) {
        if (!read.validatePath) {
          throw new Error("Output reader must provide path-only validation");
        }
        try {
          await read.validatePath(abs, workingDir, out.protectedPaths ?? []);
          collected[usecase.batchOutputPathsDescriptor(out.descriptor)] = JSON.stringify([
            out.path,
          ]);
        } catch (err) {
          logger?.warn(
            { descriptor: out.descriptor, path: abs, err },
            "Failed to validate expected output",
          );
        }
        continue;
      }
      try {
        collected[out.descriptor] = await readValidated(abs, workingDir, out.protectedPaths ?? []);
      } catch (err) {
        logger?.warn(
          { descriptor: out.descriptor, path: abs, err },
          "Failed to read expected output",
        );
      }
    }
    return collected;
  };
}

async function readBatch(
  out: ExpectedOutput,
  workingDir: string,
  readValidated: ValidatedOutputReader,
  validatePath: ValidatedOutputPathValidator | undefined,
  scanGlob: GlobScanner,
  logger?: Logger,
): Promise<{ contents: string[]; paths: string[] }> {
  const matches = [...(await scanGlob(out.path, workingDir))].sort();
  const contents: string[] = [];
  const paths: string[] = [];
  for (const rel of matches) {
    const abs = rel.startsWith("/") ? rel : resolve(workingDir, rel);
    try {
      if (out.pathsOnly) {
        if (!validatePath) {
          throw new Error("Output reader must provide path-only validation");
        }
        await validatePath(abs, workingDir, out.protectedPaths ?? []);
      } else {
        contents.push(await readValidated(abs, workingDir, out.protectedPaths ?? []));
      }
      paths.push(rel);
    } catch (err) {
      logger?.warn(
        { descriptor: out.descriptor, path: abs, err },
        "Failed to read batched output match; skipping it",
      );
    }
  }
  return { contents, paths };
}

async function openValidatedHostOutput(
  outputPath: string,
  workingDir: string,
  protectedPaths: readonly string[],
  openFile: (path: string, flags: number) => Promise<FileHandle>,
): Promise<{ handle: FileHandle; resolvedOutput: string }> {
  const { canonicalStat, resolvedOutput, workRoot } = await validateHostOutputPath(
    outputPath,
    workingDir,
    protectedPaths,
  );
  const handle = await openFile(resolvedOutput, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || !sameFile(openedStat, canonicalStat)) {
      throw new Error("Expected output changed before it could be opened safely");
    }
    const fdCanonical = await canonicalPathForFd(handle.fd);
    if (fdCanonical) {
      await validateCanonicalOutputPath(fdCanonical, resolvedOutput, workRoot, protectedPaths);
    }
    return { handle, resolvedOutput };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function validateHostOutputPath(
  outputPath: string,
  workingDir: string,
  protectedPaths: readonly string[],
): Promise<{
  canonicalStat: Stats;
  resolvedOutput: string;
  workRoot: string;
}> {
  if (!isAbsolute(workingDir)) {
    throw new Error("Expected output work root must be absolute");
  }
  const originalWorkRootStat = await lstat(workingDir);
  if (!originalWorkRootStat.isDirectory() || originalWorkRootStat.isSymbolicLink()) {
    throw new Error("Expected output work root must be a non-symbolic-link directory");
  }
  const workRoot = await realpath(workingDir);
  const workRootStat = await lstat(workRoot);
  if (!workRootStat.isDirectory() || workRootStat.isSymbolicLink()) {
    throw new Error("Expected output work root must be a directory");
  }
  const resolvedOutput = resolve(outputPath);
  const canonical = await realpath(resolvedOutput);
  const stat = await lstat(resolvedOutput);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Expected output must be a regular file, not a symbolic link");
  }
  const canonicalStat = await lstat(canonical);
  if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink()) {
    throw new Error("Expected output must remain a regular file");
  }
  await validateCanonicalOutputPath(canonical, resolvedOutput, workRoot, protectedPaths);
  return { canonicalStat, resolvedOutput, workRoot };
}

async function validateCanonicalOutputPath(
  canonical: string,
  resolvedOutput: string,
  workRoot: string,
  protectedPaths: readonly string[],
): Promise<void> {
  if (!inside(workRoot, canonical)) {
    throw new Error("Expected output path escapes the job work root");
  }
  for (const protectedPath of protectedPaths) {
    const protectedResolved = resolve(protectedPath);
    if (inside(protectedResolved, resolvedOutput)) {
      throw new Error("Expected output path is protected licensed material");
    }
    const canonicalProtected = await realpath(protectedResolved).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (canonicalProtected && inside(canonicalProtected, canonical)) {
      throw new Error("Expected output path is protected licensed material");
    }
  }
}

async function canonicalPathForFd(fd: number): Promise<string | undefined> {
  for (const fdPath of [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]) {
    try {
      const canonical = await realpath(fdPath);
      if (canonical !== fdPath) {
        return canonical;
      }
    } catch {}
  }
  return undefined;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

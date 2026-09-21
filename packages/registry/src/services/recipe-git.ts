import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { createLogger } from "@kuintessence/shared";
import type { RecipeTreeFile } from "./recipe-diagnostics";

const logger = createLogger("registry-recipe-git");

export class RecipeStoreError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503,
    message: string,
  ) {
    super(message);
    this.name = "RecipeStoreError";
  }
}

export interface RecipeStoreLimits {
  maxBundleBytes: number;
  maxExpandedBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  gitTimeoutMs: number;
}

export const DEFAULT_RECIPE_LIMITS: RecipeStoreLimits = {
  maxBundleBytes: 128 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxFiles: 100_000,
  gitTimeoutMs: 120_000,
};

export async function runRecipeGit(
  directory: string,
  args: string[],
  limits: RecipeStoreLimits,
  allowFailure = false,
  input?: string,
): Promise<{ stdout: Buffer; code: number }> {
  const result = await new Promise<{ stdout: Buffer; code: number }>((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "gc.auto=0",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=always",
        "-c",
        "fetch.fsckObjects=true",
        "-C",
        directory,
        ...args,
      ],
      {
        detached: grouped,
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: directory,
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_PROTOCOL_FROM_USER: "0",
          GIT_ALLOW_PROTOCOL: "file",
          GIT_AUTHOR_NAME: "Kuintessence Registry",
          GIT_AUTHOR_EMAIL: "registry@example.invalid",
          GIT_COMMITTER_NAME: "Kuintessence Registry",
          GIT_COMMITTER_EMAIL: "registry@example.invalid",
        },
      },
    );
    let failure: RecipeStoreError | undefined;
    const output: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stop = (cause?: unknown) => {
      if (failure) return;
      failure = new RecipeStoreError(422, "Git operation exceeded its resource limit or failed");
      failure.cause = cause;
      if (!child.pid) return;
      if (grouped) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            failure.cause = error;
            logger.warn("Failed to terminate the recipe Git process group");
          }
          child.kill("SIGKILL");
        }
      } else {
        execFile(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { timeout: 5000, windowsHide: true },
          (error) => {
            if (error) {
              logger.warn("Failed to terminate the recipe Git process tree");
              child.kill("SIGKILL");
            }
          },
        );
      }
    };
    const timer = setTimeout(stop, limits.gitTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 32 * 1024 * 1024) stop();
      else if (!failure) output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 32 * 1024 * 1024) stop();
    });
    child.on("error", stop);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // Git may reject input and exit before consuming the entire batch.
      if (error.code !== "EPIPE") stop(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      child.stdin.destroy();
      if (failure || signal || code === null) {
        reject(failure ?? new RecipeStoreError(422, "Git operation was terminated"));
      } else {
        resolve({ stdout: Buffer.concat(output), code });
      }
    });
    child.stdin.end(input);
  });
  if (result.code !== 0 && !allowFailure) {
    throw new RecipeStoreError(
      422,
      `Git ${args[0]} failed; provide a valid, self-contained SHA-1 bundle containing HEAD`,
    );
  }
  return result;
}

/** Batch only metadata blobs, keeping at most 4 MiB cached while indexing a full upstream repo. */
export function createRecipeTextReader(
  directory: string,
  files: RecipeTreeFile[],
  limits: RecipeStoreLimits,
): (file: RecipeTreeFile) => Promise<string> {
  const batches: RecipeTreeFile[][] = [];
  const positions = new Map<string, number>();
  let batch: RecipeTreeFile[] = [];
  let bytes = 0;
  for (const file of files) {
    if (!/(^|\/)(repo\.yaml|package\.py)$/.test(file.path) || file.size > 1024 * 1024) continue;
    if (batch.length >= 128 || bytes + file.size > 4 * 1024 * 1024) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    positions.set(file.path, batches.length);
    batch.push(file);
    bytes += file.size;
  }
  if (batch.length) batches.push(batch);
  let cachedIndex = -1;
  let cached = new Map<string, Buffer>();
  return async (file) => {
    const index = positions.get(file.path);
    if (index === undefined) {
      throw new RecipeStoreError(
        422,
        `Recipe metadata exceeds 1 MiB or is unsupported: ${file.path}`,
      );
    }
    if (cachedIndex !== index) {
      const selected = batches[index];
      if (!selected) throw new RecipeStoreError(500, "Recipe metadata batch not found");
      const result = await runRecipeGit(
        directory,
        ["cat-file", "--batch"],
        limits,
        false,
        `${selected.map((item) => item.oid).join("\n")}\n`,
      );
      const blobs = new Map<string, Buffer>();
      let offset = 0;
      for (const item of selected) {
        const end = result.stdout.indexOf(10, offset);
        if (
          end < 0 ||
          result.stdout.subarray(offset, end).toString() !== `${item.oid} blob ${item.size}`
        ) {
          throw new RecipeStoreError(422, "Recipe object header does not match its tree entry");
        }
        offset = end + 1;
        const body = result.stdout.subarray(offset, offset + item.size);
        if (body.length !== item.size || result.stdout[offset + item.size] !== 10) {
          throw new RecipeStoreError(422, "Recipe object content is truncated");
        }
        blobs.set(item.path, body);
        offset += item.size + 1;
      }
      cached = blobs;
      cachedIndex = index;
    }
    const content = cached.get(file.path);
    if (!content) throw new RecipeStoreError(500, "Recipe metadata blob not found");
    return decodeRecipeText(content, `recipe file ${file.path}`);
  };
}

function decodeRecipeText(bytes: Uint8Array, context: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    const error = new RecipeStoreError(422, `Invalid UTF-8 in ${context}`);
    error.cause = cause;
    throw error;
  }
}

export function parseRecipeTree(bytes: Uint8Array, limits: RecipeStoreLimits): RecipeTreeFile[] {
  const tree = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files: RecipeTreeFile[] = [];
  let totalBytes = 0;
  for (let offset = 0; offset < tree.length; ) {
    const terminator = tree.indexOf(0, offset);
    const end = terminator < 0 ? tree.length : terminator;
    const entry = tree.subarray(offset, end);
    offset = end + 1;
    if (!entry.length) continue;
    const context = entry
      .subarray(entry.indexOf(9) + 1)
      .toString("utf8")
      .slice(0, 256);
    const line = decodeRecipeText(entry, `Git tree path ${context}`);
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40}) +([0-9]+|-)\t(.+)$/.exec(line);
    if (!match) throw new RecipeStoreError(422, "Unsupported Git tree entry");
    const [, mode, type, oid, rawSize, path] = match;
    if (
      !oid ||
      !path ||
      !rawSize ||
      type !== "blob" ||
      !["100644", "100755"].includes(mode ?? "")
    ) {
      throw new RecipeStoreError(422, "Recipe bundles cannot contain symlinks or submodules");
    }
    if (
      path.length > 4096 ||
      Array.from(path).some(
        (character) =>
          character === "\\" || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      path
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
    ) {
      throw new RecipeStoreError(422, "Recipe bundle contains an unsafe path");
    }
    const size = Number(rawSize);
    totalBytes += size;
    if (
      !Number.isSafeInteger(size) ||
      size > limits.maxFileBytes ||
      totalBytes > limits.maxExpandedBytes ||
      files.length >= limits.maxFiles
    ) {
      throw new RecipeStoreError(413, "Recipe tree exceeds the configured file or size limit");
    }
    files.push({ path, oid, size });
  }
  return files;
}

export function checkRecipeObjects(bytes: Uint8Array, limits: RecipeStoreLimits): void {
  let total = 0;
  let count = 0;
  for (const line of new TextDecoder().decode(bytes).trim().split("\n")) {
    if (!line) continue;
    const size = Number(line);
    total += size;
    count += 1;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > limits.maxFileBytes ||
      total > limits.maxExpandedBytes ||
      count > limits.maxFiles * 10
    ) {
      throw new RecipeStoreError(
        413,
        "Git history exceeds the configured object limit; export a current-tree-only bundle",
      );
    }
  }
}

export async function writeRecipeBundle(
  path: string,
  input: Uint8Array | ReadableStream<Uint8Array>,
  limit: number,
  timeouts: { idleTimeoutMs?: number; totalTimeoutMs?: number } = {},
): Promise<string> {
  const idleTimeoutMs = timeouts.idleTimeoutMs ?? 30_000;
  const totalTimeoutMs = timeouts.totalTimeoutMs ?? 300_000;
  if (
    ![idleTimeoutMs, totalTimeoutMs].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647,
    )
  ) {
    throw new RecipeStoreError(500, "Recipe upload timeouts must be positive timer-safe integers");
  }
  const deadline = performance.now() + totalTimeoutMs;
  const file = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let failure: { error: unknown } | undefined;
  const wait = async <T>(operation: () => Promise<T>, idle = false): Promise<T> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new RecipeStoreError(400, "Recipe upload deadline exceeded");
    const idleFirst = idle && idleTimeoutMs < remaining;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new RecipeStoreError(
                  400,
                  idleFirst ? "Recipe upload idle timeout" : "Recipe upload deadline exceeded",
                ),
              ),
            idleFirst ? idleTimeoutMs : remaining,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    if (!(input instanceof Uint8Array)) reader = input.getReader();
    const write = async (chunk: Uint8Array) => {
      size += chunk.byteLength;
      if (size > limit) throw new RecipeStoreError(413, "Recipe bundle exceeds the upload limit");
      hash.update(chunk);
      await wait(() => file.writeFile(chunk));
    };
    if (input instanceof Uint8Array) {
      await write(input);
    } else if (reader) {
      const source = reader;
      for (;;) {
        const result = await wait(() => source.read(), true);
        if (result.done) break;
        await write(result.value);
      }
    }
    if (size === 0) throw new RecipeStoreError(400, "Recipe bundle is empty");
  } catch (error) {
    failure = { error };
    // Cancellation closes pending reads synchronously; do not await an untrusted cancel hook.
    void reader?.cancel(error).catch(() => {
      logger.warn("Recipe upload cancellation failed; preserving the original upload error");
    });
  } finally {
    try {
      reader?.releaseLock();
    } catch (error) {
      if (failure) logger.warn("Recipe upload reader release failed after an upload error");
      else failure = { error };
    } finally {
      try {
        await file.close();
      } catch (error) {
        if (failure) logger.warn("Recipe upload file close failed after an upload error");
        else failure = { error };
      }
    }
  }
  if (failure) throw failure.error;
  return hash.digest("hex");
}

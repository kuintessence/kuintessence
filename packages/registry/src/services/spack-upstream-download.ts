import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { mkdtemp, open, rm } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createLogger } from "@kuintessence/shared";
import { RecipeStoreError } from "./recipe-git";
import { SpackMaterialError } from "./spack-material-storage";
import {
  isPublicIPv4,
  parseUpstreamOrigins,
  parseUpstreamProxy,
  SpackUpstreamError,
  validateUpstreamUrl,
} from "./spack-upstream-policy";

const logger = createLogger("registry-spack-upstream");

export interface SpackUpstreamOptions {
  proxyUrl: string;
  allowedOrigins: string[];
  maxBytes: number;
  timeoutMs: number;
  idleTimeoutMs: number;
  maxConcurrent: number;
  caBundle?: string;
}

export interface SpackUpstreamInput {
  url: string;
  digest: string;
  size: number;
}

export class SpackUpstreamDownloader {
  private active = 0;
  private readonly options: SpackUpstreamOptions;

  constructor(
    options: SpackUpstreamOptions,
    private readonly lookup: (host: string, signal: AbortSignal) => Promise<string[]> = lookupIPv4,
  ) {
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > 16 * 1024 ** 3 ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 30 * 60_000 ||
      !Number.isSafeInteger(options.idleTimeoutMs) ||
      options.idleTimeoutMs < 1 ||
      options.idleTimeoutMs > options.timeoutMs ||
      !Number.isSafeInteger(options.maxConcurrent) ||
      options.maxConcurrent < 1 ||
      options.maxConcurrent > 4 ||
      (options.caBundle !== undefined && !isAbsolute(options.caBundle))
    ) {
      throw new SpackUpstreamError("policy");
    }
    this.options = {
      ...options,
      proxyUrl: parseUpstreamProxy(options.proxyUrl),
      allowedOrigins: parseUpstreamOrigins(JSON.stringify(options.allowedOrigins)),
    };
    if (this.options.allowedOrigins.length === 0) throw new SpackUpstreamError("policy");
  }

  async withDownload<T>(
    input: SpackUpstreamInput,
    signal: AbortSignal,
    consume: (stream: ReadableStream<Uint8Array>) => Promise<T>,
  ): Promise<T> {
    const url = validateUpstreamUrl(input.url, this.options.allowedOrigins);
    if (
      !/^sha256:[a-f0-9]{64}$/.test(input.digest) ||
      !Number.isSafeInteger(input.size) ||
      input.size < 1 ||
      input.size > this.options.maxBytes
    ) {
      throw new SpackUpstreamError("policy");
    }
    if (this.active >= this.options.maxConcurrent) throw new SpackUpstreamError("busy");
    this.active += 1;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.options.timeoutMs);
    const combined = AbortSignal.any([signal, deadline.signal]);
    let directory: string | undefined;
    const check = () => {
      if (signal.aborted) throw new SpackUpstreamError("cancelled");
      if (deadline.signal.aborted) throw new SpackUpstreamError("timeout");
    };
    try {
      check();
      const addresses = isIPv4(url.hostname)
        ? [url.hostname]
        : await this.resolve(url.hostname, combined);
      check();
      const address = addresses[0];
      if (!address || !addresses.every(isPublicIPv4)) throw new SpackUpstreamError("policy");
      directory = await mkdtemp(join(tmpdir(), "kq-spack-upstream-"));
      const path = join(directory, "verified");
      await this.transfer(url, address, input, path, combined);
      check();
      // Verified storage ingestion is governed by the caller's whole-import deadline.
      clearTimeout(timer);
      const stream = Bun.file(path).stream();
      const reader = stream.getReader();
      const guarded = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            check();
            const chunk = await reader.read();
            check();
            if (chunk.done) controller.close();
            else controller.enqueue(chunk.value);
          } catch (error) {
            controller.error(
              error instanceof SpackUpstreamError ? error : new SpackUpstreamError("io"),
            );
          }
        },
        cancel() {
          return reader.cancel();
        },
      });
      try {
        const result = await consume(guarded);
        check();
        return result;
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    } catch (error) {
      check();
      if (error instanceof SpackUpstreamError) throw error;
      if (error instanceof RecipeStoreError || error instanceof SpackMaterialError) throw error;
      // Only typed store errors reach the importer's sanitizer; transport details never escape.
      throw new SpackUpstreamError("io");
    } finally {
      clearTimeout(timer);
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } catch {
        logger.error("Could not remove Spack upstream staging directory");
        throw new SpackUpstreamError("io");
      } finally {
        this.active -= 1;
      }
    }
  }

  private async resolve(host: string, signal: AbortSignal): Promise<string[]> {
    try {
      // Keep admission until the resolver acknowledges cancellation.
      return await this.lookup(host, signal);
    } catch (error) {
      if (error instanceof SpackUpstreamError) throw error;
      throw new SpackUpstreamError("policy");
    }
  }

  private async transfer(
    url: URL,
    address: string,
    input: SpackUpstreamInput,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new SpackUpstreamError("cancelled");
    const file = await open(path, "wx", 0o600);
    try {
      await this.runCurl(url, address, input, signal, async (chunk) => {
        await file.writeFile(chunk);
      });
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private async runCurl(
    url: URL,
    address: string,
    input: SpackUpstreamInput,
    signal: AbortSignal,
    write: (chunk: Buffer) => Promise<void>,
  ): Promise<void> {
    // -q must be first: neither .curlrc nor inherited proxy/CA settings are trusted.
    const child = spawn("/usr/bin/curl", ["-q", "--config", "-"], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let failure: SpackUpstreamError | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let status = "";
    let size = 0;
    const hash = createHash("sha256");
    const stop = (error: SpackUpstreamError) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => stop(new SpackUpstreamError("timeout")), this.options.idleTimeoutMs);
    };
    const abort = () => stop(new SpackUpstreamError("cancelled"));
    const closed = new Promise<number | null>((resolve) => {
      child.on("error", () => {
        failure ??= new SpackUpstreamError("unavailable");
      });
      child.on("close", (code) => resolve(code));
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(new SpackUpstreamError("proxy"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (status.length + chunk.length > 128) stop(new SpackUpstreamError("http"));
      else status += chunk.toString("ascii");
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    resetIdle();
    const options: Record<string, string> = {
      url: url.href,
      proxy: this.options.proxyUrl,
      noproxy: "",
      "connect-to": `${url.hostname}:443:${address}:443`,
      proto: "=https",
      "proto-redir": "=https",
      "max-redirs": "0",
      "connect-timeout": String(Math.min(this.options.timeoutMs, 30_000) / 1000),
      "max-time": String(this.options.timeoutMs / 1000),
      "max-filesize": String(input.size),
      "write-out": "%{stderr}%{http_code}",
      ...(this.options.caBundle ? { cacert: this.options.caBundle } : {}),
    };
    child.stdin.end(
      `silent\nno-buffer\ngloboff\nhttp1.1\nproxytunnel\n${Object.entries(options)
        .map(([key, value]) => `${key} = ${quoteCurl(value)}`)
        .join("\n")}\n`,
    );
    try {
      try {
        for await (const data of child.stdout) {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
          size += chunk.length;
          if (size > input.size) {
            stop(new SpackUpstreamError("integrity"));
            break;
          }
          if (failure) break;
          hash.update(chunk);
          await write(chunk);
          resetIdle();
        }
      } catch {
        stop(new SpackUpstreamError("io"));
      }
      const code = await closed;
      if (failure) throw failure;
      if (code === 28) throw new SpackUpstreamError("timeout");
      if (code === 63) throw new SpackUpstreamError("integrity");
      if (code !== 0) throw new SpackUpstreamError("proxy");
      if (status !== "200") throw new SpackUpstreamError("http");
      if (size !== input.size || `sha256:${hash.digest("hex")}` !== input.digest) {
        throw new SpackUpstreamError("integrity");
      }
    } finally {
      clearTimeout(idle);
      signal.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      await closed;
      child.stdin.destroy();
    }
  }
}

function quoteCurl(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
  return `"${escaped}"`;
}

async function lookupIPv4(host: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await resolver.resolve4(host);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

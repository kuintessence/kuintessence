import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FederationResultReportSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import {
  copyFederationResultFile,
  FederationResultCopyError,
  type FederationResultCopyOptions,
} from "./result-copy";

let root: string, ca: string;
let source: ReturnType<typeof Bun.serve>, target: ReturnType<typeof Bun.serve>;
let content = Buffer.from("result");
let mode = "normal",
  sourceRequests = 0,
  targetRequests = 0;
const received = new Map<number, Buffer>();
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kq-result-copy-"));
  const key = join(root, "tls.key"),
    cert = join(root, "tls.pem");
  const generated = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (generated.exitCode !== 0) throw new Error("Test TLS certificate generation failed");
  ca = await readFile(cert, "utf8");
  const tls = { key: Bun.file(key), cert: Bun.file(cert) };
  source = Bun.serve({
    hostname: "localhost",
    port: 0,
    tls,
    fetch: (req) => {
      sourceRequests++;
      if (mode === "redirect") return Response.redirect(`${target.url}unexpected`);
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
      if (!range) return new Response(null, { status: 416 });
      const start = Number(range[1]),
        end = Number(range[2]);
      if (mode === "stall")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(content.subarray(start, start + 1));
            },
          }),
          { status: 206, headers: { "content-range": `bytes ${start}-${end}/${content.length}` } },
        );
      return new Response(content.subarray(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${content.length}` },
      });
    },
  });
  target = Bun.serve({
    hostname: "localhost",
    port: 0,
    tls,
    fetch: async (req) => {
      targetRequests++;
      const partNumber = Number(new URL(req.url).searchParams.get("part"));
      if (req.method !== "PUT" || !partNumber) return new Response(null, { status: 400 });
      received.set(partNumber, Buffer.from(await req.arrayBuffer()));
      return new Response(null, { headers: { etag: `"part-${partNumber}"` } });
    },
  });
});
afterAll(async () => {
  source?.stop(true);
  target?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});

function fixture(bytes = Buffer.from("result")) {
  content = bytes;
  mode = "normal";
  sourceRequests = 0;
  targetRequests = 0;
  received.clear();
  const digest = `sha256:${"a".repeat(64)}`;
  const now = new Date().toISOString(),
    until = new Date(Date.now() + 120_000).toISOString();
  const manifest = {
    template: {
      originSiteId: crypto.randomUUID(),
      kind: "workflow",
      id: crypto.randomUUID(),
      revision: "1",
      digest,
    },
    inputManifestDigest: digest,
    environmentLockDigest: digest,
    completedAt: now,
    availableUntil: until,
    outputs: [
      {
        outputId: digest,
        nodeId: "calculate",
        descriptor: "result",
        type: "File",
        contentDigest: `sha256:${hash(bytes)}`,
        sizeBytes: bytes.length,
        files: [{ path: "result", sizeBytes: bytes.length, sha256: hash(bytes) }],
      },
    ],
  };
  const report = FederationResultReportSchema.parse({
    protocolVersion: 1,
    kind: "result-report",
    queryId: crypto.randomUUID(),
    senderSiteId: crypto.randomUUID(),
    recipientSiteId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    agreementRevisionId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    attempt: 1,
    reservationId: crypto.randomUUID(),
    requestDigest: digest,
    queryDigest: digest,
    observedAt: now,
    manifestDigest: `sha256:${hash(federationCanonicalJson(manifest))}`,
    manifest,
  });
  const calls: string[] = [];
  const options: FederationResultCopyOptions = {
    task: {
      transferId: crypto.randomUUID(),
      generation: crypto.randomUUID(),
      report,
      outputId: digest,
      path: "result",
      partSize: 5 * 1024 * 1024,
    },
    stagingRoot: join(root, "staging"),
    maxStagingBytes: 8 * 1024 * 1024,
    allowedSourceOrigins: [source.url.origin],
    allowedDestinationOrigins: [target.url.origin],
    fetcher: (url, init) => fetch(url, { ...init, tls: { ca } }),
    authorize: async (binding, direction, partNumber) => {
      calls.push(direction + (partNumber ?? ""));
      return {
        binding,
        direction,
        ...(partNumber === undefined ? {} : { partNumber }),
        url:
          direction === "download"
            ? `${source.url}object?secret=download-ticket`
            : `${target.url}upload?part=${partNumber}&secret=upload-ticket`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  };
  return { options, calls };
}

test("Agent copies real HTTPS ranges into real multipart PUTs with bounded grants and no published replica", async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 123, 42);
  const f = fixture(bytes);
  const result = await copyFederationResultFile(f.options);
  expect(
    Buffer.concat([...received.entries()].sort(([a], [b]) => a - b).map(([, body]) => body)),
  ).toEqual(bytes);
  expect(result.sha256).toBe(hash(bytes));
  expect(result.sizeBytes).toBe(bytes.length);
  expect(result.parts).toEqual([
    { partNumber: 1, etag: "part-1" },
    { partNumber: 2, etag: "part-2" },
  ]);
  expect(f.calls.filter((call) => call === "download")).toHaveLength(6);
  expect(f.calls.slice(-2)).toEqual(["upload1", "upload2"]);
  expect(await readdir(f.options.stagingRoot)).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("secret=");
});

test("copy refuses wrong attempt, wrong origins and redirects before producing an upload", async () => {
  for (const change of ["generation", "origin", "expired", "redirect"] as const) {
    const f = fixture();
    const authorize = f.options.authorize;
    f.options.authorize = async (...args) => {
      const grant = await authorize(...args);
      if (change === "generation") grant.binding.generation = crypto.randomUUID();
      if (change === "origin") grant.url = `${target.url}forbidden?secret=untrusted`;
      if (change === "expired") grant.expiresAt = new Date(Date.now() - 1).toISOString();
      return grant;
    };
    if (change === "redirect") mode = "redirect";
    let error: unknown;
    try {
      await copyFederationResultFile(f.options);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FederationResultCopyError);
    expect(String(error)).not.toContain("secret=");
    expect(targetRequests).toBe(0);
    if (change !== "redirect") expect(sourceRequests).toBe(0);
    expect(await readdir(f.options.stagingRoot)).toEqual([]);
  }
});

test("copy rejects corrupt bytes, revoked upload authority and insufficient staging before publication", async () => {
  let f = fixture();
  content = Buffer.from("broken");
  await expect(copyFederationResultFile(f.options)).rejects.toThrow("TRANSFER_IO_FAILED");
  expect(targetRequests).toBe(0);
  f = fixture();
  const authorize = f.options.authorize;
  f.options.authorize = async (...args) => {
    if (args[1] === "upload") throw new FederationResultCopyError("POLICY_DENIED");
    return authorize(...args);
  };
  await expect(copyFederationResultFile(f.options)).rejects.toThrow("POLICY_DENIED");
  expect(targetRequests).toBe(0);
  expect(await readdir(f.options.stagingRoot)).toEqual([]);
  f = fixture();
  f.options.maxStagingBytes = 1;
  await expect(copyFederationResultFile(f.options)).rejects.toThrow("STAGING_UNAVAILABLE");
  expect(sourceRequests).toBe(0);
});

test("grant expiry and caller cancellation interrupt a stalled real download and remove staging", async () => {
  for (const cancel of [false, true]) {
    const f = fixture();
    mode = "stall";
    const stop = new AbortController();
    f.options.signal = stop.signal;
    const authorize = f.options.authorize;
    f.options.authorize = async (...args) => ({
      ...(await authorize(...args)),
      expiresAt: new Date(Date.now() + 100).toISOString(),
    });
    const timer = cancel ? setTimeout(() => stop.abort(), 30) : undefined;
    try {
      await expect(copyFederationResultFile(f.options)).rejects.toThrow(
        cancel ? "TRANSFER_CANCELLED" : "TRANSFER_IO_FAILED",
      );
      expect(targetRequests).toBe(0);
      expect(await readdir(f.options.stagingRoot)).toEqual([]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
});

test("empty outputs still require a source grant; cancellation also bounds a stalled authorization call", async () => {
  const f = fixture(Buffer.alloc(0));
  const result = await copyFederationResultFile(f.options);
  expect(result.sizeBytes).toBe(0);
  expect(result.parts).toHaveLength(1);
  expect(f.calls).toEqual(["download", "upload1"]);
  const waiting = fixture();
  const stop = new AbortController();
  waiting.options.signal = stop.signal;
  waiting.options.authorize = async () => {
    stop.abort();
    return new Promise(() => {});
  };
  await expect(copyFederationResultFile(waiting.options)).rejects.toThrow("TRANSFER_CANCELLED");
  expect(sourceRequests).toBe(0);
  expect(targetRequests).toBe(0);
  expect(await readdir(waiting.options.stagingRoot)).toEqual([]);
});

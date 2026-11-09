import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FederationMediaManifestSchema,
  type FederationMediaObjectBinding,
  FederationMediaObjectBindingSchema,
  FederationMediaObjectGrantSchema,
} from "@kuintessence/shared/federation";
import { signFederationMessage } from "@kuintessence/shared/federation/signatures";
import { exportMediaArchiveFromFiles, quarantineMediaArchive } from "../data-market/media-archive";
import { mediaExportFixture } from "../data-market/media-test-fixtures";
import type { HttpClient } from "../staging/http-client";
import { readFederationMediaObject } from "./media-object-reader";

let root: string, ca: string, server: ReturnType<typeof Bun.serve>;
let content = Buffer.alloc(0);
let mode: string, requests: number, ranges: string[];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kq-media-object-"));
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
  if (generated.exitCode !== 0) throw new Error("Test TLS setup failed");
  ca = await readFile(cert, "utf8");
  server = Bun.serve({
    hostname: "localhost",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    fetch: (request) => {
      requests++;
      if (mode === "redirect") return Response.redirect(`${server.url}redirected`);
      const headers: Record<string, string> = {
        "x-amz-version-id": mode === "version" ? "v2" : "v1",
      };
      if (mode === "unversioned") delete headers["x-amz-version-id"];
      if (!content.length && !request.headers.has("range"))
        return new Response(null, {
          headers: { ...headers, "content-length": String(content.length) },
        });
      const range = request.headers.get("range") ?? "";
      ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) return new Response(null, { status: 416 });
      const offset = Number(match[1]),
        end = Number(match[2]);
      headers["content-range"] = `bytes ${offset}-${end}/${content.length}`;
      if (mode === "bad-range") headers["content-range"] = `bytes 0-${end}/${content.length}`;
      if (mode === "encoded") headers["content-encoding"] = "gzip";
      if (mode === "stall")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(content.subarray(offset, offset + 1));
            },
          }),
          { status: 206, headers },
        );
      const body = content.subarray(offset, end + 1);
      return new Response(
        mode === "extra"
          ? Buffer.concat([body, Buffer.from("x")])
          : mode === "short"
            ? body.subarray(1)
            : body,
        { status: mode === "ignore-range" ? 200 : 206, headers },
      );
    },
  });
});
afterAll(async () => {
  server?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  content = Buffer.alloc(2 * 1024 * 1024 + 17, 42);
  mode = "normal";
  requests = 0;
  ranges = [];
});
const http: HttpClient = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    redirect: request.redirect,
    tls: { ca },
  });
  return {
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers),
    body: response.body,
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
    json: <T>() => response.json() as Promise<T>,
  };
};
function binding(): FederationMediaObjectBinding {
  return {
    generation: crypto.randomUUID(),
    packageId: crypto.randomUUID(),
    manifestDigest: `sha256:${"a".repeat(64)}`,
    fileIndex: 0,
    path: "objects/000000",
    sizeBytes: content.length,
    sha256: hash(content),
    versionId: "v1",
  };
}
function options() {
  const value = binding();
  return {
    binding: value,
    availableUntil: new Date(Date.now() + 60_000).toISOString(),
    allowedSourceOrigins: [server.url.origin],
    signal: AbortSignal.timeout(20_000),
    http,
    authorize: async (current: FederationMediaObjectBinding) => ({
      binding: current,
      url: `${server.url}object?versionId=v1&private-token=not-for-logs`,
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    }),
  };
}
async function collect(stream: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("HTTPS object reader uses bounded exact ranges, pins version and rechecks final authority", async () => {
  const opts = options();
  let permits = 0;
  const bytes = await collect(
    readFederationMediaObject({
      ...opts,
      authorize: async (binding) => {
        permits++;
        return opts.authorize(binding);
      },
    }),
  );
  expect(bytes).toEqual(content);
  expect(permits).toBe(2);
  expect(ranges).toEqual(["bytes=0-1048575", "bytes=1048576-2097151", "bytes=2097152-2097168"]);
});
test("empty object still requires a versioned empty GET and final authority", async () => {
  content = Buffer.alloc(0);
  const opts = options();
  let permits = 0;
  expect(
    await collect(
      readFederationMediaObject({
        ...opts,
        authorize: async (binding) => {
          permits++;
          return opts.authorize(binding);
        },
      }),
    ),
  ).toEqual(content);
  expect(requests).toBe(1);
  expect(permits).toBe(2);
  expect(ranges).toEqual([]);
});
test.each([
  "version",
  "unversioned",
  "redirect",
  "bad-range",
  "ignore-range",
  "extra",
  "short",
  "encoded",
])("object reader rejects %s without exposing credential URLs", async (failure) => {
  mode = failure;
  await expect(collect(readFederationMediaObject(options()))).rejects.toThrow(
    /INVALID_GRANT|TRANSFER_IO_FAILED|GRANT_UNAVAILABLE/,
  );
  if (failure === "redirect") expect(requests).toBe(1);
});
test("changed bytes and denial during final recheck cannot complete an object", async () => {
  const opts = options();
  content[0] = (content[0] ?? 0) ^ 1;
  await expect(collect(readFederationMediaObject(opts))).rejects.toThrow("TRANSFER_IO_FAILED");
  const good = options();
  let permits = 0;
  await expect(
    collect(
      readFederationMediaObject({
        ...good,
        authorize: async (binding) => {
          if (++permits > 1) throw new Error("secret-bearing authorization failure");
          return good.authorize(binding);
        },
      }),
    ),
  ).rejects.toThrow("GRANT_UNAVAILABLE");
});
test("grant binding, local origin and lifetime checks occur before any object request", async () => {
  const opts = options(),
    grant = await opts.authorize(opts.binding);
  for (const changed of [
    { ...grant, binding: { ...grant.binding, packageId: crypto.randomUUID() } },
    { ...grant, binding: { ...grant.binding, versionId: "v2" } },
    { ...grant, binding: { ...grant.binding, fileIndex: 1 } },
    { ...grant, binding: { ...grant.binding, generation: crypto.randomUUID() } },
    { ...grant, url: "https://elsewhere.invalid/private" },
    { ...grant, url: `${server.url}file#secret` },
    { ...grant, expiresAt: new Date(Date.now() - 1).toISOString() },
    { ...grant, expiresAt: new Date(Date.now() + 31_000).toISOString() },
  ])
    await expect(
      collect(readFederationMediaObject({ ...opts, authorize: async () => changed })),
    ).rejects.toThrow();
  expect(requests).toBe(0);
});
test("stalled object body stops at cancellation; cancelled authorization does not make a request", async () => {
  mode = "stall";
  await expect(
    collect(readFederationMediaObject({ ...options(), signal: AbortSignal.timeout(100) })),
  ).rejects.toThrow("TRANSFER_CANCELLED");
  requests = 0;
  await expect(
    collect(
      readFederationMediaObject({
        ...options(),
        signal: AbortSignal.timeout(100),
        authorize: async () => new Promise(() => {}),
      }),
    ),
  ).rejects.toThrow("TRANSFER_CANCELLED");
  expect(requests).toBe(0);
});
test("short grant expires while a body stalls even without user cancellation", async () => {
  mode = "stall";
  const opts = options();
  await expect(
    collect(
      readFederationMediaObject({
        ...opts,
        authorize: async (binding) => ({
          ...(await opts.authorize(binding)),
          expiresAt: new Date(Date.now() + 100).toISOString(),
        }),
      }),
    ),
  ).rejects.toThrow("TRANSFER_IO_FAILED");
});
test("object schema rejects mutable or missing versions and credential fields in a binding", () => {
  const value = binding();
  for (const patch of [
    { versionId: "null" },
    { versionId: "" },
    { fileIndex: 1000 },
    { sizeBytes: -1 },
    { path: "../escape" },
    { url: "https://secret.invalid" },
  ])
    expect(FederationMediaObjectBindingSchema.safeParse({ ...value, ...patch }).success).toBe(
      false,
    );
  expect(
    FederationMediaObjectGrantSchema.safeParse({
      binding: value,
      url: "http://insecure.invalid",
      expiresAt: new Date().toISOString(),
    }).success,
  ).toBe(false);
});

const live = process.env.KQ_MEDIA_AGE_TEST_BIN ? test : test.skip;
live.each(["task-input", "task-result"] as const)(
  "real age streams %s objects into an encrypted archive and restores exact metadata",
  async (kind) => {
    const f = await mediaExportFixture();
    try {
      const manifest = FederationMediaManifestSchema.parse({
        ...f.manifest,
        subject: {
          kind,
          operationId: crypto.randomUUID(),
          taskId: crypto.randomUUID(),
          attempt: 2,
          requestDigest: `sha256:${"c".repeat(64)}`,
          contentDigest: `sha256:${"d".repeat(64)}`,
        },
        files: [
          {
            path: "objects/000000",
            sizeBytes: content.length,
            sha256: hash(content),
            license: "CC-BY-4.0",
            provenance: { source: "authorized private task", revision: 2 },
          },
        ],
      });
      const signedManifest = await signFederationMessage(FederationMediaManifestSchema, manifest, {
        siteId: f.options.task.sourceSiteId,
        keyId: f.options.task.signingKey.keyId,
        privateKey: f.keyPair.privateKey,
      });
      const verified = await f.verify(signedManifest),
        opts = options();
      const archive = exportMediaArchiveFromFiles({
        signedManifest,
        verifyManifest: async (jws) => (await f.verify(jws)).payload,
        signal: f.options.signal,
        readFile: (file, index) =>
          readFederationMediaObject({
            ...opts,
            signal: f.options.signal,
            binding: {
              ...opts.binding,
              packageId: manifest.packageId,
              manifestDigest: verified.digest,
              fileIndex: index,
              path: file.path,
              sizeBytes: file.sizeBytes,
              sha256: file.sha256,
            },
          }),
      });
      const encrypted = await collect(
        f.age.encrypt(archive, f.identity.recipient, f.options.signal),
      );
      expect(encrypted.includes(Buffer.from(signedManifest))).toBe(false);
      const file = join(f.root, "private.age");
      await Bun.write(file, encrypted);
      const received = await quarantineMediaArchive({
        stream: f.age.decrypt(file, f.identity.identity, f.options.signal),
        quarantineRoot: join(f.root, "quarantine"),
        maxBytes: content.length,
        reserveBytes: 1024 * 1024,
        verifyManifest: async (jws) => (await f.verify(jws)).payload,
        signal: f.options.signal,
      });
      expect(received.manifest).toEqual(manifest);
      expect(await readFile(join(received.directory, "files", "objects", "000000"))).toEqual(
        content,
      );
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test("slow archive consumption refreshes an expired grant before the next range", async () => {
  const opts = options();
  let permits = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of readFederationMediaObject({
    ...opts,
    authorize: async (binding) => {
      permits++;
      return {
        ...(await opts.authorize(binding)),
        expiresAt: new Date(Date.now() + 150).toISOString(),
      };
    },
  })) {
    chunks.push(chunk);
    await new Promise((resolve) => setTimeout(resolve, 160));
  }
  expect(Buffer.concat(chunks)).toEqual(content);
  expect(permits).toBe(4);
});
test("an empty-object response containing bytes cannot complete", async () => {
  content = Buffer.alloc(0);
  const opts = options();
  const unexpected: HttpClient = async () => ({
    status: 200,
    ok: true,
    headers: { "x-amz-version-id": "v1", "content-length": "0" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from("unexpected"));
        controller.close();
      },
    }),
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async <T>() => JSON.parse("null") as T,
  });
  await expect(collect(readFederationMediaObject({ ...opts, http: unexpected }))).rejects.toThrow(
    "TRANSFER_IO_FAILED",
  );
});

live.each(["task-input", "task-result", "bad-binding", "revoke-final"] as const)(
  "actual Agent media client and default TLS reader publish only authorized ciphertext: %s",
  async (scenario) => {
    const f = await mediaExportFixture();
    try {
      content = f.bytes;
      const manifest = FederationMediaManifestSchema.parse({
        ...f.manifest,
        subject: {
          kind: scenario === "task-result" ? "task-result" : "task-input",
          operationId: crypto.randomUUID(),
          taskId: crypto.randomUUID(),
          attempt: 1,
          requestDigest: `sha256:${"a".repeat(64)}`,
          contentDigest: `sha256:${"b".repeat(64)}`,
        },
        files: f.manifest.files.map((file) => ({ ...file, path: "objects/000000" })),
      });
      const signedManifest = await signFederationMessage(FederationMediaManifestSchema, manifest, {
        siteId: manifest.senderSiteId,
        keyId: f.options.task.signingKey.keyId,
        privateKey: f.keyPair.privateKey,
      });
      const { managedRootId: _root, relativePath: _path, ...common } = f.options.task;
      const task = {
        ...common,
        signedManifest,
        manifestDigest: (await f.verify(signedManifest)).digest,
        objects: manifest.files.map(({ path, sha256, sizeBytes }) => ({
          path,
          sha256,
          sizeBytes,
          versionId: "v1",
        })),
      };
      const input = join(f.root, "client-input.json");
      const run = async (generation = task.generation) => {
        await writeFile(
          input,
          JSON.stringify({
            task: { ...task, generation },
            mediaDirectory: f.options.mediaDirectory,
            ageDirectory: process.env.KQ_MEDIA_AGE_TEST_BIN,
            origin: server.url.origin,
            scenario,
          }),
          { mode: 0o600 },
        );
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            "--eval",
            `
          import { create } from "@bufbuild/protobuf";
          import { FederationMediaExportSchema, FederationMediaExportLeaseResponseSchema } from "@kuintessence/proto";
          import { FederationMediaExportClient } from ${JSON.stringify(import.meta.resolve("./media-export-client"))};
          import { AgentDataRoots } from ${JSON.stringify(import.meta.resolve("../data-market/local-data-security"))};
          const input = await Bun.file(process.env.KQ_MEDIA_CLIENT_INPUT).json();
          let permits = 0, members = 0;
          const finished = Promise.withResolvers();
          const client = new FederationMediaExportClient({ agentId: input.task.agentId, mediaDirectory: input.mediaDirectory, ageDirectory: input.ageDirectory, allowedSourceOrigins: [input.origin], roots: new AgentDataRoots({ datasetRoot: "/unused-source", jobWorkRoot: "/unused-job", managedRoots: {} }) }, request => {
            const binding = JSON.parse(request.bindingJson), isObject = "fileIndex" in binding;
            if (isObject) members++; else permits++;
            const expiresAt = new Date(Date.now()+20_000).toISOString();
            const grant = isObject ? { binding: { ...binding, ...(input.scenario === "bad-binding" ? { versionId: "wrong" } : {}) }, url: input.origin+"/object?versionId=v1", expiresAt } : { ...binding, expiresAt };
            queueMicrotask(() => client.receive(create(FederationMediaExportLeaseResponseSchema, { requestId: request.requestId, grantJson: !isObject && permits === 2 && input.scenario === "revoke-final" ? "" : JSON.stringify(grant), leaseExpiresAtUnixMs: BigInt(Date.parse(expiresAt)) })));
            return true;
          }, report => finished.resolve(JSON.parse(report.reportJson)));
          client.start(create(FederationMediaExportSchema, { taskJson: JSON.stringify(input.task), leaseExpiresAtUnixMs: BigInt(Date.now()+20_000) }), true);
          const report = await finished.promise; await client.disconnect();
          console.log(JSON.stringify({ report, permits, members }));
        `,
          ],
          {
            env: {
              ...process.env,
              NODE_EXTRA_CA_CERTS: join(root, "tls.pem"),
              KQ_MEDIA_CLIENT_INPUT: input,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (code !== 0) throw new Error(`Agent child exited ${code}: ${stderr}`);
        return JSON.parse(stdout) as {
          report: { state: string; sha256: string; sizeBytes: number; generation: string };
          permits: number;
          members: number;
        };
      };
      const result = await run();
      if (scenario === "bad-binding" || scenario === "revoke-final") {
        expect(result.report.state).toBe("failed");
        expect(
          (await readdir(join(f.options.mediaDirectory, "outbox"))).filter(
            (name) => name !== ".media-work",
          ),
        ).toEqual([]);
        if (scenario === "bad-binding") expect(requests).toBe(0);
        else expect(requests).toBeGreaterThan(0);
      } else {
        expect(result.report.state).toBe("exported");
        expect(result.members).toBe(2);
        expect(result.permits).toBe(2);
        const target = join(f.options.mediaDirectory, "outbox", task.packageId, "bundle.age");
        const cipher = await readFile(target);
        expect(hash(cipher)).toBe(result.report.sha256);
        expect(cipher.length).toBe(result.report.sizeBytes);
        const imported = await quarantineMediaArchive({
          stream: f.age.decrypt(target, f.identity.identity, f.options.signal),
          quarantineRoot: join(f.root, "quarantine"),
          maxBytes: content.length,
          reserveBytes: 1024 * 1024,
          verifyManifest: async (jws) => (await f.verify(jws)).payload,
          signal: f.options.signal,
        });
        expect(await readFile(join(imported.directory, "files", "objects/000000"))).toEqual(
          content,
        );
        const reads = requests,
          generation = crypto.randomUUID();
        const replay = await run(generation);
        expect(replay.report).toEqual({ ...result.report, generation });
        expect(requests).toBe(reads);
        expect(replay.members).toBe(0);
      }
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

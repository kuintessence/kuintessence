import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  type FederationInputCopyReport,
  FederationInputGrantResponseSchema,
  FederationMediaImportGrantResponseSchema,
  FederationMediaUploadSchema,
  type FederationResultCopyReport,
  FederationResultGrantResponseSchema,
} from "@kuintessence/proto";
import {
  FederationInputCopyGrantSchema,
  FederationMediaImportKeyRequestSchema,
  FederationMediaManifestSchema,
  FederationMediaUploadTaskSchema,
  FederationResultCopyGrantSchema,
} from "@kuintessence/shared/federation";
import { signFederationMessage } from "@kuintessence/shared/federation/signatures";
import { exportMediaArchiveFromFiles } from "../data-market/media-archive";
import { mediaImportAuthorization } from "../data-market/media-authority";
import { importFederationMedia } from "../data-market/media-import";
import { mediaImportFixture } from "../data-market/media-import-test-fixture";
import { withMediaWorkspace } from "../data-market/media-workspace";
import { uploadFederationMediaFile } from "./media-upload";
import { FederationMediaUploadClient } from "./media-upload-client";

const live = process.env.KQ_MEDIA_AGE_TEST_BIN ? test : test.skip;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let root: string, ca: string;
let target: ReturnType<typeof Bun.serve>;
let received: Buffer[] = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kq-media-upload-tls-"));
  const key = join(root, "key.pem"),
    cert = join(root, "cert.pem");
  const result = Bun.spawnSync(
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
    { stdout: "ignore", stderr: "ignore" },
  );
  if (result.exitCode) throw new Error("TLS fixture generation failed");
  ca = await readFile(cert, "utf8");
  target = Bun.serve({
    hostname: "localhost",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    fetch: async (request) => {
      if (request.method !== "PUT") return new Response(null, { status: 405 });
      received.push(Buffer.from(await request.arrayBuffer()));
      return new Response(null, { headers: { etag: '"part-etag"' } });
    },
  });
});
afterAll(async () => {
  await target?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture(
  kind: "task-input" | "task-result" = "task-input",
  empty = false,
  size?: number,
) {
  const f = await mediaImportFixture();
  const bytes = empty ? Buffer.alloc(0) : size === undefined ? f.bytes : Buffer.alloc(size, 41);
  const operationId = crypto.randomUUID();
  const contentDigest = `sha256:${"b".repeat(64)}`;
  const manifest = FederationMediaManifestSchema.parse({
    ...f.manifest,
    subject: {
      kind,
      operationId,
      taskId: crypto.randomUUID(),
      attempt: 1,
      requestDigest: `sha256:${"a".repeat(64)}`,
      contentDigest,
    },
    files: [
      {
        ...f.manifest.files[0],
        path: "objects/000000",
        sizeBytes: bytes.length,
        sha256: hash(bytes),
      },
    ],
  });
  const signedManifest = await signFederationMessage(FederationMediaManifestSchema, manifest, {
    siteId: manifest.senderSiteId,
    keyId: f.options.task.signingKey.keyId,
    privateKey: f.keyPair.privateKey,
  });
  const manifestDigest = (await f.verify(signedManifest)).digest;
  Object.assign(f.options.task, { signedManifest, manifestDigest, maxBytes: bytes.length });
  const authorize = f.options.authorize;
  f.options.authorize = async () => {
    const grant = await authorize();
    return { ...grant, binding: { ...grant.binding, manifestDigest } };
  };
  const archive = exportMediaArchiveFromFiles({
    signedManifest,
    verifyManifest: async () => manifest,
    signal: f.options.signal,
    readFile: async function* () {
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
        yield bytes.subarray(offset, offset + 64 * 1024);
    },
  });
  const ciphertext: Uint8Array[] = [];
  for await (const chunk of f.age.encrypt(archive, f.identity.recipient, f.options.signal))
    ciphertext.push(chunk);
  await writeFile(f.cipher, Buffer.concat(ciphertext));
  await importFederationMedia(f.options);
  const binding = {
    transferId: crypto.randomUUID(),
    generation: crypto.randomUUID(),
    operationId,
    manifestDigest: contentDigest,
    sizeBytes: bytes.length,
    sha256: hash(bytes),
    path: "original.dat",
  };
  const partSize = 5 * 1024 * 1024;
  const task = FederationMediaUploadTaskSchema.parse({
    media: f.options.task,
    memberIndex: 0,
    target:
      kind === "task-input"
        ? {
            kind,
            binding: { ...binding, descriptor: "input" },
            partSize,
            availableUntil: f.options.task.expiresAt,
          }
        : {
            kind,
            binding: { ...binding, outputId: `sha256:${"c".repeat(64)}`, partSize },
            availableUntil: f.options.task.expiresAt,
          },
  });
  let permitUntil = 0;
  const options: Parameters<typeof uploadFederationMediaFile>[0] = {
    task,
    agentId: task.media.agentId,
    roots: f.options.roots,
    recipientKey: f.options.recipientKey,
    signal: f.options.signal,
    allowedDestinationOrigins: [target.url.origin],
    authorizeMedia: async () => {
      const grant = await f.options.authorize();
      permitUntil = Date.parse(grant.expiresAt);
      return grant;
    },
    authorizeUpload: async (value, partNumber) => {
      const grant = {
        binding: value.binding,
        direction: "upload",
        partNumber,
        url: `${target.url}part/${partNumber}`,
        expiresAt: new Date(permitUntil - 100).toISOString(),
      };
      return value.kind === "task-input"
        ? FederationInputCopyGrantSchema.parse(grant)
        : FederationResultCopyGrantSchema.parse(grant);
    },
    fetcher: (url, init) => fetch(url, { ...init, tls: { ca } }),
  };
  received = [];
  return {
    ...f,
    bytes,
    manifest,
    upload: options,
    file: join(f.target, "files", "objects", "000000"),
  };
}

live.each(["task-input", "task-result"] as const)(
  "real age %s quarantine uploads over TLS without another plaintext copy",
  async (kind) => {
    for (const empty of [false, true]) {
      const f = await fixture(kind, empty);
      try {
        const report = await uploadFederationMediaFile(f.upload);
        expect(Buffer.concat(received)).toEqual(f.bytes);
        expect(report.copied.parts).toEqual([{ partNumber: 1, etag: "part-etag" }]);
        expect(report.copied.sha256).toBe(hash(f.bytes));
        expect(report.media.generation).toBe(f.upload.task.media.generation);
        expect(report.copied.binding.generation).toBe(f.upload.task.target.binding.generation);
        expect(report.kind).toBe(kind);
        expect((await readdir(f.parent)).sort()).toEqual(
          [".media-work", f.manifest.packageId].sort(),
        );
        expect(await readFile(f.file)).toEqual(f.bytes);
      } finally {
        await f.cleanup();
      }
    }
  },
  30_000,
);

live.each([
  "operation",
  "member",
  "content",
  "hash",
  "agent",
  "kind",
  "expired",
  "bad-manifest",
  "grant-generation",
  "grant-package",
  "grant-key",
  "upload-generation",
  "upload-expiry",
  "origin",
] as const)(
  "media upload rejects %s before sending private bytes",
  async (mode) => {
    const f = await fixture();
    try {
      const opts = f.upload;
      if (mode === "operation") opts.task.target.binding.operationId = crypto.randomUUID();
      if (mode === "member") opts.task.memberIndex = 1;
      if (mode === "content") opts.task.target.binding.manifestDigest = `sha256:${"d".repeat(64)}`;
      if (mode === "hash") opts.task.target.binding.sha256 = "d".repeat(64);
      if (mode === "agent") opts.agentId = "unrelated";
      if (mode === "expired") opts.task.target.availableUntil = new Date(0).toISOString();
      if (mode === "kind")
        opts.task.target = {
          kind: "task-result",
          binding: {
            ...opts.task.target.binding,
            outputId: `sha256:${"d".repeat(64)}`,
            partSize: 5 * 1024 * 1024,
          },
          availableUntil: opts.task.media.expiresAt,
        };
      if (mode === "bad-manifest") opts.task.media.signedManifest += "x";
      const source = opts.authorizeMedia;
      opts.authorizeMedia = async (signal) => {
        const grant = await source(signal);
        if (mode === "grant-generation") grant.binding.generation = crypto.randomUUID();
        if (mode === "grant-package") grant.binding.packageId = crypto.randomUUID();
        if (mode === "grant-key") grant.query.recipientKey.n = "b".repeat(342);
        return grant;
      };
      const destination = opts.authorizeUpload;
      opts.authorizeUpload = async (...args) => {
        const grant = await destination(...args);
        if (mode === "upload-generation") grant.binding.generation = crypto.randomUUID();
        if (mode === "upload-expiry")
          grant.expiresAt = new Date(Date.parse(grant.expiresAt) + 1000).toISOString();
        if (mode === "origin") grant.url = "https://untrusted.invalid/secret";
        return grant;
      };
      await expect(uploadFederationMediaFile(opts)).rejects.toThrow("MEDIA_UPLOAD_");
      expect(received).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

live.each([
  "corrupt",
  "hardlink",
  "symlink",
  "permissions",
  "metadata",
  "busy",
  "replace-during-put",
  "revoke-final",
  "put-fails",
  "cancel",
] as const)(
  "media upload refuses %s and never deletes the quarantined package",
  async (mode) => {
    const f = await fixture();
    try {
      if (mode === "corrupt") await writeFile(f.file, Buffer.alloc(f.bytes.length));
      if (mode === "hardlink") await link(f.file, `${f.file}.link`);
      if (mode === "symlink") {
        await rename(f.file, `${f.file}.old`);
        await symlink(`${f.file}.old`, f.file);
      }
      if (mode === "permissions") await chmod(f.file, 0o644);
      if (mode === "metadata") await writeFile(join(f.target, "manifest.jws"), "wrong");
      const source = f.upload.authorizeMedia;
      f.upload.authorizeMedia = async (signal) => {
        if (mode === "revoke-final" && received.length)
          throw new Error("revoked secret source URL");
        return source(signal);
      };
      const fetcher = f.upload.fetcher;
      const controller = new AbortController();
      if (mode === "cancel") f.upload.signal = controller.signal;
      f.upload.fetcher = async (url, init) => {
        if (mode === "put-fails") throw new Error("private /root/path?secret=token");
        if (!fetcher) throw new Error("missing fixture transport");
        const result = await fetcher(url, init);
        if (mode === "replace-during-put") {
          await rename(f.file, `${f.file}.old`);
          await writeFile(f.file, f.bytes, { mode: 0o600 });
        }
        if (mode === "cancel") controller.abort();
        return result;
      };
      const check = async () =>
        await expect(uploadFederationMediaFile(f.upload)).rejects.toThrow(/^MEDIA_UPLOAD_[A-Z_]+$/);
      if (mode === "busy") await withMediaWorkspace(f.parent, check);
      else await check();
      expect(await readdir(f.parent)).toContain(f.manifest.packageId);
      if (!["replace-during-put", "revoke-final", "cancel"].includes(mode))
        expect(received).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

live(
  "media permit shorter than refresh interval must be renewed, and a shortened source key limits the lease",
  async () => {
    const f = await mediaImportFixture();
    try {
      let grants = 0;
      const authorize = mediaImportAuthorization({
        ...f.options,
        authorize: async () => {
          const grant = await f.options.authorize();
          grants++;
          grant.expiresAt = new Date(Date.now() + 900).toISOString();
          return grant;
        },
      });
      await authorize();
      await authorize();
      expect(grants).toBe(2);
      const shortened = mediaImportAuthorization({
        ...f.options,
        authorize: async () => {
          const grant = await f.options.authorize();
          grant.signingKey = {
            ...grant.signingKey,
            validUntil: new Date(Date.now() + 1000).toISOString(),
          };
          return grant;
        },
      });
      await expect(shortened()).rejects.toThrow("MEDIA_LEASE_INVALID");
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

live.each(["complete", "revoke-second"] as const)(
  "multi-part media upload handles %s with a fresh source permit per part",
  async (mode) => {
    const f = await fixture("task-input", false, 5 * 1024 * 1024 + 17);
    try {
      const authorize = f.upload.authorizeMedia;
      f.upload.authorizeMedia = async (signal) => {
        if (mode === "revoke-second" && received.length) throw new Error("revoked");
        return authorize(signal);
      };
      if (mode === "revoke-second") {
        await expect(uploadFederationMediaFile(f.upload)).rejects.toThrow("MEDIA_UPLOAD_FAILED");
        expect(received.map((bytes) => bytes.length)).toEqual([5 * 1024 * 1024]);
      } else {
        const report = await uploadFederationMediaFile(f.upload);
        expect(report.copied.parts.map((part) => part.partNumber)).toEqual([1, 2]);
        expect(Buffer.concat(received)).toEqual(f.bytes);
      }
      expect(await readFile(f.file)).toEqual(f.bytes);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

live.each(["task-input", "task-result"] as const)(
  "media upload command %s sends real quarantined bytes over TLS and keeps generations separate",
  async (kind) => {
    const f = await fixture(kind);
    let client: FederationMediaUploadClient;
    const finished = Promise.withResolvers<
      FederationInputCopyReport | FederationResultCopyReport
    >();
    let sourceUntil = 0;
    const destination = (request: {
      requestId: string;
      bindingJson: string;
      partNumber?: number;
      upload: boolean;
    }) => {
      expect(request.upload).toBe(true);
      const binding = JSON.parse(request.bindingJson);
      const grant = {
        binding,
        direction: "upload",
        partNumber: request.partNumber,
        url: `${target.url}part/${request.partNumber}`,
        expiresAt: new Date(sourceUntil - 10).toISOString(),
      };
      queueMicrotask(() => {
        const response = {
          requestId: request.requestId,
          grantJson: JSON.stringify(grant),
          leaseExpiresAtUnixMs: BigInt(sourceUntil),
        };
        if (kind === "task-input")
          client.receive("input", create(FederationInputGrantResponseSchema, response));
        else client.receive("result", create(FederationResultGrantResponseSchema, response));
      });
      return true;
    };
    client = new FederationMediaUploadClient(
      {
        agentId: f.upload.task.media.agentId,
        roots: f.options.roots,
        inputOrigins: [target.url.origin],
        resultOrigins: [target.url.origin],
      },
      {
        media: (request) => {
          const parsed = FederationMediaImportKeyRequestSchema.parse(
            JSON.parse(request.bindingJson),
          );
          expect(parsed.purpose).toBe("task-upload");
          void f
            .authorizeForKey(parsed.recipientKey)
            .then((grant) => {
              grant.binding.manifestDigest = f.upload.task.media.manifestDigest;
              sourceUntil = Date.parse(grant.expiresAt);
              client.receive(
                "media",
                create(FederationMediaImportGrantResponseSchema, {
                  requestId: request.requestId,
                  grantJson: JSON.stringify(grant),
                  leaseExpiresAtUnixMs: BigInt(sourceUntil),
                }),
              );
            })
            .catch(() => client.disconnect());
          return true;
        },
        input: destination,
        result: destination,
        inputReport: (report) => finished.resolve(report),
        resultReport: (report) => finished.resolve(report),
      },
      undefined,
      (options) => uploadFederationMediaFile({ ...options, fetcher: f.upload.fetcher }),
    );
    try {
      client.start(
        create(FederationMediaUploadSchema, {
          taskJson: JSON.stringify(f.upload.task),
          leaseExpiresAtUnixMs: BigInt(Date.now() + 30_000),
        }),
      );
      const report = await finished.promise;
      expect(report.failed).toBe(false);
      expect(report.generation).toBe(f.upload.task.target.binding.generation);
      expect(report.generation).not.toBe(f.upload.task.media.generation);
      expect(JSON.parse(report.copiedJson).binding).toEqual(f.upload.task.target.binding);
      expect(hash(Buffer.concat(received))).toBe(hash(f.bytes));
      expect(received).toHaveLength(1);
      expect(await readFile(f.file)).toEqual(f.bytes);
    } finally {
      await client.disconnect();
      await f.cleanup();
    }
  },
);

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FederationMediaManifest,
  FederationMediaManifestSchema,
} from "@kuintessence/shared/federation";
import { AgentDataRoots } from "./local-data-security";
import { exportMediaArchive, mediaTarHeader, quarantineMediaArchive } from "./media-archive";

let root: string, quarantine: string, source: string, roots: AgentDataRoots;
const content = Buffer.from("scientific input\n");
const signedManifest = "trusted-manifest-fixture";
let manifest: FederationMediaManifest;
const verifyManifest = async (jws: string) => {
  if (jws !== signedManifest) throw new Error("INVALID_SIGNATURE");
  return manifest;
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kq-media-archive-"));
  source = join(root, "datasets", "v1");
  quarantine = join(root, "quarantine");
  await mkdir(source, { recursive: true, mode: 0o700 });
  await mkdir(quarantine, { mode: 0o700 });
  await mkdir(join(source, "data"), { mode: 0o700 });
  await writeFile(join(source, "data", "input.dat"), content);
  await writeFile(join(source, "empty"), "");
  roots = new AgentDataRoots({
    datasetRoot: join(root, "datasets"),
    managedRoots: { science: "." },
    jobWorkRoot: join(root, "jobs"),
  });
  await roots.initialize();
  manifest = FederationMediaManifestSchema.parse({
    protocolVersion: 1,
    kind: "media-manifest",
    packageId: crypto.randomUUID(),
    senderSiteId: crypto.randomUUID(),
    recipientSiteId: crypto.randomUUID(),
    agreementRevisionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    subject: {
      kind: "dataset",
      asset: {
        originSiteId: crypto.randomUUID(),
        kind: "dataset",
        id: crypto.randomUUID(),
        revision: "v1",
        digest: `sha256:${"a".repeat(64)}`,
      },
    },
    files: [
      {
        path: "data/input.dat",
        sizeBytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
        license: "CC-BY-4.0",
        provenance: { source: "institutional dataset", revision: "v1" },
      },
      {
        path: "empty",
        sizeBytes: 0,
        sha256: createHash("sha256").digest("hex"),
        license: null,
        provenance: null,
      },
    ],
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function exportStream() {
  return exportMediaArchive({
    signedManifest,
    verifyManifest,
    roots,
    managedRootId: "science",
    relativePath: "v1",
  });
}
async function archive(): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of exportStream()) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function* stream(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; offset += 317)
    yield bytes.subarray(offset, offset + 317);
}
function receive(
  bytes: Uint8Array,
  options: Partial<Parameters<typeof quarantineMediaArchive>[0]> = {},
) {
  return quarantineMediaArchive({
    stream: stream(bytes),
    quarantineRoot: quarantine,
    maxBytes: 1024 * 1024,
    reserveBytes: 1024 * 1024,
    verifyManifest,
    ...options,
  });
}

test("streams signed inventory and files into quarantine without publication or metadata loss", async () => {
  const result = await receive(await archive());
  expect(result.manifest).toEqual(manifest);
  expect(result.signedManifest).toBe(signedManifest);
  expect(await readFile(join(result.directory, "files/data/input.dat"))).toEqual(content);
  expect((await readFile(join(result.directory, "files/empty"))).length).toBe(0);
  expect(await readdir(quarantine)).toEqual([result.directory.split("/").at(-1) as string]);
  expect(await readdir(root)).toEqual(expect.arrayContaining(["quarantine", "datasets", "jobs"]));
});

test("rejects corruption, truncation, trailer and signature errors and removes partial trees", async () => {
  const bytes = await archive();
  for (const [offset, value] of [
    [512, 1],
    [1536, 1],
    [1536 + content.length, 1],
    [bytes.length - 1, 1],
  ]) {
    const changed = Buffer.from(bytes);
    changed[offset ?? 0] = value ?? 1;
    await expect(receive(changed)).rejects.toThrow();
    expect(await readdir(quarantine)).toEqual([]);
  }
  for (const length of [0, 511, 1024, 1540, bytes.length - 1]) {
    await expect(receive(bytes.subarray(0, length))).rejects.toThrow();
    expect(await readdir(quarantine)).toEqual([]);
  }
  await expect(receive(Buffer.concat([bytes, Buffer.from([0])]))).rejects.toThrow("TRAILING_DATA");
  expect(await readdir(quarantine)).toEqual([]);
});

test("rejects tar links, traversal, alternate formats and oversized entries before writing them", async () => {
  const bytes = await archive();
  for (const [offset, value] of [
    [1024, 46],
    [1024 + 156, 49],
    [1024 + 156, 50],
    [1024 + 156, 120],
    [1024 + 124, 55],
  ]) {
    const changed = Buffer.from(bytes);
    changed[offset ?? 0] = value ?? 1;
    await expect(receive(changed)).rejects.toThrow("FORMAT_INVALID");
    expect(await readdir(quarantine)).toEqual([]);
  }
  await expect(receive(bytes, { maxBytes: 1 })).rejects.toThrow("LIMIT_EXCEEDED");
  await expect(receive(bytes, { reserveBytes: Number.MAX_SAFE_INTEGER - 1024 })).rejects.toThrow(
    "STORAGE_INSUFFICIENT",
  );
  expect(await readdir(quarantine)).toEqual([]);
});

test("cannot import into public or symlink roots and rejects late decryption/authentication errors", async () => {
  const bytes = await archive();
  await chmod(quarantine, 0o755);
  await expect(receive(bytes)).rejects.toThrow("ROOT_INVALID");
  await chmod(quarantine, 0o700);
  const alias = join(root, "alias");
  await symlink(quarantine, alias);
  await expect(receive(bytes, { quarantineRoot: alias })).rejects.toThrow("ROOT_INVALID");
  await expect(
    receive(bytes, {
      stream: (async function* () {
        yield bytes;
        throw new Error("AGE_AUTH_FAILED");
      })(),
    }),
  ).rejects.toThrow("AGE_AUTH_FAILED");
  expect(await readdir(quarantine)).toEqual([]);
  await expect(
    receive(bytes, {
      stream: {
        [Symbol.asyncIterator]: () => {
          const iterator = stream(bytes)[Symbol.asyncIterator]();
          return {
            next: () => iterator.next(),
            return: async () => {
              throw new Error("STREAM_CLOSE_FAILED");
            },
          };
        },
      },
    }),
  ).rejects.toThrow("STREAM_CLOSE_FAILED");
  expect(await readdir(quarantine)).toEqual([]);
});

test("source hardlinks, intermediate symlinks, digest/size changes fail closed", async () => {
  const input = join(source, "data/input.dat");
  await link(input, join(root, "hardlink"));
  await expect(archive()).rejects.toThrow("SOURCE_INVALID");
  await rm(join(root, "hardlink"));
  await rm(input);
  await symlink(join(source, "empty"), input);
  await expect(archive()).rejects.toThrow("SOURCE_INVALID");
  await rm(join(source, "data"), { recursive: true });
  await symlink(root, join(source, "data"));
  await expect(archive()).rejects.toThrow("SOURCE_INVALID");
  await rm(join(source, "data"));
  await mkdir(join(source, "data"));
  await writeFile(input, Buffer.alloc(content.length, 1));
  await expect(archive()).rejects.toThrow("SOURCE_CHANGED");
  await writeFile(input, "short");
  await expect(archive()).rejects.toThrow("SOURCE_CHANGED");
});

test("abort during file read cleans quarantine and large stream chunks are bounded", async () => {
  const bytes = await archive();
  const abort = new AbortController();
  await expect(
    receive(bytes, {
      signal: abort.signal,
      stream: (async function* () {
        yield bytes.subarray(0, 1536);
        abort.abort(new Error("CANCELLED"));
        yield bytes.subarray(1536);
      })(),
    }),
  ).rejects.toThrow("CANCELLED");
  expect(await readdir(quarantine)).toEqual([]);
  await expect(
    receive(bytes, {
      stream: (async function* () {
        yield Buffer.alloc(1024 * 1024 + 1);
      })(),
    }),
  ).rejects.toThrow("CHUNK_TOO_LARGE");
});

test("TB-sized regular files use standard GNU base-256 tar fields without allocating their body", () => {
  const header = mediaTarHeader("files/000000", 1024 ** 4);
  expect(header[124]).toBe(0x80);
  expect(header.readBigUInt64BE(128)).toBe(1024n ** 4n);
  expect(header[156]).toBe(48);
  expect(header.subarray(257, 263).toString()).toBe("ustar\0");
});

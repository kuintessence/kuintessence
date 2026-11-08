import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, statfs } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  type FederationMediaExportReceipt,
  FederationMediaExportReceiptSchema,
  type FederationMediaExportTask,
  FederationMediaExportTaskSchema,
  FederationMediaManifestSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import type { MediaAge } from "@kuintessence/shared/federation/media-age";
import {
  parseFederationPublicKey,
  verifyFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import { z } from "zod";
import type { AgentDataRoots } from "./local-data-security";
import { exportMediaArchive } from "./media-archive";

const StoredReceipt = FederationMediaExportReceiptSchema.omit({ generation: true }).extend({
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const noFollow = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Publishes only complete encrypted packages under a locally configured private outbox. */
export async function exportFederationMedia(options: {
  task: FederationMediaExportTask;
  agentId: string;
  mediaDirectory: string;
  roots: AgentDataRoots;
  age: Pick<MediaAge, "encrypt">;
  signal: AbortSignal;
  authorize(signal: AbortSignal): Promise<void>;
}): Promise<FederationMediaExportReceipt> {
  const { signal } = options;
  const task = FederationMediaExportTaskSchema.parse(options.task);
  if (task.agentId !== options.agentId) throw new Error("MEDIA_AGENT_MISMATCH");
  let lastAuthorization = 0;
  const authorize = async (force = false) => {
    signal.throwIfAborted();
    if (Date.parse(task.expiresAt) <= Date.now()) throw new Error("MEDIA_APPROVAL_EXPIRED");
    if (force || Date.now() - lastAuthorization >= 15_000) {
      await options.authorize(signal);
      signal.throwIfAborted();
      lastAuthorization = Date.now();
    }
  };
  await authorize(true);
  const verified = await verifyFederationMessage(
    FederationMediaManifestSchema,
    task.signedManifest,
    {
      ...task.signingKey,
      siteId: task.sourceSiteId,
      publicKey: await parseFederationPublicKey(task.signingKey.publicKeyPem),
      validFrom: new Date(task.signingKey.validFrom),
      validUntil: new Date(task.signingKey.validUntil),
      allowedKinds: ["media-manifest"],
      revoked: false,
    },
    new Date(),
  );
  const manifest = verified.payload;
  if (
    verified.digest !== task.manifestDigest ||
    manifest.packageId !== task.packageId ||
    manifest.senderSiteId !== task.sourceSiteId ||
    manifest.recipientSiteId !== task.recipientSiteId
  )
    throw new Error("MEDIA_MANIFEST_MISMATCH");
  const sourceDigest = createHash("sha256")
    .update(
      federationCanonicalJson({
        agentId: task.agentId,
        sourceSiteId: task.sourceSiteId,
        recipientSiteId: task.recipientSiteId,
        packageId: task.packageId,
        manifestDigest: task.manifestDigest,
        managedRootId: task.managedRootId,
        relativePath: task.relativePath,
        recipient: task.recipient,
      }),
    )
    .digest("hex");
  const root = await privateDirectory(options.mediaDirectory);
  const outbox = await privateDirectory(join(root, "outbox"));
  const target = join(outbox, task.packageId);
  async function existing(): Promise<FederationMediaExportReceipt | undefined> {
    try {
      await privateDirectory(target, false);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const metadata = await open(join(target, "receipt.json"), noFollow);
    let stored: z.infer<typeof StoredReceipt>;
    try {
      const stat = await metadata.stat();
      if (!stat.isFile() || stat.size > 8192) throw new Error("MEDIA_RECEIPT_INVALID");
      stored = StoredReceipt.parse(JSON.parse(await metadata.readFile("utf8")));
    } finally {
      await metadata.close();
    }
    if (
      stored.sourceDigest !== sourceDigest ||
      stored.packageId !== task.packageId ||
      stored.manifestDigest !== task.manifestDigest
    )
      throw new Error("MEDIA_EXPORT_CONFLICT");
    const file = await open(join(target, "bundle.age"), noFollow);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== stored.sizeBytes) throw new Error("MEDIA_EXPORT_CHANGED");
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        await authorize();
        hash.update(chunk);
      }
      if (hash.digest("hex") !== stored.sha256) throw new Error("MEDIA_EXPORT_CHANGED");
    } finally {
      await file.close();
    }
    await authorize(true);
    await syncDirectory(target);
    await syncDirectory(outbox);
    return FederationMediaExportReceiptSchema.parse({
      generation: task.generation,
      packageId: task.packageId,
      manifestDigest: task.manifestDigest,
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
    });
  }
  const prior = await existing();
  if (prior) return prior;
  const total = manifest.files.reduce((sum, file) => sum + BigInt(file.sizeBytes), 0n);
  const space = await statfs(outbox, { bigint: true });
  if (space.bavail * space.bsize < total + total / 50n + 65n * 1024n ** 2n || space.ffree < 4n)
    throw new Error("MEDIA_STORAGE_INSUFFICIENT");
  const temporary = await mkdtemp(join(outbox, `.export-${task.packageId}-`));
  try {
    const file = await open(join(temporary, "bundle.age"), "wx", 0o600);
    let sizeBytes = 0;
    const hash = createHash("sha256");
    try {
      const archive = exportMediaArchive({
        signedManifest: task.signedManifest,
        verifyManifest: async (jws) => {
          if (jws !== task.signedManifest) throw new Error("MEDIA_MANIFEST_MISMATCH");
          return manifest;
        },
        roots: options.roots,
        managedRootId: task.managedRootId,
        relativePath: task.relativePath,
        signal,
      });
      for await (const chunk of options.age.encrypt(archive, task.recipient, signal)) {
        await authorize();
        sizeBytes += chunk.byteLength;
        if (sizeBytes > 6 * 1024 ** 4) throw new Error("MEDIA_EXPORT_TOO_LARGE");
        await file.writeFile(chunk);
        hash.update(chunk);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    const receipt = FederationMediaExportReceiptSchema.parse({
      generation: task.generation,
      packageId: task.packageId,
      manifestDigest: task.manifestDigest,
      sha256: hash.digest("hex"),
      sizeBytes,
    });
    const metadata = await open(join(temporary, "receipt.json"), "wx", 0o600);
    try {
      const { generation: _generation, ...contents } = receipt;
      await metadata.writeFile(JSON.stringify({ ...contents, sourceDigest }));
      await metadata.sync();
    } finally {
      await metadata.close();
    }
    await syncDirectory(temporary);
    await authorize(true);
    try {
      // A completed target is nonempty: rename cannot replace another completed package.
      await rename(temporary, target);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EEXIST", "ENOTEMPTY"].includes(String(error.code))
      )
        throw error;
      const winner = await existing();
      if (!winner) throw error;
      return winner;
    }
    await syncDirectory(outbox);
    return receipt;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function privateDirectory(path: string, create = true) {
  if (!isAbsolute(path) || resolve(path) === "/") throw new Error("MEDIA_ROOT_INVALID");
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  const canonical = await realpath(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonical !== resolve(path) ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("MEDIA_ROOT_INVALID");
  return canonical;
}
async function syncDirectory(path: string) {
  const handle = await open(path, noFollow | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

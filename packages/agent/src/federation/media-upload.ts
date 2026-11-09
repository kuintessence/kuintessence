import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import {
  FederationInputCopyGrantSchema,
  type FederationMediaImportGrant,
  type FederationMediaRecipientKey,
  type FederationMediaUploadTask,
  FederationMediaUploadTaskSchema,
  FederationResultCopyGrantSchema,
} from "@kuintessence/shared/federation";
import type { AgentDataRoots } from "../data-market/local-data-security";
import { privateMediaDirectory } from "../data-market/media-archive";
import {
  mediaImportAuthorization,
  verifyMediaImportManifest,
} from "../data-market/media-authority";
import { withMediaWorkspace } from "../data-market/media-workspace";
import { uploadFederationFile } from "./file-copy";

type Target = FederationMediaUploadTask["target"];
type UploadGrant =
  | ReturnType<typeof FederationInputCopyGrantSchema.parse>
  | ReturnType<typeof FederationResultCopyGrantSchema.parse>;

export class FederationMediaUploadError extends Error {
  constructor(code: "INVALID_TASK" | "SOURCE_CHANGED" | "FAILED" | "CANCELLED") {
    super(`MEDIA_UPLOAD_${code}`);
  }
}

/** Returns uncommitted multipart parts. Only the Server may verify and publish the whole import. */
export async function uploadFederationMediaFile(options: {
  task: FederationMediaUploadTask;
  agentId: string;
  roots: AgentDataRoots;
  recipientKey: FederationMediaRecipientKey;
  signal: AbortSignal;
  allowedDestinationOrigins: readonly string[];
  authorizeMedia(signal: AbortSignal): Promise<FederationMediaImportGrant>;
  authorizeUpload(target: Target, partNumber: number, signal: AbortSignal): Promise<UploadGrant>;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}) {
  const { signal } = options;
  try {
    const task = FederationMediaUploadTaskSchema.parse(options.task);
    const { media, target } = task;
    const manifest = await verifyMediaImportManifest(media);
    const member = manifest.files[task.memberIndex];
    if (
      media.agentId !== options.agentId ||
      manifest.subject.kind === "dataset" ||
      manifest.subject.kind !== target.kind ||
      manifest.subject.operationId !== target.binding.operationId ||
      manifest.subject.contentDigest !== target.binding.manifestDigest ||
      !member ||
      member.path !== `objects/${String(task.memberIndex).padStart(6, "0")}` ||
      member.sizeBytes !== target.binding.sizeBytes ||
      member.sha256 !== target.binding.sha256 ||
      manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0) > media.maxBytes ||
      Date.parse(target.availableUntil) <= Date.now()
    )
      throw new FederationMediaUploadError("INVALID_TASK");
    const authorize = mediaImportAuthorization({
      task: media,
      recipientKey: options.recipientKey,
      signal,
      authorize: options.authorizeMedia,
    });
    await authorize(true);
    const root = await options.roots.resolveManagedDataPath(media.managedRootId, ".");
    const parent = join(root, ".federation-media");
    return await withMediaWorkspace(parent, async () => {
      const directory = join(parent, media.packageId);
      const folders = [
        root,
        parent,
        directory,
        join(directory, "files"),
        join(directory, "files", "objects"),
      ];
      const before = [];
      for (const folder of folders) {
        await privateMediaDirectory(folder);
        before.push(await lstat(folder));
      }
      const readOnly = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
      const metadataPath = join(directory, "manifest.jws");
      const metadata = await open(metadataPath, readOnly);
      try {
        const metadataStat = await metadata.stat();
        assertPrivateFile(metadataStat);
        if (
          metadataStat.size > 400_000 ||
          (await metadata.readFile("utf8")) !== media.signedManifest
        )
          throw new FederationMediaUploadError("SOURCE_CHANGED");
        const path = join(directory, "files", member.path);
        const handle = await open(path, readOnly);
        try {
          const initial = await handle.stat();
          assertPrivateFile(initial);
          if (initial.size !== member.sizeBytes || !sameFile(initial, await lstat(path)))
            throw new FederationMediaUploadError("SOURCE_CHANGED");
          const hash = createHash("sha256");
          const buffer = Buffer.alloc(Math.min(64 * 1024, member.sizeBytes));
          let offset = 0;
          while (offset < member.sizeBytes) {
            await authorize();
            const { bytesRead } = await handle.read(
              buffer,
              0,
              Math.min(buffer.length, member.sizeBytes - offset),
              offset,
            );
            signal.throwIfAborted();
            if (!bytesRead) throw new FederationMediaUploadError("SOURCE_CHANGED");
            hash.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
          }
          if (hash.digest("hex") !== member.sha256 || !sameFile(initial, await handle.stat()))
            throw new FederationMediaUploadError("SOURCE_CHANGED");
          const common = {
            fileHandle: handle,
            availableUntil: new Date(
              Math.min(Date.parse(media.expiresAt), Date.parse(target.availableUntil)),
            ).toISOString(),
            allowedDestinationOrigins: options.allowedDestinationOrigins,
            signal,
            fetcher: options.fetcher,
            authorizeRead: async () => {
              await authorize();
            },
          };
          async function uploadGrant(partNumber: number, requestSignal: AbortSignal) {
            const source = await authorize(true);
            const grant = await options.authorizeUpload(
              structuredClone(target),
              partNumber,
              requestSignal,
            );
            if (Date.parse(grant.expiresAt) > source.expiresAt || source.expiresAt <= Date.now())
              throw new FederationMediaUploadError("FAILED");
            return grant;
          }
          const copied =
            target.kind === "task-input"
              ? await uploadFederationFile({
                  ...common,
                  binding: target.binding,
                  partSize: target.partSize,
                  grantSchema: FederationInputCopyGrantSchema,
                  authorize: async (part, grantSignal) =>
                    FederationInputCopyGrantSchema.parse(await uploadGrant(part, grantSignal)),
                })
              : await uploadFederationFile({
                  ...common,
                  binding: target.binding,
                  partSize: target.binding.partSize,
                  grantSchema: FederationResultCopyGrantSchema,
                  authorize: async (part, grantSignal) =>
                    FederationResultCopyGrantSchema.parse(await uploadGrant(part, grantSignal)),
                });
          if (
            !sameFile(initial, await handle.stat()) ||
            !sameFile(initial, await lstat(path)) ||
            !sameFile(metadataStat, await metadata.stat()) ||
            !sameFile(metadataStat, await lstat(metadataPath))
          )
            throw new FederationMediaUploadError("SOURCE_CHANGED");
          for (const [index, folder] of folders.entries()) {
            await privateMediaDirectory(folder);
            const after = await lstat(folder);
            if (after.ino !== before[index]?.ino || after.dev !== before[index]?.dev)
              throw new FederationMediaUploadError("SOURCE_CHANGED");
          }
          await authorize(true);
          if (Date.parse(target.availableUntil) <= Date.now())
            throw new FederationMediaUploadError("FAILED");
          signal.throwIfAborted();
          return {
            media: {
              generation: media.generation,
              packageId: media.packageId,
              authorizationId: media.authorizationId,
              manifestDigest: media.manifestDigest,
            },
            memberIndex: task.memberIndex,
            kind: target.kind,
            copied,
          };
        } finally {
          await handle.close();
        }
      } finally {
        await metadata.close();
      }
    });
  } catch (error) {
    if (signal.aborted) throw new FederationMediaUploadError("CANCELLED");
    if (error instanceof FederationMediaUploadError) throw error;
    throw new FederationMediaUploadError("FAILED");
  }
}

function assertPrivateFile(stat: Stats) {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new FederationMediaUploadError("SOURCE_CHANGED");
}
function sameFile(a: Stats, b: Stats) {
  return (
    b.isFile() &&
    a.ino === b.ino &&
    a.dev === b.dev &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.nlink === b.nlink &&
    a.mode === b.mode &&
    a.uid === b.uid
  );
}

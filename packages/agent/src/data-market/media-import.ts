import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type FederationMediaImportGrant,
  type FederationMediaImportTask,
  FederationMediaImportTaskSchema,
  type FederationMediaImportVerified,
  type FederationMediaRecipientKey,
} from "@kuintessence/shared/federation";
import type { MediaAge } from "@kuintessence/shared/federation/media-age";
import { decryptFederationMediaIdentity } from "@kuintessence/shared/federation/media-key-crypto";
import type { AgentDataRoots } from "./local-data-security";
import { exportMediaArchive, privateMediaDirectory, quarantineMediaArchive } from "./media-archive";

import { mediaImportAuthorization, verifyMediaImportManifest } from "./media-authority";
import { withMediaWorkspace } from "./media-workspace";

const readOnly = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** Verifies and retains private imported files. This does not publish a Data Market location. */
export async function importFederationMedia(options: {
  task: FederationMediaImportTask;
  agentId: string;
  mediaDirectory: string;
  roots: AgentDataRoots;
  age: Pick<MediaAge, "decrypt">;
  privateKey: CryptoKey;
  recipientKey: FederationMediaRecipientKey;
  signal: AbortSignal;
  authorize(signal: AbortSignal): Promise<FederationMediaImportGrant>;
}): Promise<FederationMediaImportVerified> {
  const task = FederationMediaImportTaskSchema.parse(options.task);
  const { signal } = options;
  if (task.agentId !== options.agentId) throw new Error("MEDIA_AGENT_MISMATCH");
  const manifest = await verifyMediaImportManifest(task);
  const sizeBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (sizeBytes > task.maxBytes) throw new Error("MEDIA_STORAGE_LIMIT_EXCEEDED");
  const managedRoot = await options.roots.resolveManagedDataPath(task.managedRootId, ".");
  await privateMediaDirectory(managedRoot);
  const parent = join(managedRoot, ".federation-media");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await privateMediaDirectory(parent);
  const target = join(parent, task.packageId);
  const authorize = mediaImportAuthorization({ ...options, task });
  const verifyManifest = async (jws: string) => {
    if (jws !== task.signedManifest) throw new Error("MEDIA_MANIFEST_MISMATCH");
    return manifest;
  };
  const report = async (): Promise<FederationMediaImportVerified> => {
    const current = await authorize();
    return {
      generation: task.generation,
      packageId: task.packageId,
      authorizationId: task.authorizationId,
      manifestDigest: task.manifestDigest,
      state: "verified",
      queryDigest: current.queryDigest,
      sizeBytes,
    };
  };
  async function existing() {
    try {
      await privateMediaDirectory(target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
    const stored = await open(join(target, "manifest.jws"), readOnly);
    try {
      const stat = await stored.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 400_000 ||
        (await stored.readFile("utf8")) !== task.signedManifest
      )
        throw new Error("MEDIA_IMPORT_CONFLICT");
    } finally {
      await stored.close();
    }
    await authorize(true);
    await privateMediaDirectory(join(target, "files"));
    await inventory(
      join(target, "files"),
      manifest.files.map((file) => file.path),
      signal,
    );
    for await (const _chunk of exportMediaArchive({
      roots: options.roots,
      managedRootId: task.managedRootId,
      relativePath: `.federation-media/${task.packageId}/files`,
      signedManifest: task.signedManifest,
      verifyManifest,
      signal,
    }))
      await authorize();
    await authorize(true);
    await syncDirectories(
      target,
      manifest.files.map((file) => file.path),
    );
    await syncDirectory(parent);
    return true;
  }
  return withMediaWorkspace(parent, async (workspace) => {
    if (await existing()) return report();
    await privateMediaDirectory(options.mediaDirectory);
    const inbox = join(options.mediaDirectory, "inbox", task.packageId);
    await privateMediaDirectory(inbox);
    const ciphertext = join(inbox, "bundle.age");
    const before = await lstat(ciphertext);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > 6 * 1024 ** 4
    )
      throw new Error("MEDIA_CIPHERTEXT_INVALID");
    const grant = await authorize(true);
    const identity = await decryptFederationMediaIdentity(
      grant.encryptedIdentity,
      options.privateKey,
      grant.queryDigest,
    );
    let temporary: string | undefined;
    try {
      await mkdir(workspace, { mode: 0o700 });
      async function* plaintext() {
        for await (const chunk of options.age.decrypt(ciphertext, identity, signal)) {
          await authorize();
          yield chunk;
        }
      }
      const imported = await quarantineMediaArchive({
        stream: plaintext(),
        quarantineRoot: workspace,
        maxBytes: task.maxBytes,
        reserveBytes: 64 * 1024 * 1024,
        verifyManifest,
        signal,
      });
      temporary = imported.directory;
      const after = await lstat(ciphertext);
      if (
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error("MEDIA_CIPHERTEXT_CHANGED");
      const metadata = await open(join(temporary, "manifest.jws"), "wx", 0o600);
      try {
        await metadata.writeFile(task.signedManifest);
        await metadata.sync();
      } finally {
        await metadata.close();
      }
      await syncDirectories(
        temporary,
        manifest.files.map((file) => file.path),
      );
      await authorize(true);
      try {
        await rename(temporary, target);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          !["EEXIST", "ENOTEMPTY"].includes(String(error.code))
        )
          throw error;
        if (!(await existing())) throw error;
      }
      await syncDirectory(parent);
      return report();
    } finally {
      identity.fill(0);
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  });
}

async function inventory(root: string, files: string[], signal: AbortSignal) {
  const expected = new Set(files);
  const directories = new Set(
    files.flatMap((file) =>
      file
        .split("/")
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
    ),
  );
  const pending = [""];
  while (pending.length) {
    signal.throwIfAborted();
    const relative = pending.pop() ?? "";
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && directories.delete(name)) pending.push(name);
      else if (!entry.isFile() || !expected.delete(name)) throw new Error("MEDIA_IMPORT_CHANGED");
    }
  }
  if (expected.size || directories.size) throw new Error("MEDIA_IMPORT_CHANGED");
}
async function syncDirectories(root: string, files: string[]) {
  const directories = new Set([
    "",
    "files",
    ...files.flatMap((file) =>
      file
        .split("/")
        .slice(0, -1)
        .map((_, i, parts) => `files/${parts.slice(0, i + 1).join("/")}`),
    ),
  ]);
  for (const path of [...directories].sort((a, b) => b.length - a.length))
    await syncDirectory(join(root, path));
}
async function syncDirectory(path: string) {
  const handle = await open(path, readOnly | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

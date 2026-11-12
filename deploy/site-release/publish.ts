/** Usage: bun publish.ts manifest.json artifact-dir release-dir channel private-key.pem */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isFormalReleaseChannel, siteReleaseManifestSchema as siteReleaseSchema } from "./manifest";
import {
  sha256,
  sourceArchiveSchema,
  sourceProvenanceSchema,
  validateProvenance,
} from "./source-provenance";

export async function publishSiteRelease(
  manifestPath: string,
  source: string,
  root: string,
  channel: string,
  keyPath: string,
) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(channel)) throw new Error("Invalid channel");
  const channels = join(root, "channels");
  await mkdir(channels, { recursive: true });
  const lock = join(channels, `.${channel}.publish-lock`);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Channel publication already locked; retry after the publisher finishes; never remove a live publisher lock",
      );
    throw error;
  }
  try {
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { mode: 0o600, flag: "wx" },
    );
    return await publishLocked(manifestPath, source, root, channel, keyPath);
  } finally {
    await rm(lock, { recursive: true });
  }
}

async function publishLocked(
  manifestPath: string,
  source: string,
  root: string,
  channel: string,
  keyPath: string,
) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(channel)) throw new Error("Invalid channel");
  const key = createPrivateKey(await readFile(keyPath));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 signing key required");
  const bytes = await readFile(manifestPath);
  const manifest = siteReleaseSchema.parse(JSON.parse(bytes.toString("utf8")));
  const id = createHash("sha256").update(bytes).digest("hex");
  const releases = join(root, "releases");
  const channelPath = join(root, "channels", channel);
  const oldId = await readFile(channelPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (oldId) {
    if (!/^[a-f0-9]{64}\n?$/.test(oldId)) throw new Error("Invalid channel pointer");
    const old = siteReleaseSchema.parse(
      JSON.parse(await readFile(join(releases, oldId.trim(), "manifest.json"), "utf8")),
    );
    if (
      manifest.sequence < old.sequence ||
      (manifest.sequence === old.sequence && id !== oldId.trim())
    )
      throw new Error("Channel sequence must increase");
  }
  await mkdir(releases, { recursive: true });
  const staging = join(releases, `.${id}-${crypto.randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  async function verifyFile(path: string, artifact: (typeof manifest.files)[number]) {
    const file = Bun.file(path);
    if (file.size !== artifact.size) throw new Error("Artifact size mismatch");
    const hash = createHash("sha256");
    for await (const chunk of file.stream()) hash.update(chunk);
    if (hash.digest("hex") !== artifact.sha256) throw new Error("Artifact digest mismatch");
  }
  try {
    for (const artifact of manifest.files) {
      const sourceFile = await lstat(join(source, artifact.name));
      if (!sourceFile.isFile() || sourceFile.isSymbolicLink())
        throw new Error("Release artifact must be a regular file");
      const destination = join(staging, artifact.name);
      await copyFile(join(source, artifact.name), destination);
      await verifyFile(destination, artifact);
      await chmod(destination, artifact.executable ? 0o500 : 0o400);
    }
    if (isFormalReleaseChannel(channel)) {
      const provenanceArtifact = manifest.files.find(
        (file) =>
          file.name === "source-provenance.json" && file.role === "tool" && !file.executable,
      );
      if (!provenanceArtifact || provenanceArtifact.size > 32 * 1024 ** 2)
        throw new Error("Formal channel requires complete source provenance");
      const provenance = sourceProvenanceSchema.parse(
        JSON.parse(await readFile(join(staging, provenanceArtifact.name), "utf8")),
      );
      const archiveArtifact = manifest.files.find(
        (file) => file.name === provenance.archive.name && file.role === "tool" && !file.executable,
      );
      if (
        !archiveArtifact ||
        archiveArtifact.size > 360 * 1024 ** 2 ||
        archiveArtifact.size !== provenance.archive.size ||
        archiveArtifact.sha256 !== provenance.archive.sha256 ||
        provenance.sourceRevision !== manifest.serverRevision
      )
        throw new Error("Formal source archive does not match signed manifest");
      const archiveBytes = await readFile(join(staging, archiveArtifact.name));
      if (sha256(archiveBytes) !== provenance.archive.sha256)
        throw new Error("Source archive digest mismatch");
      const archive = sourceArchiveSchema.parse(JSON.parse(archiveBytes.toString("utf8")));
      validateProvenance(provenance, archive);
    }
    await writeFile(join(staging, "manifest.json"), bytes, { mode: 0o400 });
    const signature = sign(null, bytes, key);
    await writeFile(join(staging, "manifest.sig"), signature, { mode: 0o400 });
    try {
      await rename(staging, join(releases, id));
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      const existing = join(releases, id);
      if (
        !(await readFile(join(existing, "manifest.json"))).equals(bytes) ||
        !(await readFile(join(existing, "manifest.sig"))).equals(signature)
      )
        throw new Error("Immutable release differs");
      for (const artifact of manifest.files)
        await verifyFile(join(existing, artifact.name), artifact);
    }
    await mkdir(join(root, "channels"), { recursive: true });
    const pointer = join(root, "channels", `.${channel}-${crypto.randomUUID()}`);
    await writeFile(pointer, `${id}\n`);
    await rename(pointer, channelPath);
    return id;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [manifestPath, source, root, channel, keyPath] = process.argv.slice(2);
  if (!manifestPath || !source || !root || !keyPath || !channel)
    throw new Error(
      "Expected manifest, artifact directory, release directory, channel and Ed25519 private key",
    );
  console.log(
    `Published ${await publishSiteRelease(manifestPath, source, root, channel, keyPath)} to ${channel}; no services restarted`,
  );
}

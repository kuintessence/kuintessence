import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import type { SandboxDispatchIdentity, SandboxUnsignedManifest } from "@kuintessence/shared";
import type { SandboxJobIdentity, SandboxJobMount, SandboxJobSpec } from "../adapters/base";
import type { SandboxInputDownload } from "./input-downloader";
import { assertSelfAccountIdentity, type VerifiedSandboxManifest } from "./manifest-verifier";
import type { SandboxProcessIdentity } from "./runtime-attestation";

export interface SandboxInputSource {
  stagePath: string;
  sourceUrl: string;
  deliveryLeaseId?: string;
  deliveryLeaseExpiresAtUnixMs?: bigint;
}

export interface SandboxStagerOptions {
  root: string;
  kubernetesArtifactPvc?: string;
  ownerUid?: number;
  processIdentity?: SandboxProcessIdentity;
  downloadInput?: (input: SandboxInputDownload) => Promise<void>;
}

export interface SandboxOutputFact {
  descriptor: string;
  sha256: string;
  sizeBytes: number;
  storageRef: string;
}

function pathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function assertNoSymlink(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  if (rel.startsWith("..") || resolve(root, rel) !== target) {
    throw new Error("Sandbox path escapes the managed run directory");
  }
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const value = await lstat(current);
      if (value.isSymbolicLink()) throw new Error("Sandbox path contains a symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
  }
}

async function hashFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(content);
    sizeBytes += content.byteLength;
  }
  return {
    sha256: hash.digest("hex"),
    sizeBytes,
  };
}

async function hashDirectory(path: string): Promise<{
  sha256: string;
  sizeBytes: number;
  facts: Array<{ relativePath: string; sha256: string; sizeBytes: number }>;
}> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const facts: Array<{ relativePath: string; sha256: string; sizeBytes: number }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Sandbox FileBatch cannot contain symbolic links");
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) throw new Error("Sandbox FileBatch contains an unsupported file type");
      const relativePath = relative(path, entryPath);
      const file = await hashFile(entryPath);
      facts.push({ relativePath, ...file });
      sizeBytes += file.sizeBytes;
    }
  };
  await visit(path);
  for (const fact of facts.toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update(`${fact.relativePath}\0${fact.sizeBytes}\0${fact.sha256}\n`);
  }
  return { sha256: hash.digest("hex"), sizeBytes, facts };
}

async function hashMount(path: string, ioType: SandboxJobMount["ioType"]) {
  const value = await stat(path);
  if (ioType === "FileBatch") {
    if (!value.isDirectory()) throw new Error("Sandbox FileBatch mount must be a directory");
    return hashDirectory(path);
  }
  if (!value.isFile()) throw new Error(`Sandbox ${ioType} mount must be a regular file`);
  if (ioType === "JSON") JSON.parse(await readFile(path, "utf8"));
  return hashFile(path);
}

async function verifyReadOnlyMount(mount: SandboxJobMount, hostPath: string): Promise<void> {
  const fact = await hashMount(hostPath, mount.ioType);
  if (mount.ioType === "FileBatch") {
    const actualEntries = "facts" in fact ? fact.facts : [];
    const expectedEntries = (mount.batchEntries ?? []).toSorted((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
    if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
      throw new Error(`Sandbox FileBatch entries mismatch for ${mount.descriptor}`);
    }
  }
  if (fact.sha256 !== mount.expectedSha256) {
    throw new Error(`Sandbox input hash mismatch for ${mount.descriptor}`);
  }
  if (fact.sizeBytes > mount.sizeLimitBytes) {
    throw new Error(`Sandbox input exceeds size limit for ${mount.descriptor}`);
  }
}

interface SandboxFileOwner {
  uid: number;
  gid: number;
  mayChown: boolean;
}

function isCanonicalAbsolutePath(value: string | undefined): value is string {
  return !!value && /^\/[^\0\r\n ]+$/.test(value) && !value.split("/").includes("..");
}

async function assignSandboxOwner(path: string, owner: SandboxFileOwner): Promise<void> {
  if (owner.mayChown) {
    await chown(path, owner.uid, owner.gid);
    return;
  }
  const value = await lstat(path);
  if (value.uid !== owner.uid || value.gid !== owner.gid) {
    throw new Error("SelfAccount Sandbox path is not owned by the current Agent process account");
  }
}

async function writeManagedFile(
  path: string,
  content: string | Uint8Array,
  owner: SandboxFileOwner,
): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o440 });
  await assignSandboxOwner(temporary, owner);
  await rename(temporary, path);
  await assignSandboxOwner(path, owner);
}

async function protectReadOnlyPath(path: string, owner: SandboxFileOwner): Promise<void> {
  const value = await lstat(path);
  if (value.isSymbolicLink()) throw new Error("Sandbox input contains a symbolic link");
  await assignSandboxOwner(path, owner);
  if (!value.isDirectory()) {
    await chmod(path, 0o440);
    return;
  }
  await chmod(path, 0o550);
  const entries = await readdir(path);
  for (const entry of entries) await protectReadOnlyPath(join(path, entry), owner);
}

function createContext(manifest: SandboxUnsignedManifest): string {
  return JSON.stringify(
    {
      jobId: manifest.jobId,
      inputs: Object.fromEntries(
        manifest.mounts
          .filter((mount) => mount.mode === "ReadOnly")
          .map((mount) => [mount.descriptor, { type: mount.ioType, path: mount.containerPath }]),
      ),
      outputs: Object.fromEntries(
        manifest.mounts
          .filter((mount) => mount.mode === "WriteOnly")
          .map((mount) => [mount.descriptor, { type: mount.ioType, path: mount.containerPath }]),
      ),
    },
    null,
    2,
  );
}

function jobIdentity(identity: SandboxDispatchIdentity): SandboxJobIdentity {
  if (identity.backend === "Unix") {
    return {
      ...identity,
      schedulerAccount: identity.schedulerAccount ?? undefined,
    };
  }
  return { ...identity, quotaPolicy: identity.quotaPolicy ?? undefined };
}

function jobMount(
  mount: SandboxUnsignedManifest["mounts"][number],
  hostPath: string,
): SandboxJobMount {
  return {
    ...mount,
    hostPath,
    expectedSha256: mount.expectedSha256 ?? undefined,
    inlineContentBase64: mount.inlineContentBase64 ?? undefined,
  };
}

function selfAccountRuntimeFacts(verified: VerifiedSandboxManifest): {
  runtimeAttestationId: string;
  apptainerPath: string;
  seccompProfilePath: string;
  attestedNodes: string[];
} {
  if (
    !verified.unsigned.runtimeAttestationId ||
    verified.unsigned.runtimeAttestationId !== verified.runtimeAttestationId ||
    !isCanonicalAbsolutePath(verified.apptainerPath) ||
    !isCanonicalAbsolutePath(verified.seccompProfilePath) ||
    !verified.attestedNodes?.length ||
    verified.attestedNodes.some((node) => !/^[A-Za-z0-9._-]{1,255}$/.test(node))
  ) {
    throw new Error("SelfAccount Sandbox is missing locally attested runtime facts");
  }
  return {
    runtimeAttestationId: verified.runtimeAttestationId,
    apptainerPath: verified.apptainerPath,
    seccompProfilePath: verified.seccompProfilePath,
    attestedNodes: [...verified.attestedNodes],
  };
}

function expectedExternalInputs(manifest: SandboxUnsignedManifest) {
  const expected = new Map<string, { maxBytes: number }>();
  for (const mount of manifest.mounts) {
    if (mount.mode !== "ReadOnly" || mount.inlineContentBase64) continue;
    if (mount.ioType === "FileBatch") {
      for (const entry of mount.batchEntries) {
        const stagePath = posix.join(mount.relativePath, entry.relativePath);
        if (expected.has(stagePath)) throw new Error("Sandbox manifest has duplicate input paths");
        expected.set(stagePath, { maxBytes: entry.sizeBytes });
      }
      continue;
    }
    if (expected.has(mount.relativePath)) {
      throw new Error("Sandbox manifest has duplicate input paths");
    }
    expected.set(mount.relativePath, { maxBytes: mount.sizeLimitBytes });
  }
  return expected;
}

async function materializeExternalInputs(
  verified: VerifiedSandboxManifest,
  collectionDir: string,
  sources: SandboxInputSource[],
  downloadInput: SandboxStagerOptions["downloadInput"],
): Promise<void> {
  const expected = expectedExternalInputs(verified.unsigned);
  if (downloadInput) {
    const supplied = new Map<string, SandboxInputSource>();
    for (const source of sources) {
      if (
        !source.stagePath ||
        posix.isAbsolute(source.stagePath) ||
        posix.normalize(source.stagePath) !== source.stagePath ||
        source.stagePath.split("/").includes("..") ||
        !source.sourceUrl.trim()
      ) {
        throw new Error("Sandbox input source path or URL is invalid");
      }
      assertDeliveryLease(source);
      if (supplied.has(source.stagePath)) throw new Error("Sandbox input source is duplicated");
      supplied.set(source.stagePath, source);
    }
    if (supplied.size !== expected.size) {
      throw new Error("Sandbox input sources do not match the signed manifest");
    }
    for (const [stagePath, limits] of expected) {
      const source = supplied.get(stagePath);
      if (!source) throw new Error("Sandbox input sources do not match the signed manifest");
      const targetPath = resolve(collectionDir, stagePath);
      if (!pathInside(collectionDir, targetPath)) {
        throw new Error("Sandbox input source escaped the managed run directory");
      }
      const parent = dirname(targetPath);
      await assertNoSymlink(collectionDir, parent);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await assertNoSymlink(collectionDir, parent);
      await assertNoSymlink(collectionDir, targetPath);
      await downloadInput({
        sourceUrl: source.sourceUrl,
        targetPath,
        maxBytes: limits.maxBytes,
      });
      await assertNoSymlink(collectionDir, targetPath);
    }
  } else if (sources.length > 0) {
    throw new Error("Sandbox input downloader is unavailable");
  }
  for (const mount of verified.unsigned.mounts) {
    if (
      mount.mode !== "ReadOnly" ||
      mount.ioType !== "FileBatch" ||
      mount.inlineContentBase64 ||
      mount.batchEntries.length > 0
    ) {
      continue;
    }
    const targetPath = resolve(collectionDir, mount.relativePath);
    if (!pathInside(collectionDir, targetPath)) {
      throw new Error("Sandbox empty FileBatch escaped the managed run directory");
    }
    await assertNoSymlink(collectionDir, targetPath);
    await mkdir(targetPath, { recursive: true, mode: 0o700 });
    await assertNoSymlink(collectionDir, targetPath);
  }
}

function assertDeliveryLease(source: SandboxInputSource): void {
  const hasLease =
    source.deliveryLeaseId !== undefined || source.deliveryLeaseExpiresAtUnixMs !== undefined;
  if (!hasLease) return;
  if (
    !source.deliveryLeaseId ||
    !/^[a-f0-9-]{36}$/i.test(source.deliveryLeaseId) ||
    source.deliveryLeaseExpiresAtUnixMs === undefined ||
    source.deliveryLeaseExpiresAtUnixMs <= BigInt(Date.now())
  ) {
    throw new Error("Sandbox data delivery lease is invalid or expired");
  }
}

export class SandboxStager {
  constructor(private readonly options: SandboxStagerOptions) {}

  async prepare(
    verified: VerifiedSandboxManifest,
    inputSources: SandboxInputSource[] = [],
  ): Promise<{ workingDir: string; sandbox: SandboxJobSpec }> {
    const identity = verified.unsigned.identity;
    const selfAccount =
      verified.unsigned.executionMode === "SelfAccount"
        ? assertSelfAccountIdentity(identity, this.options.processIdentity)
        : undefined;
    const selfAccountRuntime = selfAccount ? selfAccountRuntimeFacts(verified) : undefined;
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.options.root);
    const collectionDir = resolve(root, verified.unsigned.jobId);
    if (!pathInside(root, collectionDir)) {
      throw new Error("Sandbox collection directory escaped the managed root");
    }
    await assertNoSymlink(root, collectionDir);
    await mkdir(collectionDir, { recursive: true, mode: 0o700 });
    await assertNoSymlink(root, collectionDir);
    if (selfAccount) {
      await assignSandboxOwner(collectionDir, {
        uid: selfAccount.uid,
        gid: selfAccount.gid,
        mayChown: false,
      });
    }
    await materializeExternalInputs(
      verified,
      collectionDir,
      inputSources,
      this.options.downloadInput,
    );
    if (identity.backend === "Kubernetes") {
      const mounts = verified.unsigned.mounts.map((mount) =>
        jobMount(mount, resolve(collectionDir, mount.relativePath)),
      );
      for (const mount of mounts.filter(
        (item) => item.mode === "ReadOnly" && !item.inlineContentBase64,
      )) {
        await assertNoSymlink(collectionDir, mount.hostPath);
        await verifyReadOnlyMount(mount, mount.hostPath);
      }
      return {
        workingDir: "/kq",
        sandbox: {
          language: verified.unsigned.script.language,
          entrypoint: verified.unsigned.script.entrypoint,
          scriptContent: Buffer.from(verified.scriptContent).toString("utf8"),
          scriptHostPath: "",
          contextHostPath: "",
          runtimeKind: verified.unsigned.runtime.kind,
          runtimePath: verified.runtimePath,
          executionMode: verified.unsigned.executionMode,
          ...(verified.unsigned.runtimeAttestationId
            ? { runtimeAttestationId: verified.unsigned.runtimeAttestationId }
            : {}),
          executionProfile: verified.unsigned.executionProfile,
          identity: jobIdentity(identity),
          mounts,
          limits: verified.unsigned.limits,
          kubernetesArtifactPvc: this.options.kubernetesArtifactPvc,
        },
      };
    }

    const owner: SandboxFileOwner = selfAccount
      ? { uid: selfAccount.uid, gid: selfAccount.gid, mayChown: false }
      : { uid: this.options.ownerUid ?? 0, gid: identity.gid, mayChown: true };
    const runDir = collectionDir;
    await chmod(runDir, 0o710);
    await assignSandboxOwner(runDir, owner);
    const scriptDir = join(runDir, "script");
    await mkdir(scriptDir, { mode: 0o710 });
    await assignSandboxOwner(scriptDir, owner);
    const scriptHostPath = join(scriptDir, verified.unsigned.script.entrypoint);
    const contextHostPath = join(runDir, "context.json");
    await writeManagedFile(scriptHostPath, verified.scriptContent, owner);
    await writeManagedFile(contextHostPath, createContext(verified.unsigned), owner);

    const mounts: SandboxJobMount[] = [];
    for (const mount of verified.unsigned.mounts) {
      const hostPath = resolve(runDir, mount.relativePath);
      if (!pathInside(runDir, hostPath)) throw new Error("Sandbox artifact path escaped run root");
      await assertNoSymlink(runDir, hostPath);
      if (mount.mode === "ReadOnly") {
        if (mount.inlineContentBase64) {
          await mkdir(dirname(hostPath), { recursive: true, mode: 0o710 });
          await assignSandboxOwner(dirname(hostPath), owner);
          await writeManagedFile(hostPath, Buffer.from(mount.inlineContentBase64, "base64"), owner);
        }
        await verifyReadOnlyMount(jobMount(mount, hostPath), hostPath);
        await protectReadOnlyPath(hostPath, owner);
      } else {
        await mkdir(dirname(hostPath), { recursive: true, mode: 0o750 });
        await assignSandboxOwner(
          dirname(hostPath),
          selfAccount ? owner : { uid: identity.uid, gid: identity.gid, mayChown: true },
        );
        if (mount.ioType === "FileBatch") {
          await mkdir(hostPath, { mode: 0o750 });
        } else if (mount.required) {
          await writeFile(hostPath, "", { flag: "wx", mode: 0o640 });
        }
        if (mount.ioType === "FileBatch" || mount.required) {
          await assignSandboxOwner(
            hostPath,
            selfAccount ? owner : { uid: identity.uid, gid: identity.gid, mayChown: true },
          );
        }
      }
      mounts.push(jobMount(mount, hostPath));
    }
    return {
      workingDir: runDir,
      sandbox: {
        language: verified.unsigned.script.language,
        entrypoint: verified.unsigned.script.entrypoint,
        scriptContent: Buffer.from(verified.scriptContent).toString("utf8"),
        scriptHostPath,
        contextHostPath,
        runtimeKind: verified.unsigned.runtime.kind,
        runtimePath: verified.runtimePath,
        executionMode: verified.unsigned.executionMode,
        ...(verified.unsigned.runtimeAttestationId
          ? { runtimeAttestationId: verified.unsigned.runtimeAttestationId }
          : {}),
        ...(selfAccount && selfAccountRuntime
          ? {
              selfAccount,
              ...selfAccountRuntime,
            }
          : {}),
        ...(verified.unsigned.executionProfile
          ? {
              apptainerPath: verified.unsigned.executionProfile.apptainerCanonicalPath,
              executionProfile: verified.unsigned.executionProfile,
            }
          : {}),
        identity: jobIdentity(identity),
        mounts,
        limits: verified.unsigned.limits,
      },
    };
  }
}

export async function removeSandboxRun(rootPath: string, jobId: string): Promise<void> {
  if (!jobId || posix.basename(jobId) !== jobId || jobId === "." || jobId === "..") {
    throw new Error("Sandbox job id is invalid for managed work-root cleanup");
  }
  const root = await realpath(rootPath);
  const target = resolve(root, jobId);
  if (!pathInside(root, target) || target === root) {
    throw new Error("Sandbox work-root cleanup escapes the managed root");
  }
  const current = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!current) return;
  if (current.isSymbolicLink()) {
    throw new Error("Sandbox work-root cleanup refuses a symbolic link");
  }
  const canonicalParent = await realpath(dirname(target));
  if (!pathInside(root, canonicalParent)) {
    throw new Error("Sandbox work-root cleanup parent escapes the managed root");
  }
  await rm(target, { recursive: true, force: true, maxRetries: 2 });
}

export async function validateSandboxOutputs(
  sandbox: SandboxJobSpec,
): Promise<SandboxOutputFact[]> {
  const facts: SandboxOutputFact[] = [];
  let totalBytes = 0;
  for (const mount of sandbox.mounts.filter((item) => item.mode === "WriteOnly")) {
    try {
      await assertNoSymlink(dirname(mount.hostPath), mount.hostPath);
      const fact = await hashMount(mount.hostPath, mount.ioType);
      if (fact.sizeBytes > mount.sizeLimitBytes) {
        throw new Error(`Sandbox output exceeds size limit for ${mount.descriptor}`);
      }
      totalBytes += fact.sizeBytes;
      facts.push({ descriptor: mount.descriptor, storageRef: mount.hostPath, ...fact });
    } catch (error) {
      if (!mount.required && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  if (totalBytes > sandbox.limits.outputBytes)
    throw new Error("Sandbox total output limit exceeded");
  return facts;
}

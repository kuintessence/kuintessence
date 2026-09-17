import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export interface DatasetFileManifest {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface DatasetManifest {
  datasetPath: string;
  files: DatasetFileManifest[];
  merkleRoot: string;
}

export interface DatasetAttestation {
  algorithm: "sha256";
  manifestDigest: string;
  attestedAt: string;
}

export interface DatasetAttester {
  attest(manifest: DatasetManifest): Promise<DatasetAttestation>;
}

export type DataDeliveryMethod = "object-download" | "stage-copy" | "readonly-mount";

export interface DataDeliveryPlan {
  method: DataDeliveryMethod;
  datasetPath: string;
  targetPath: string;
  restricted: boolean;
}

export interface DataDeliveryCapabilities {
  objectDownload: boolean;
  stageCopy: boolean;
  readonlyMount: { enabled: boolean; trusted: boolean };
}

export interface AgentDataRootsOptions {
  datasetRoot: string;
  managedRoots: Record<string, string>;
  jobWorkRoot: string;
  restrictedRoots?: string[];
}

export class AgentDataRoots {
  private datasetRoot: string | undefined;
  private jobWorkRoot: string | undefined;
  private readonly managedRoots = new Map<string, string>();

  constructor(private readonly options: AgentDataRootsOptions) {}

  async initialize(): Promise<void> {
    const [datasetRoot, jobWorkRoot] = await Promise.all([
      ensurePrivateDirectory(this.options.datasetRoot),
      ensurePrivateDirectory(this.options.jobWorkRoot),
    ]);
    const restrictedRoots = await Promise.all(
      (this.options.restrictedRoots ?? []).map(async (path) => canonicalExistingPath(path)),
    );
    const allRoots = [datasetRoot, jobWorkRoot, ...restrictedRoots];
    for (let index = 0; index < allRoots.length; index += 1) {
      const root = allRoots[index];
      if (!root) continue;
      for (const other of allRoots.slice(index + 1)) {
        if (other && (inside(root, other) || inside(other, root))) {
          throw new Error("Agent dataset, job, and restricted roots must not overlap");
        }
      }
    }
    this.datasetRoot = datasetRoot;
    this.jobWorkRoot = jobWorkRoot;
    for (const [managedRootId, configuredPath] of Object.entries(this.options.managedRoots)) {
      assertCanonicalManagedRootPath(configuredPath);
      const managedRoot = await resolveManagedDescendant(
        datasetRoot,
        configuredPath,
        "Managed dataset root",
      );
      const stat = await lstat(managedRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Managed dataset root must be a directory without symbolic links");
      }
      const canonical = await realpath(managedRoot);
      if (!inside(datasetRoot, canonical)) {
        throw new Error("Managed dataset root resolves outside the Agent dataset root");
      }
      this.managedRoots.set(managedRootId, canonical);
    }
  }

  async prepareJobRoot(jobId: string): Promise<string> {
    const root = this.requireJobWorkRoot();
    const path = this.resolveJobRoot(jobId);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const initial = await lstat(path);
    if (initial.isSymbolicLink()) {
      throw new Error("Agent job work root cannot be a symbolic link");
    }
    const canonical = await realpath(path);
    if (!inside(root, canonical)) {
      throw new Error("Agent job work root resolves outside its managed parent");
    }
    await assertPrivateDirectory(canonical);
    return canonical;
  }

  schedulerLogDir(): string {
    return resolve(this.requireJobWorkRoot(), ".scheduler-logs");
  }

  async prepareSchedulerLogDir(): Promise<string> {
    const root = this.requireJobWorkRoot();
    const canonical = await ensurePrivateDirectory(this.schedulerLogDir());
    if (!inside(root, canonical)) {
      throw new Error("Agent scheduler log directory resolves outside its managed parent");
    }
    return canonical;
  }

  async removeJobRoot(jobId: string): Promise<void> {
    await rm(this.resolveJobRoot(jobId), { recursive: true, force: true });
  }

  async scanManagedDataset(managedRootId: string, datasetPath: string): Promise<DatasetManifest> {
    this.requireDatasetRoot();
    const root = this.managedRoots.get(managedRootId);
    if (!root) throw new Error("Requested managedRootId is not configured on this Agent");
    const dataset = await resolveManagedDescendant(root, datasetPath, "Dataset path");
    const datasetStat = await lstat(dataset);
    if (!datasetStat.isDirectory() || datasetStat.isSymbolicLink()) {
      throw new Error("Dataset path must be a managed directory without symbolic links");
    }
    const canonical = await realpath(dataset);
    if (!inside(root, canonical)) {
      throw new Error("Dataset path resolves outside the managed dataset root");
    }
    const files = await scanFiles(canonical, canonical);
    return {
      datasetPath,
      files,
      merkleRoot: merkleRoot(files),
    };
  }

  async resolveManagedDataPath(managedRootId: string, relativePath: string): Promise<string> {
    this.requireDatasetRoot();
    const root = this.managedRoots.get(managedRootId);
    if (!root) throw new Error("Requested managedRootId is not configured on this Agent");
    const candidate = resolveManagedDescendant(root, relativePath, "Data delivery path");
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error("Data delivery path cannot be a symbolic link");
    }
    const canonical = await realpath(candidate);
    if (!inside(root, canonical)) {
      throw new Error("Data delivery path resolves outside its managed dataset root");
    }
    return canonical;
  }

  private requireDatasetRoot(): string {
    if (!this.datasetRoot) throw new Error("Agent data roots are not initialized");
    return this.datasetRoot;
  }

  private requireJobWorkRoot(): string {
    if (!this.jobWorkRoot) throw new Error("Agent data roots are not initialized");
    return this.jobWorkRoot;
  }

  private resolveJobRoot(jobId: string): string {
    const root = this.requireJobWorkRoot();
    if (!jobId || basename(jobId) !== jobId || jobId === "." || jobId === "..") {
      throw new Error("Agent job id is invalid for a managed work root");
    }
    const path = resolve(root, jobId);
    if (!inside(root, path)) {
      throw new Error("Agent job work root escapes its managed parent");
    }
    return path;
  }
}

export function validateDataDeliveryPlan(
  plan: DataDeliveryPlan,
  capabilities: DataDeliveryCapabilities,
): void {
  assertRelativePath(plan.datasetPath, "Data delivery dataset path");
  assertRelativePath(plan.targetPath, "Data delivery target path");
  switch (plan.method) {
    case "object-download":
      if (!capabilities.objectDownload) {
        throw new Error("Object-download is unsupported by this Agent");
      }
      return;
    case "stage-copy":
      if (!capabilities.stageCopy) {
        throw new Error("Stage-copy is unsupported by this Agent");
      }
      return;
    case "readonly-mount":
      if (!capabilities.readonlyMount.enabled) {
        throw new Error("Readonly-mount is unsupported by this Agent");
      }
      if (plan.restricted && !capabilities.readonlyMount.trusted) {
        throw new Error("Restricted data requires a trusted readonly mount");
      }
      return;
  }
}

export function createLocalDatasetAttestation(manifest: DatasetManifest): DatasetAttestation {
  return {
    algorithm: "sha256",
    manifestDigest: sha256Text(JSON.stringify(manifest)),
    attestedAt: new Date().toISOString(),
  };
}

export function merkleRoot(files: readonly DatasetFileManifest[]): string {
  let nodes = files
    .map((file) => sha256Text(`${file.path}\0${file.sizeBytes}\0${file.sha256}`))
    .sort();
  if (nodes.length === 0) return sha256Text("");
  while (nodes.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < nodes.length; index += 2) {
      const left = nodes[index];
      const right = nodes[index + 1] ?? left;
      if (!left) throw new Error("Merkle node is missing");
      next.push(sha256Text(`${left}${right}`));
    }
    nodes = next;
  }
  return nodes[0] ?? sha256Text("");
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Agent root must be absolute");
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink()) {
    throw new Error("Agent-managed root cannot be a symbolic link");
  }
  const canonical = await realpath(path);
  await assertPrivateDirectory(canonical);
  return canonical;
}

async function canonicalExistingPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Agent restricted root must be absolute");
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink()) {
    throw new Error("Agent restricted root cannot be a symbolic link");
  }
  const canonical = await realpath(path);
  await assertPrivateDirectory(canonical);
  return canonical;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Agent-managed root must be a directory without symbolic links");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("Agent-managed root must be private");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error("Agent-managed root must be owned by the Agent");
  }
}

function resolveManagedDescendant(root: string, path: string, label: string): string {
  assertRelativePath(path, label);
  const candidate = resolve(root, path);
  if (!inside(root, candidate)) throw new Error(`${label} escapes managed root`);
  return candidate;
}

async function scanFiles(root: string, directory: string): Promise<DatasetFileManifest[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: DatasetFileManifest[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error("Dataset contains a symbolic link");
    }
    if (stat.isDirectory()) {
      files.push(...(await scanFiles(root, path)));
      continue;
    }
    if (!stat.isFile()) {
      throw new Error("Dataset contains a non-regular file");
    }
    files.push({
      path: relative(root, path).split(sep).join("/"),
      sizeBytes: stat.size,
      sha256: await sha256File(path),
    });
  }
  return files;
}

function assertRelativePath(path: string, label: string): void {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} must be relative without parent traversal`);
  }
}

function assertCanonicalManagedRootPath(path: string): void {
  if (
    path !== "." &&
    (!path ||
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
  ) {
    throw new Error("Managed dataset root path must be canonical and relative");
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

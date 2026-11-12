import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourcePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Invalid source path",
  );
const toolSchema = z.object({ path: z.string().startsWith("/"), sha256: digest }).strict();
export const formalBuildEnvironmentSchema = z
  .object({
    policy: z.literal("allowlist-private-home"),
    platform: z.string().min(1),
    architecture: z.string().min(1),
    bun: toolSchema,
    node: toolSchema.extend({ version: z.string().regex(/^v(?:[2-9]\d|\d{3,})\.\d+\.\d+$/) }),
    osReleaseSha256: digest,
    caFiles: z
      .array(
        toolSchema.extend({ variable: z.enum(["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) }).strict(),
      )
      .max(2),
    systemDependencies: z.literal("recorded-tools-host-os-and-system-trust"),
  })
  .strict();
const fileSchema = z
  .object({
    path: sourcePath,
    executable: z.boolean(),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 ** 2),
    sha256: digest,
  })
  .strict();
export const sourceArchiveSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("kq-source-archive"),
    files: z
      .array(fileSchema.extend({ content: z.string().max(90 * 1024 ** 2) }).strict())
      .min(1)
      .max(100_000),
  })
  .strict();
export const sourceProvenanceSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("kq-source-provenance"),
    mode: z.literal("release"),
    policy: z.enum(["clean", "sealed"]),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    sourceDirty: z.boolean(),
    gitFingerprint: digest,
    sourceFingerprint: digest,
    archive: z
      .object({
        name: z.string().regex(/^source-[a-f0-9]{64}\.json$/),
        sha256: digest,
        size: z.number().int().positive(),
      })
      .strict(),
    files: z.array(fileSchema).min(1).max(100_000),
    bunVersion: z.string().min(1),
    packageManager: z.string().regex(/^bun@\d+\.\d+\.\d+$/),
    lockSha256: digest,
    buildTarget: z.enum(["bun-linux-x64", "bun-linux-x64-baseline", "bun-linux-arm64"]),
    commands: z.array(z.array(z.string()).min(1)).min(4),
    buildEnvironment: formalBuildEnvironmentSchema,
    codegenVersions: z.object({ buf: z.string().min(1), protocGenEs: z.string().min(1) }).strict(),
    dependencyPolicy: z.literal("frozen-lockfile-ignore-scripts"),
    reproducibility: z.literal("source-rebuildable-not-bit-for-bit"),
  })
  .strict();
export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>;
export type SourceArchive = z.infer<typeof sourceArchiveSchema>;
export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export function excludedSourcePath(path: string): boolean {
  const parts = path.split("/");
  return (
    path.startsWith("packages/proto/src/generated/") ||
    parts.some(
      (part) =>
        /^(?:\.git|node_modules|dist|target|__pycache__|\.cache|coverage|test-results|playwright-report|blob-report|\.worktrees|\.claude|\.gstack)$/.test(
          part,
        ) ||
        ((part.startsWith(".env") || /\.env(?:\.[^/]+)?$/.test(part)) &&
          !part.endsWith(".example")) ||
        /^(?:\.ssh|\.aws|\.kube|\.docker|\.npm|\.bun|\.gnupg|\.netrc|_netrc|\.pypirc|\.git-credentials)$/.test(
          part,
        ),
    ) ||
    /(?:^|\/)(?:(?:\.?credentials|service[-_]account|secrets?|tokens?)\.json|agent\.env|[^/]*-ca)(?:\/|$)/.test(
      path,
    ) ||
    /\.(?:pem|key|p12|pfx|db|db-journal|db-shm|db-wal|pyc|sif|sqlite|sqlite3)$/.test(path) ||
    /^(?:ignored|temp|ref|release|plan|experiments)\//.test(path)
  );
}

export function assertSourceHasNoCredentials(path: string, bytes: Uint8Array): void {
  const text = Buffer.from(bytes).toString("utf8");
  if (
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{16}/.test(
      text,
    )
  )
    throw new Error(`Private key found in source: ${path}`);
  const basename = path.split("/").at(-1);
  if (
    (basename === ".npmrc" &&
      /^\s*(?:[^#;\r\n]*:)?(?:_authToken|_auth|_password|password|username)\s*=/im.test(text)) ||
    ((basename === "bunfig.toml" || basename === ".bunfig.toml") &&
      /(?:^|[,{\s])(?:token|password|username)\s*=/im.test(text)) ||
    ((basename === ".npmrc" || basename === "bunfig.toml" || basename === ".bunfig.toml") &&
      /https?:\/\/[^/\s"'@]+:[^/\s"'@]+@/i.test(text))
  )
    throw new Error(`Package manager authentication is not source material: ${path}`);
}

export async function gitCommand(root: string, argv: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...argv], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Source Git command failed: ${argv[0]}: ${stderr}`);
  return stdout;
}

export async function captureSource(root: string) {
  const revision = (await gitCommand(root, ["rev-parse", "HEAD"])).trim();
  const status = await gitCommand(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
  ]);
  const diff = await gitCommand(root, ["diff", "--binary", "HEAD", "--"]);
  const names = (
    await gitCommand(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  )
    .split("\0")
    .filter(Boolean);
  const archive: SourceArchive = { version: 1, kind: "kq-source-archive", files: [] };
  let total = 0;
  for (const path of [...new Set(names)].sort()) {
    sourcePath.parse(path);
    if (excludedSourcePath(path)) continue;
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(join(root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Source must be a regular file: ${path}`);
    total += stat.size;
    if (total > 256 * 1024 ** 2 || stat.size > 64 * 1024 ** 2)
      throw new Error("Source snapshot exceeds byte limits");
    const bytes = await readFile(join(root, path));
    assertSourceHasNoCredentials(path, bytes);
    archive.files.push({
      path,
      executable: Boolean(stat.mode & 0o111),
      size: bytes.length,
      sha256: sha256(bytes),
      content: bytes.toString("base64"),
    });
  }
  const files = archive.files.map(({ content: _content, ...file }) => file);
  const gitFingerprint = sha256(JSON.stringify({ revision, status, diff }));
  const sourceFingerprint = sha256(JSON.stringify({ revision, gitFingerprint, files }));
  return {
    archive,
    files,
    sourceRevision: revision,
    sourceDirty: status.length > 0,
    gitFingerprint,
    sourceFingerprint,
  };
}

export async function materializeSource(archive: SourceArchive, destination: string) {
  sourceArchiveSchema.parse(archive);
  const names = new Set<string>();
  if (
    archive.files.reduce((total, file) => total + file.size, 0) > 256 * 1024 ** 2 ||
    archive.files.some((file) => file.size > 64 * 1024 ** 2)
  )
    throw new Error("Source archive exceeds byte limits");
  await mkdir(destination, { mode: 0o700 });
  for (const file of archive.files) {
    if (names.has(file.path) || excludedSourcePath(file.path))
      throw new Error("Duplicate or excluded source archive entry");
    names.add(file.path);
    const bytes = Buffer.from(file.content, "base64");
    if (
      bytes.length !== file.size ||
      sha256(bytes) !== file.sha256 ||
      bytes.toString("base64") !== file.content
    )
      throw new Error("Source archive bytes mismatch");
    assertSourceHasNoCredentials(file.path, bytes);
    const path = join(destination, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
    await chmod(path, file.executable ? 0o700 : 0o600);
  }
}

export function validateProvenance(provenance: SourceProvenance, archive: SourceArchive) {
  sourceProvenanceSchema.parse(provenance);
  sourceArchiveSchema.parse(archive);
  if (archive.files.reduce((total, file) => total + file.size, 0) > 256 * 1024 ** 2)
    throw new Error("Source archive exceeds byte limits");
  const files = archive.files.map(({ content: _content, ...file }) => file);
  if (
    JSON.stringify(files) !== JSON.stringify(provenance.files) ||
    new Set(files.map((file) => file.path)).size !== files.length
  )
    throw new Error("Provenance source inventory mismatch");
  if (
    sha256(
      JSON.stringify({
        revision: provenance.sourceRevision,
        gitFingerprint: provenance.gitFingerprint,
        files,
      }),
    ) !== provenance.sourceFingerprint
  )
    throw new Error("Source fingerprint mismatch");
  if (provenance.archive.name !== `source-${provenance.archive.sha256}.json`)
    throw new Error("Source archive name is not content addressed");
  for (const required of [
    "package.json",
    "bun.lock",
    "packages/agent/src/index.ts",
    "packages/cli/src/index.ts",
    "packages/proto/package.json",
    "packages/proto/buf.gen.yaml",
  ]) {
    if (!files.some((file) => file.path === required))
      throw new Error(`Incomplete source inventory: ${required}`);
  }
  if (
    !files.some(
      (file) => file.path.startsWith("packages/proto/proto/") && file.path.endsWith(".proto"),
    )
  )
    throw new Error("Missing protobuf source inputs");
  const lock = archive.files.find((file) => file.path === "bun.lock");
  const pkg = archive.files.find((file) => file.path === "package.json");
  if (!lock || !pkg || lock.sha256 !== provenance.lockSha256)
    throw new Error("Missing pinned dependency source");
  const rootPackage = JSON.parse(Buffer.from(pkg.content, "base64").toString("utf8"));
  if (
    rootPackage.packageManager !== provenance.packageManager ||
    provenance.packageManager !== `bun@${provenance.bunVersion}`
  )
    throw new Error("Pinned Bun version mismatch");
  const expectedCommands = [
    ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
    ["bun", "run", "--filter", "@kuintessence/proto", "generate"],
    releaseBuildCommand("agent", provenance.buildTarget, "artifacts/kq-agent"),
    releaseBuildCommand("cli", provenance.buildTarget, "artifacts/kq"),
  ];
  if (JSON.stringify(expectedCommands) !== JSON.stringify(provenance.commands))
    throw new Error("Unsupported formal build commands");
  if (provenance.policy === "clean" && provenance.sourceDirty)
    throw new Error("Clean release contains dirty source");
  for (const file of archive.files) {
    const bytes = Buffer.from(file.content, "base64");
    assertSourceHasNoCredentials(file.path, bytes);
    if (
      excludedSourcePath(file.path) ||
      sha256(bytes) !== file.sha256 ||
      bytes.length !== file.size ||
      bytes.toString("base64") !== file.content
    )
      throw new Error("Invalid source archive entry");
  }
}

export const releaseBuildCommand = (role: "agent" | "cli", target: string, destination: string) => [
  "bun",
  "build",
  "--compile",
  `--target=${target}`,
  ...(role === "agent"
    ? ["--external=cpu-features", "--external=./crypto/build/Release/sshcrypto.node"]
    : []),
  `packages/${role}/src/index.ts`,
  `--outfile=${destination}`,
];

export async function assertMaterializedSource(archive: SourceArchive, root: string) {
  const actual: string[] = [];
  async function walk(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === "node_modules" || path === "packages/proto/src/generated") continue;
      if (entry.isSymbolicLink()) throw new Error("Build introduced a source link");
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else actual.push(path);
    }
  }
  await walk(root);
  if (
    JSON.stringify(actual.sort()) !== JSON.stringify(archive.files.map((file) => file.path).sort())
  )
    throw new Error("Build introduced unsealed source inputs");
  for (const file of archive.files) {
    const path = join(root, file.path);
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      Boolean(stat.mode & 0o111) !== file.executable ||
      sha256(await readFile(path)) !== file.sha256
    )
      throw new Error("Build modified sealed source inputs");
  }
}

if (import.meta.main) {
  const [archivePath, destination, ...extra] = process.argv.slice(2);
  if (!archivePath || !destination || extra.length)
    throw new Error("Expected source archive and a new restore directory");
  const stat = await lstat(archivePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 360 * 1024 ** 2)
    throw new Error("Invalid source archive file");
  const archive = sourceArchiveSchema.parse(JSON.parse(await readFile(archivePath, "utf8")));
  await materializeSource(archive, destination);
}

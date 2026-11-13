/** Usage: bun deploy/site-release/prepare.ts request.json NEW_OUTPUT_DIRECTORY */
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { createFormalBuildEnvironment } from "./build-environment";
import { validateComputeInventory, validateSpackProfile } from "./compatibility";
import { siteReleaseManifestSchema as siteReleaseSchema } from "./manifest";
import {
  assertMaterializedSource,
  releaseBuildCommand as buildCommand,
  captureSource,
  materializeSource,
  sha256,
  sourceProvenanceSchema,
} from "./source-provenance";

const artifactSchema = siteReleaseSchema.shape.files.element;
const { version: _version, files: _files, ...metadataShape } = siteReleaseSchema.shape;
export const sitePrepareSchema = z
  .object({
    ...metadataShape,
    channel: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    mode: z.enum(["review", "release"]).default("review"),
    sourcePolicy: z.enum(["clean", "sealed"]).default("clean"),
    buildTarget: z.enum(["bun-linux-x64", "bun-linux-x64-baseline", "bun-linux-arm64"]),
    computeInventory: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !isAbsolute(value), "computeInventory must be relative to request.json")
      .optional(),
    requireSpack: z.boolean().default(false),
    inputs: z
      .array(
        artifactSchema
          .extend({
            role: z.enum(["runtime-sif", "site-profile", "spack", "tool"]),
            path: z.string().min(1),
          })
          .strict(),
      )
      .max(126),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      request.mode === "release" &&
      (request.inputs.length > 124 ||
        request.inputs.some(
          (input) =>
            input.name === "source-provenance.json" ||
            /^source-[a-f0-9]{64}\.json$/.test(input.name),
        ))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Formal source artifacts require two reserved artifact slots",
      });
    }
    if (
      request.requireSpack &&
      ["runtime-sif", "site-profile", "spack"].some(
        (role) => request.inputs.filter((input) => input.role === role).length !== 1,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "requireSpack needs exactly one runtime-sif, site-profile and spack artifact",
      });
    if ((request.architecture === "aarch64") !== (request.buildTarget === "bun-linux-arm64"))
      ctx.addIssue({ code: "custom", message: "Architecture and Bun target differ" });
  });
type Request = z.infer<typeof sitePrepareSchema>;
type Compile = (
  role: "agent" | "cli",
  target: Request["buildTarget"],
  destination: string,
  sourceRoot?: string,
  env?: Record<string, string>,
) => Promise<void>;
const repository = resolve(import.meta.dir, "../..");

async function command(
  argv: string[],
  cwd = repository,
  env?: Record<string, string>,
): Promise<string> {
  const child = Bun.spawn(argv, { cwd, ...(env ? { env } : {}), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`Release preparation command failed: ${argv[0]} ${argv[1]}\n${stderr}`);
  return stdout.trim();
}

const compile: Compile = async (role, target, destination, sourceRoot = repository, env) => {
  await command(
    [process.execPath, ...buildCommand(role, target, destination).slice(1)],
    sourceRoot,
    env,
  );
};

async function digestFile(path: string) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > 512 * 1024 ** 3)
    throw new Error("Release input must be a nonempty regular file");
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return { size: entry.size, sha256: hash.digest("hex") };
}

async function verifyElf(path: string, architecture: Request["architecture"]) {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(20);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (
      bytesRead !== 20 ||
      bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== (architecture === "x86_64" ? 62 : 183)
    )
      throw new Error("Compiled executable has the wrong Linux architecture");
  } finally {
    await file.close();
  }
}

/** Builds unsigned artifacts only; compatibility requirements remain explicit operator assertions. */
export async function prepareSiteRelease(
  requestPath: string,
  output: string,
  build: Compile = compile,
) {
  const request = sitePrepareSchema.parse(JSON.parse(await readFile(requestPath, "utf8")));
  // Validate roles and reserved/duplicate names before spending time compiling.
  const {
    channel,
    mode,
    sourcePolicy,
    buildTarget,
    inputs: _inputs,
    computeInventory,
    requireSpack,
    ...compatibility
  } = request;
  let computeInventorySha256: string | undefined;
  if (computeInventory) {
    const path = resolve(dirname(requestPath), computeInventory);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error("Compute inventory must be a regular JSON file up to 1 MiB");
    const bytes = await readFile(path);
    if (bytes.length > 1024 * 1024) throw new Error("Compute inventory is oversized");
    validateComputeInventory(JSON.parse(bytes.toString("utf8")), request);
    computeInventorySha256 = createHash("sha256").update(bytes).digest("hex");
  }
  if (requireSpack) {
    const profile = request.inputs.find((input) => input.role === "site-profile");
    const runtime = request.inputs.find((input) => input.role === "runtime-sif");
    if (!profile || !runtime) throw new Error("Incomplete Spack release");
    const path = resolve(dirname(requestPath), profile.path);
    const entry = await lstat(path);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      profile.size > 128 * 1024 ||
      entry.size > 128 * 1024
    )
      throw new Error("Site profile must be a regular JSON file up to 128 KiB");
    const bytes = await readFile(path);
    if (
      bytes.length !== profile.size ||
      bytes.length > 128 * 1024 ||
      createHash("sha256").update(bytes).digest("hex") !== profile.sha256
    )
      throw new Error("Verified site profile input mismatch or oversized profile");
    validateSpackProfile(JSON.parse(bytes.toString("utf8")), request.architecture, runtime.sha256);
  }
  siteReleaseSchema.parse({
    ...compatibility,
    version: 1,
    files: [
      { name: "kq-agent", role: "agent", executable: true, size: 1, sha256: "0".repeat(64) },
      { name: "kq", role: "cli", executable: true, size: 1, sha256: "0".repeat(64) },
      ...request.inputs.map(({ path: _path, ...file }) => file),
    ],
  });
  if (
    mode === "release" &&
    (resolve(output) === repository || resolve(output).startsWith(`${repository}${sep}`))
  )
    throw new Error("Formal release output must be outside the source tree");
  const sourceBefore = await captureSource(repository);
  const sourceRevision = await command(["git", "rev-parse", "HEAD"]);
  if (sourceRevision !== request.serverRevision)
    throw new Error("serverRevision must match the checked-out source revision");
  const sourceDirty = Boolean(
    await command(["git", "status", "--porcelain", "--untracked-files=normal"]),
  );
  if (mode === "release" && sourcePolicy === "clean" && sourceBefore.sourceDirty)
    throw new Error(
      "Formal clean release requires a clean source tree; use sealed policy for an explicitly reviewed dirty snapshot",
    );
  await mkdir(dirname(resolve(output)), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  try {
    const artifacts = join(output, "artifacts");
    await mkdir(artifacts, { mode: 0o700 });
    const files: z.infer<typeof artifactSchema>[] = [];
    let sourceRoot = repository;
    let buildEnvironment: Awaited<ReturnType<typeof createFormalBuildEnvironment>> | undefined;
    let provenance: z.infer<typeof sourceProvenanceSchema> | undefined;
    if (mode === "release") {
      if (build !== compile)
        throw new Error("Formal releases require the isolated pinned build pipeline");
      const archiveBytes = `${JSON.stringify(sourceBefore.archive)}\n`;
      if (Buffer.byteLength(archiveBytes) > 360 * 1024 ** 2)
        throw new Error("Source archive exceeds publisher byte limit");
      const archiveDigest = sha256(archiveBytes);
      const archiveName = `source-${archiveDigest}.json`;
      const packageFile = sourceBefore.archive.files.find((file) => file.path === "package.json");
      const lockFile = sourceBefore.files.find((file) => file.path === "bun.lock");
      if (!packageFile || !lockFile)
        throw new Error("Formal source requires package.json and bun.lock");
      const packageManager: unknown = JSON.parse(
        Buffer.from(packageFile.content, "base64").toString("utf8"),
      ).packageManager;
      if (packageManager !== `bun@${Bun.version}`)
        throw new Error("Formal build requires the exact packageManager Bun version");
      sourceRoot = join(output, "source");
      await materializeSource(sourceBefore.archive, sourceRoot);
      buildEnvironment = await createFormalBuildEnvironment(
        join(resolve(output), "build-environment"),
      );
      const nodeVersion = await command(
        [buildEnvironment.node.path, "--version"],
        sourceRoot,
        buildEnvironment.env,
      );
      if (!/^v(?:[2-9]\d|\d{3,})\.\d+\.\d+$/.test(nodeVersion))
        throw new Error("Formal protobuf generation requires Node.js >=20");
      const install = ["bun", "install", "--frozen-lockfile", "--ignore-scripts"];
      const generate = ["bun", "run", "--filter", "@kuintessence/proto", "generate"];
      await command([process.execPath, ...install.slice(1)], sourceRoot, buildEnvironment.env);
      await command([process.execPath, ...generate.slice(1)], sourceRoot, buildEnvironment.env);
      const codegenVersions = {
        buf: await command(
          [join(resolve(sourceRoot), "node_modules/.bin/buf"), "--version"],
          sourceRoot,
          buildEnvironment.env,
        ),
        protocGenEs: await command(
          [join(resolve(sourceRoot), "node_modules/.bin/protoc-gen-es"), "--version"],
          sourceRoot,
          buildEnvironment.env,
        ),
      };
      provenance = sourceProvenanceSchema.parse({
        version: 1,
        kind: "kq-source-provenance",
        mode,
        policy: sourcePolicy,
        sourceRevision,
        sourceDirty: sourceBefore.sourceDirty,
        gitFingerprint: sourceBefore.gitFingerprint,
        sourceFingerprint: sourceBefore.sourceFingerprint,
        archive: {
          name: archiveName,
          size: Buffer.byteLength(archiveBytes),
          sha256: archiveDigest,
        },
        files: sourceBefore.files,
        bunVersion: Bun.version,
        packageManager,
        lockSha256: lockFile.sha256,
        buildTarget,
        commands: [
          install,
          generate,
          buildCommand("agent", buildTarget, "artifacts/kq-agent"),
          buildCommand("cli", buildTarget, "artifacts/kq"),
        ],
        buildEnvironment: {
          ...buildEnvironment.provenance,
          node: { ...buildEnvironment.node, version: nodeVersion },
        },
        codegenVersions,
        dependencyPolicy: "frozen-lockfile-ignore-scripts",
        reproducibility: "source-rebuildable-not-bit-for-bit",
      });
      await writeFile(join(artifacts, archiveName), archiveBytes, { flag: "wx", mode: 0o400 });
      const provenanceName = "source-provenance.json";
      const provenanceBytes = `${JSON.stringify(provenance, null, 2)}\n`;
      if (Buffer.byteLength(provenanceBytes) > 32 * 1024 ** 2)
        throw new Error("Source provenance exceeds publisher byte limit");
      await writeFile(join(artifacts, provenanceName), provenanceBytes, {
        flag: "wx",
        mode: 0o400,
      });
      for (const name of [archiveName, provenanceName])
        files.push({
          name,
          role: "tool",
          executable: false,
          ...(await digestFile(join(artifacts, name))),
        });
    }
    for (const role of ["agent", "cli"] as const) {
      const name = role === "agent" ? "kq-agent" : "kq";
      const path = join(artifacts, name);
      await build(
        role,
        request.buildTarget,
        resolve(path),
        resolve(sourceRoot),
        buildEnvironment?.env,
      );
      await verifyElf(path, request.architecture);
      await chmod(path, 0o500);
      files.push({ name, role, executable: true, ...(await digestFile(path)) });
    }
    for (const input of request.inputs) {
      const source = resolve(dirname(requestPath), input.path);
      const before = await digestFile(source);
      if (before.size !== input.size || before.sha256 !== input.sha256)
        throw new Error(`Verified input mismatch: ${input.name}`);
      const path = join(artifacts, input.name);
      await copyFile(source, path);
      const copied = await digestFile(path);
      if (copied.size !== input.size || copied.sha256 !== input.sha256)
        throw new Error(`Copied input mismatch: ${input.name}`);
      await chmod(path, input.executable ? 0o500 : 0o400);
      const { path: _path, ...file } = input;
      files.push(file);
    }
    const sourceAfter = await captureSource(repository);
    if (sourceAfter.sourceFingerprint !== sourceBefore.sourceFingerprint)
      throw new Error("Source changed during release preparation");
    if (mode === "release") {
      await buildEnvironment?.verify();
      await assertMaterializedSource(sourceBefore.archive, sourceRoot);
      if (sha256(await readFile(join(sourceRoot, "bun.lock"))) !== provenance?.lockSha256)
        throw new Error("Frozen dependency lock changed during build");
      await rm(sourceRoot, { recursive: true });
      await rm(join(resolve(output), "build-environment"), { recursive: true });
    }
    const manifest = siteReleaseSchema.parse({ version: 1, ...compatibility, files });
    const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
    const id = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(output, "manifest.json"), bytes, { mode: 0o400, flag: "wx" });
    await writeFile(
      join(output, "prepare.json"),
      `${JSON.stringify({ version: 1, channel, manifestDigest: id, sourceRevision, sourceDirty, mode, sourcePolicy, sourceFingerprint: sourceBefore.sourceFingerprint, buildTarget, compatibilityEvidence: computeInventory ? "inventory-checked" : "static-only", computeInventorySha256, requireSpack, bunVersion: Bun.version, signed: false, published: false }, null, 2)}\n`,
      { mode: 0o400, flag: "wx" },
    );
    return { id, manifest, channel, sourceDirty };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const [request, output, ...extra] = process.argv.slice(2);
  if (!request || !output || extra.length)
    throw new Error("Expected request.json and a new output directory");
  const prepared = await prepareSiteRelease(request, output);
  console.log(
    `Prepared unsigned release ${prepared.id} for ${prepared.channel}; sourceDirty=${prepared.sourceDirty}. Review manifest and prepare.json before signing or publishing.`,
  );
}

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMaterializedSource,
  assertSourceHasNoCredentials,
  excludedSourcePath,
  materializeSource,
  releaseBuildCommand,
  type SourceArchive,
  type SourceProvenance,
  sha256,
  sourceArchiveSchema,
  sourceProvenanceSchema,
  validateProvenance,
} from "./source-provenance";

function fixture() {
  const entries = [
    ["bun.lock", '{"lockfileVersion":1}'],
    ["package.json", JSON.stringify({ packageManager: "bun@1.4.2" })],
    ["packages/agent/src/index.ts", "export const agent = true;"],
    ["packages/cli/src/index.ts", "export const cli = true;"],
    ["packages/proto/package.json", "{}"],
    ["packages/agent/src/untracked.ts", "export const dirty = true;"],
    ["packages/proto/proto/service.proto", 'syntax = "proto3";'],
    ["packages/proto/buf.gen.yaml", "version: v2"],
  ];
  const archive: SourceArchive = {
    version: 1,
    kind: "kq-source-archive",
    files: entries.map(([path, content]) => {
      if (!path || content === undefined) throw new Error("Invalid fixture");
      const bytes = Buffer.from(content);
      return {
        path,
        executable: false,
        size: bytes.length,
        sha256: sha256(bytes),
        content: bytes.toString("base64"),
      };
    }),
  };
  const files = archive.files.map(({ content: _content, ...file }) => file);
  const lock = files[0];
  if (!lock) throw new Error("Missing fixture lock");
  const sourceRevision = "a".repeat(40);
  const gitFingerprint = "b".repeat(64);
  const archiveBytes = JSON.stringify(archive);
  const archiveSha = sha256(archiveBytes);
  const provenance: SourceProvenance = {
    version: 1,
    kind: "kq-source-provenance",
    mode: "release",
    policy: "sealed",
    sourceRevision,
    sourceDirty: true,
    gitFingerprint,
    sourceFingerprint: sha256(JSON.stringify({ revision: sourceRevision, gitFingerprint, files })),
    archive: {
      name: `source-${archiveSha}.json`,
      size: Buffer.byteLength(archiveBytes),
      sha256: archiveSha,
    },
    files,
    bunVersion: "1.4.2",
    packageManager: "bun@1.4.2",
    lockSha256: lock.sha256,
    buildTarget: "bun-linux-x64-baseline",
    commands: [
      ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
      ["bun", "run", "--filter", "@kuintessence/proto", "generate"],
      releaseBuildCommand("agent", "bun-linux-x64-baseline", "artifacts/kq-agent"),
      releaseBuildCommand("cli", "bun-linux-x64-baseline", "artifacts/kq"),
    ],
    buildEnvironment: {
      policy: "allowlist-private-home",
      platform: "linux",
      architecture: "x64",
      bun: { path: "/usr/local/bin/bun", sha256: "c".repeat(64) },
      node: { path: "/usr/bin/node", sha256: "d".repeat(64), version: "v22.0.0" },
      osReleaseSha256: "e".repeat(64),
      caFiles: [],
      systemDependencies: "recorded-tools-host-os-and-system-trust",
    },
    codegenVersions: { buf: "1.68.4", protocGenEs: "2.12.0" },
    dependencyPolicy: "frozen-lockfile-ignore-scripts",
    reproducibility: "source-rebuildable-not-bit-for-bit",
  };
  return { archive, provenance };
}

test("sealed archive restores dirty/untracked source, lock and codegen inputs; mutations are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-source-"));
  try {
    const { archive, provenance } = fixture();
    validateProvenance(provenance, archive);
    const output = join(root, "source");
    await materializeSource(archive, output);
    expect(await readFile(join(output, "packages/agent/src/untracked.ts"), "utf8")).toContain(
      "dirty = true",
    );
    await assertMaterializedSource(archive, output);
    await writeFile(join(output, "injected.ts"), "export const injected = true;");
    await expect(assertMaterializedSource(archive, output)).rejects.toThrow("unsealed");
    await rm(join(output, "injected.ts"));
    await writeFile(join(output, "bun.lock"), "changed");
    await expect(assertMaterializedSource(archive, output)).rejects.toThrow("modified");
    await rm(join(output, "bun.lock"));
    await symlink(join(output, "package.json"), join(output, "bun.lock"));
    await expect(assertMaterializedSource(archive, output)).rejects.toThrow("link");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provenance cannot mislabel dirty as clean, replace lock/toolchain or change frozen build commands", () => {
  const { archive, provenance } = fixture();
  expect(() => validateProvenance({ ...provenance, policy: "clean" }, archive)).toThrow("dirty");
  expect(() => validateProvenance({ ...provenance, lockSha256: "0".repeat(64) }, archive)).toThrow(
    "dependency",
  );
  expect(() => validateProvenance({ ...provenance, bunVersion: "1.4.3" }, archive)).toThrow("Bun");
  expect(() =>
    validateProvenance(
      { ...provenance, commands: [["bun", "install"], ...provenance.commands.slice(1)] },
      archive,
    ),
  ).toThrow("commands");
  const mutated = structuredClone(archive);
  const mutatedLock = mutated.files[0];
  if (!mutatedLock) throw new Error("Missing fixture lock");
  mutatedLock.content = Buffer.from("tampered lock").toString("base64");
  expect(() => validateProvenance(provenance, mutated)).toThrow("archive entry");
});

test("source restoration rejects traversal, duplicate entries, corrupt content, secrets and runtime paths", async () => {
  const { archive } = fixture();
  const entry = archive.files[0];
  if (!entry) throw new Error("Missing fixture entry");
  for (const path of ["../escape", "/absolute", "a//b", "a/./b", "a\\b"]) {
    expect(sourceArchiveSchema.safeParse({ ...archive, files: [{ ...entry, path }] }).success).toBe(
      false,
    );
  }
  for (const path of [
    ".env",
    "nested/.env.production",
    "keys/private.pem",
    "agent.env",
    "node_modules/package/index.ts",
    "data.db",
    "__pycache__/x.pyc",
    "packages/proto/src/generated/service.ts",
  ])
    expect(excludedSourcePath(path)).toBe(true);
  expect(excludedSourcePath(".env.example")).toBe(false);
  const root = await mkdtemp(join(tmpdir(), "kq-source-invalid-"));
  try {
    await expect(
      materializeSource({ ...archive, files: [entry, entry] }, join(root, "duplicate")),
    ).rejects.toThrow("Duplicate");
    await expect(
      materializeSource(
        { ...archive, files: [{ ...entry, content: "dGFtcGVyZWQ=" }] },
        join(root, "tamper"),
      ),
    ).rejects.toThrow("mismatch");
    await expect(
      materializeSource({ ...archive, files: [{ ...entry, path: ".env" }] }, join(root, "secret")),
    ).rejects.toThrow("excluded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formal publisher binds complete archive and provenance through signed manifest artifacts", async () => {
  const { generateKeyPairSync, verify } = await import("node:crypto");
  const { publishSiteRelease } = await import("./publish");
  const root = await mkdtemp(join(tmpdir(), "kq-source-publish-"));
  try {
    const { archive, provenance } = fixture();
    const archiveBytes = JSON.stringify(archive);
    const provenanceBytes = JSON.stringify(provenance);
    const artifacts = [
      { name: "kq-agent", role: "agent", executable: true, bytes: "binary-agent" },
      { name: "kq", role: "cli", executable: true, bytes: "binary-cli" },
      { name: provenance.archive.name, role: "tool", executable: false, bytes: archiveBytes },
      { name: "source-provenance.json", role: "tool", executable: false, bytes: provenanceBytes },
    ];
    for (const artifact of artifacts) await writeFile(join(root, artifact.name), artifact.bytes);
    const manifest = {
      version: 1,
      sequence: 1,
      serverRevision: provenance.sourceRevision,
      stateFormat: "v1",
      architecture: "x86_64",
      minGlibc: "2.28",
      cpuFlags: [],
      redistribution: "unrestricted",
      files: artifacts.map(({ bytes, ...artifact }) => ({
        ...artifact,
        size: Buffer.byteLength(bytes),
        sha256: sha256(bytes),
      })),
    };
    const bytes = JSON.stringify(manifest);
    const path = join(root, "manifest.json");
    await writeFile(path, bytes);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = join(root, "key.pem");
    await writeFile(key, privateKey.export({ format: "pem", type: "pkcs8" }));
    const output = join(root, "published");
    const id = await publishSiteRelease(path, root, output, "stable", key);
    expect(
      verify(
        null,
        Buffer.from(bytes),
        publicKey,
        await readFile(join(output, "releases", id, "manifest.sig")),
      ),
    ).toBe(true);
    expect(await readFile(join(output, "releases", id, provenance.archive.name), "utf8")).toBe(
      archiveBytes,
    );
    await writeFile(join(root, provenance.archive.name), `${archiveBytes} `);
    await expect(publishSiteRelease(path, root, output, "stable", key)).rejects.toThrow(
      "size mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source archives exclude non-example environment and standard credential stores", () => {
  for (const path of [
    "server.env",
    "deploy/production.env",
    "deploy/site.env.local",
    "deploy/schedulers/ports-alt.env",
    ".aws/credentials",
    ".ssh/id_ed25519",
    ".docker/config.json",
    ".kube/config",
    ".netrc",
    ".git-credentials",
    "service-account.json",
    "secrets.json",
  ]) {
    expect(excludedSourcePath(path)).toBe(true);
  }
  for (const path of [
    ".env.example",
    "deploy/systemd/kq-agent.env.example",
    "packages/agent/src/config.ts",
    ".npmrc",
  ]) {
    expect(excludedSourcePath(path)).toBe(false);
  }
});

test("capture, restore and publish share rejection of package-manager authentication and embedded private keys", () => {
  for (const [path, text] of [
    [".npmrc", "//registry.example.invalid/:_authToken=secret"],
    [".npmrc", "registry=https://builder:secret@registry.example.invalid/"],
    ["bunfig.toml", 'registry = { url = "https://registry.example.invalid", token = "secret" }'],
    [".bunfig.toml", '[install.registry]\npassword = "secret"'],
    ["embedded.ts", `-----BEGIN PRIVATE KEY-----\n${"A".repeat(32)}`],
  ]) {
    expect(() => assertSourceHasNoCredentials(path ?? "", Buffer.from(text ?? ""))).toThrow();
  }
  expect(() =>
    assertSourceHasNoCredentials(".npmrc", Buffer.from("registry=https://registry.npmjs.org/\n")),
  ).not.toThrow();
  expect(() =>
    assertSourceHasNoCredentials(
      "form.tsx",
      Buffer.from('placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"'),
    ),
  ).not.toThrow();
  const { archive, provenance } = fixture();
  const bytes = Buffer.from("//registry.example.invalid/:_authToken=secret");
  const malicious = structuredClone(archive);
  malicious.files.push({
    path: ".npmrc",
    size: bytes.length,
    sha256: sha256(bytes),
    executable: false,
    content: bytes.toString("base64"),
  });
  const files = malicious.files.map(({ content: _content, ...file }) => file);
  const changed = {
    ...provenance,
    files,
    sourceFingerprint: sha256(
      JSON.stringify({
        revision: provenance.sourceRevision,
        gitFingerprint: provenance.gitFingerprint,
        files,
      }),
    ),
  };
  expect(() => validateProvenance(changed, malicious)).toThrow("authentication");
});

test("formal provenance requires the environment policy and supported Node toolchain", () => {
  const { provenance } = fixture();
  expect(
    sourceProvenanceSchema.safeParse({ ...provenance, buildEnvironment: undefined }).success,
  ).toBe(false);
  expect(
    sourceProvenanceSchema.safeParse({
      ...provenance,
      buildEnvironment: {
        ...provenance.buildEnvironment,
        NODE_OPTIONS: "--require=/unsealed/preload.js",
      },
    }).success,
  ).toBe(false);
  expect(
    sourceProvenanceSchema.safeParse({
      ...provenance,
      buildEnvironment: {
        ...provenance.buildEnvironment,
        node: { ...provenance.buildEnvironment.node, version: "v18.0.0" },
      },
    }).success,
  ).toBe(false);
});

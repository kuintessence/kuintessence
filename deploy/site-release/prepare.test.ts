import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { siteReleaseSchema } from "../../packages/server/src/routes/site-releases";
import { prepareSiteRelease, sitePrepareSchema } from "./prepare";
import { publishSiteRelease } from "./publish";

const revision = (
  await new Response(Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout).text()
).trim();
const metadata = {
  channel: "review",
  sequence: 1,
  serverRevision: revision,
  stateFormat: "v1",
  architecture: "x86_64",
  minGlibc: "2.28",
  cpuFlags: ["sse4_2"],
  buildTarget: "bun-linux-x64-baseline",
  redistribution: "unrestricted",
  inputs: [],
};
const elf = Buffer.alloc(20);
elf.set(Buffer.from("7f454c460201", "hex"));
elf.writeUInt16LE(62, 18);
const fakeBuild = async (
  _role: "agent" | "cli",
  _target: "bun-linux-x64" | "bun-linux-x64-baseline" | "bun-linux-arm64",
  destination: string,
) => {
  await writeFile(destination, elf);
};

test("prepare builds standalone artifacts, verifies supplied inputs and produces publisher-compatible unsigned manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-prepare-"));
  try {
    const inputBytes = Buffer.from("verified runtime");
    await writeFile(join(root, "runtime.sif"), inputBytes);
    const request = {
      ...metadata,
      inputs: [
        {
          path: "runtime.sif",
          name: "runtime.sif",
          role: "runtime-sif",
          size: inputBytes.length,
          sha256: createHash("sha256").update(inputBytes).digest("hex"),
          executable: false,
        },
      ],
    };
    const requestPath = join(root, "request.json");
    await writeFile(requestPath, JSON.stringify(request));
    const output = join(root, "prepared");
    const prepared = await prepareSiteRelease(requestPath, output, fakeBuild);
    expect(siteReleaseSchema.parse(prepared.manifest).files).toHaveLength(3);
    const receipt = JSON.parse(await readFile(join(output, "prepare.json"), "utf8"));
    expect(receipt).toMatchObject({
      channel: "review",
      signed: false,
      published: false,
      sourceRevision: revision,
      compatibilityEvidence: "static-only",
      requireSpack: false,
    });
    const key = join(root, "private.pem");
    await writeFile(
      key,
      generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    expect(
      await publishSiteRelease(
        join(output, "manifest.json"),
        join(output, "artifacts"),
        join(root, "published"),
        "review",
        key,
      ),
    ).toBe(prepared.id);
    await expect(prepareSiteRelease(requestPath, output, fakeBuild)).rejects.toThrow();
    expect(await readFile(join(output, "artifacts/runtime.sif"))).toEqual(inputBytes);
    const firstInput = request.inputs[0];
    if (!firstInput) throw new Error("Missing fixture input");
    firstInput.sha256 = "0".repeat(64);
    await writeFile(requestPath, JSON.stringify(request));
    await expect(prepareSiteRelease(requestPath, join(root, "bad"), fakeBuild)).rejects.toThrow(
      "input mismatch",
    );
    expect(await Bun.file(join(root, "bad/manifest.json")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("prepare requires explicit compatible metadata and never invents target compatibility", () => {
  expect(sitePrepareSchema.safeParse({ ...metadata, architecture: "aarch64" }).success).toBe(false);
  expect(sitePrepareSchema.safeParse({ ...metadata, minGlibc: undefined }).success).toBe(false);
  expect(sitePrepareSchema.safeParse({ ...metadata, cpuFlags: undefined }).success).toBe(false);
  expect(sitePrepareSchema.safeParse({ ...metadata, serverRevision: "unknown" }).success).toBe(
    false,
  );
});

test("release preparation and publication reject artifact names that collide with resume paths", async () => {
  const { siteReleaseManifestSchema } = await import("./manifest");
  const files = [
    { name: "kq-agent", role: "agent", executable: true, size: 20, sha256: "a".repeat(64) },
    { name: "kq", role: "cli", executable: true, size: 20, sha256: "b".repeat(64) },
    { name: "kq.part", role: "tool", executable: false, size: 20, sha256: "c".repeat(64) },
  ];
  const { channel: _channel, buildTarget: _target, inputs: _inputs, ...compatibility } = metadata;
  expect(siteReleaseManifestSchema.safeParse({ ...compatibility, version: 1, files }).success).toBe(
    false,
  );
});

test("requireSpack rejects incomplete roles before preparation", () => {
  expect(sitePrepareSchema.safeParse({ ...metadata, requireSpack: true }).success).toBe(false);
  expect(sitePrepareSchema.safeParse({ ...metadata, requireSpack: "true" }).success).toBe(false);
});

test("prepare tracks original inventory digest without publishing its local path", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-inventory-prepare-"));
  try {
    const report = JSON.stringify({
      schemaVersion: 1,
      kind: "kq-compute-inventory",
      ok: true,
      sum: 4950,
      os: { ID: "rocky", VERSION_ID: "9.4" },
      arch: "x86_64",
      libc: { name: "glibc", version: "2.34" },
      cpu: { supportedFlags: ["sse4_2", "ssse3", "popcnt"] },
      python: { status: "passed", version: "3.11.9", module: "python/3.11" },
      compiler: { status: "not-tested" },
      mpi: { status: "not-tested" },
      shared: { workingDirectoryInsideShared: true, writeReadDelete: "passed" },
    });
    await writeFile(join(root, "private-report.json"), report);
    const requestPath = join(root, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        ...metadata,
        cpuFlags: ["sse4_2", "ssse3", "popcnt"],
        computeInventory: "private-report.json",
      }),
    );
    const output = join(root, "prepared");
    await prepareSiteRelease(requestPath, output, fakeBuild);
    const receipt = await readFile(join(output, "prepare.json"), "utf8");
    expect(JSON.parse(receipt)).toMatchObject({
      compatibilityEvidence: "inventory-checked",
      computeInventorySha256: createHash("sha256").update(report).digest("hex"),
    });
    expect(receipt).not.toContain("private-report.json");
    expect(await readFile(join(output, "manifest.json"), "utf8")).not.toContain("computeInventory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("requireSpack validates complete trusted inputs and native Agent profile confirmations", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-spack-prepare-"));
  try {
    const runtime = Buffer.from("trusted runtime");
    const runtimeSha = createHash("sha256").update(runtime).digest("hex");
    const profile = {
      version: 1,
      storeRoot: "/shared/site/spack",
      target: "linux-rocky9-haswell",
      runtimeSifSha256: runtimeSha,
      osReleaseSha256: "b".repeat(64),
      hostFiles: [{ path: "/etc/os-release", sha256: "c".repeat(64) }],
      externals: [],
      sharedStoreConfirmed: true,
      compatibleComputeNodesConfirmed: true,
      trustedRecipesConfirmed: true,
      quotaEnforcedBySite: true,
    };
    const inputs = [];
    for (const [role, name, bytes] of [
      ["runtime-sif", "runtime.sif", runtime],
      ["site-profile", "profile.json", Buffer.from(JSON.stringify(profile))],
      ["spack", "spack", Buffer.from("#!/bin/sh\nexit 0\n")],
    ] as const) {
      await writeFile(join(root, name), bytes);
      inputs.push({
        role,
        name,
        path: name,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        executable: role === "spack",
      });
    }
    const requestPath = join(root, "request.json");
    await writeFile(requestPath, JSON.stringify({ ...metadata, requireSpack: true, inputs }));
    const output = join(root, "prepared");
    const result = await prepareSiteRelease(requestPath, output, fakeBuild);
    expect(result.manifest.files).toHaveLength(5);
    expect(JSON.parse(await readFile(join(output, "prepare.json"), "utf8"))).toMatchObject({
      requireSpack: true,
      compatibilityEvidence: "static-only",
    });
    const profileInput = inputs.find((item) => item.role === "site-profile");
    if (!profileInput) throw new Error("Missing profile fixture");
    const oversized = Buffer.alloc(128 * 1024 + 1, 32);
    await writeFile(join(root, "profile.json"), oversized);
    await writeFile(
      requestPath,
      JSON.stringify({
        ...metadata,
        requireSpack: true,
        inputs: inputs.map((item) =>
          item.role === "site-profile"
            ? {
                ...item,
                size: oversized.length,
                sha256: createHash("sha256").update(oversized).digest("hex"),
              }
            : item,
        ),
      }),
    );
    await expect(
      prepareSiteRelease(requestPath, join(root, "oversized"), fakeBuild),
    ).rejects.toThrow("128 KiB");
    // A false small declaration must not bypass the limit on actual bytes.
    await writeFile(requestPath, JSON.stringify({ ...metadata, requireSpack: true, inputs }));
    await expect(
      prepareSiteRelease(requestPath, join(root, "oversized-file"), fakeBuild),
    ).rejects.toThrow("128 KiB");
    // A false oversized declaration must be rejected even for a small file.
    await writeFile(join(root, "profile.json"), JSON.stringify(profile));
    await writeFile(
      requestPath,
      JSON.stringify({
        ...metadata,
        requireSpack: true,
        inputs: inputs.map((item) =>
          item.role === "site-profile" ? { ...item, size: oversized.length } : item,
        ),
      }),
    );
    await expect(
      prepareSiteRelease(requestPath, join(root, "oversized-declaration"), fakeBuild),
    ).rejects.toThrow("128 KiB");
    const badProfile = Buffer.from(
      JSON.stringify({ ...profile, runtimeSifSha256: "f".repeat(64) }),
    );
    await writeFile(join(root, "profile.json"), badProfile);
    const input = inputs.find((item) => item.role === "site-profile");
    if (!input) throw new Error("Missing profile fixture");
    input.size = badProfile.length;
    input.sha256 = createHash("sha256").update(badProfile).digest("hex");
    await writeFile(requestPath, JSON.stringify({ ...metadata, requireSpack: true, inputs }));
    await expect(prepareSiteRelease(requestPath, join(root, "bad"), fakeBuild)).rejects.toThrow(
      "digest",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("formal release requires explicit source policy and reserves signed provenance artifacts", () => {
  expect(sitePrepareSchema.parse({ ...metadata, mode: "release" }).sourcePolicy).toBe("clean");
  expect(
    sitePrepareSchema.parse({ ...metadata, mode: "release", sourcePolicy: "sealed" }).mode,
  ).toBe("release");
  expect(
    sitePrepareSchema.safeParse({
      ...metadata,
      mode: "release",
      inputs: [
        {
          path: "local.json",
          name: "source-provenance.json",
          role: "tool",
          executable: false,
          size: 1,
          sha256: "a".repeat(64),
        },
      ],
    }).success,
  ).toBe(false);
});

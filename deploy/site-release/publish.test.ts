import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishSiteRelease } from "./publish";

test("publishing is repeatable and corrupt artifacts or rollback cannot replace the channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-publish-"));
  try {
    const key = join(root, "key.pem");
    await writeFile(
      key,
      generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    for (const name of ["agent", "cli"]) await writeFile(join(root, name), "artifact");
    const manifest = {
      version: 1,
      sequence: 2,
      serverRevision: "a".repeat(40),
      stateFormat: "v1",
      architecture: "x86_64",
      minGlibc: "2.28",
      cpuFlags: [],
      redistribution: "unrestricted",
      files: ["agent", "cli"].map((role) => ({
        name: role,
        role,
        size: 8,
        sha256: createHash("sha256").update("artifact").digest("hex"),
        executable: true,
      })),
    };
    const path = join(root, "input.json");
    await writeFile(path, JSON.stringify(manifest));
    const publish = () => publishSiteRelease(path, root, join(root, "output"), "review", key);
    const id = await publish();
    expect(await publish()).toBe(id);
    manifest.sequence = 1;
    await writeFile(path, JSON.stringify(manifest));
    await expect(publish()).rejects.toThrow("sequence");
    manifest.sequence = 3;
    await writeFile(path, JSON.stringify(manifest));
    await writeFile(join(root, "agent"), "corrupt!");
    await expect(publish()).rejects.toThrow("digest");
    expect((await readFile(join(root, "output/channels/review"), "utf8")).trim()).toBe(id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent channel publishers cannot race the sequence check or steal a retained lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-publish-concurrent-"));
  try {
    const key = join(root, "key.pem");
    await writeFile(
      key,
      generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    for (const name of ["agent", "cli"]) await writeFile(join(root, name), "artifact");
    const base = {
      version: 1,
      sequence: 2,
      serverRevision: "a".repeat(40),
      stateFormat: "v1",
      architecture: "x86_64",
      minGlibc: "2.28",
      cpuFlags: [],
      redistribution: "unrestricted",
      files: ["agent", "cli"].map((role) => ({
        name: role,
        role,
        size: 8,
        sha256: createHash("sha256").update("artifact").digest("hex"),
        executable: true,
      })),
    };
    const low = join(root, "low.json");
    const high = join(root, "high.json");
    await writeFile(low, JSON.stringify(base));
    await writeFile(high, JSON.stringify({ ...base, sequence: 3 }));
    const output = join(root, "output");
    const settled = await Promise.allSettled([
      publishSiteRelease(low, root, output, "review", key),
      publishSiteRelease(high, root, output, "review", key),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    const highId = await publishSiteRelease(high, root, output, "review", key);
    await expect(publishSiteRelease(low, root, output, "review", key)).rejects.toThrow("sequence");
    expect((await readFile(join(output, "channels/review"), "utf8")).trim()).toBe(highId);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(output, "channels/.review.publish-lock"));
    await expect(publishSiteRelease(high, root, output, "review", key)).rejects.toThrow("locked");
    expect((await readFile(join(output, "channels/review"), "utf8")).trim()).toBe(highId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formal stable channel refuses to sign artifacts without a complete source archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-formal-publish-"));
  try {
    const key = join(root, "key.pem");
    await writeFile(
      key,
      generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    for (const name of ["agent", "cli"]) await writeFile(join(root, name), "artifact");
    const manifest = {
      version: 1,
      sequence: 1,
      serverRevision: "a".repeat(40),
      stateFormat: "v1",
      architecture: "x86_64",
      minGlibc: "2.28",
      cpuFlags: [],
      redistribution: "unrestricted",
      files: ["agent", "cli"].map((role) => ({
        name: role,
        role,
        executable: true,
        size: 8,
        sha256: createHash("sha256").update("artifact").digest("hex"),
      })),
    };
    const path = join(root, "manifest.json");
    await writeFile(path, JSON.stringify(manifest));
    await expect(
      publishSiteRelease(path, root, join(root, "output"), "stable", key),
    ).rejects.toThrow("source provenance");
    expect(await Bun.file(join(root, "output/channels/stable")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

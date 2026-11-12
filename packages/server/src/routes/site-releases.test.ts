import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSiteReleaseRoutes } from "./site-releases";

test("immutable signed release routes bind artifacts and correctly serve resumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-release-"));
  try {
    const bytes = Buffer.from("artifact");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const manifest = Buffer.from(
      JSON.stringify({
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
          size: bytes.length,
          sha256: hash,
          executable: true,
        })),
      }),
    );
    const id = createHash("sha256").update(manifest).digest("hex");
    const release = join(root, "releases", id);
    await mkdir(release, { recursive: true });
    await mkdir(join(root, "channels"));
    const keys = generateKeyPairSync("ed25519");
    await writeFile(join(release, "manifest.json"), manifest);
    await writeFile(join(release, "manifest.sig"), sign(null, manifest, keys.privateKey));
    await writeFile(join(release, "agent"), bytes);
    await writeFile(join(release, "cli"), bytes);
    await writeFile(join(root, "channels", "stable"), id);
    const app = createSiteReleaseRoutes(root);
    const published = await app.request("/site-releases/stable/manifest.json");
    const signature = await app.request(`/site-releases/releases/${id}/manifest.sig`);
    expect(
      verify(
        null,
        Buffer.from(await published.arrayBuffer()),
        keys.publicKey,
        Buffer.from(await signature.arrayBuffer()),
      ),
    ).toBe(true);
    const resumed = await app.request(`/site-releases/releases/${id}/agent`, {
      headers: { Range: "bytes=3-", "If-Range": `"${hash}"` },
    });
    expect(resumed.status).toBe(206);
    expect(await resumed.text()).toBe("ifact");
    expect((await app.request(`/site-releases/releases/${id}/unknown`)).status).toBe(404);
    expect(
      (
        await app.request(`/site-releases/releases/${id}/agent`, {
          headers: { Range: "bytes=99-" },
        })
      ).status,
    ).toBe(416);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

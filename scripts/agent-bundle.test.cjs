const { describe, expect, test } = require("bun:test");
const { createHash } = require("node:crypto");
const { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { parse } = require("yaml");
const { TARGETS, writeManifest } = require("./build-agent-bundle.cjs");

const root = resolve(__dirname, "..");
const revision = "a".repeat(40);

describe("bundled Agent identity", () => {
  test("records both architectures, complete hashes and the exact source revision", () => {
    const directory = mkdtempSync(join(tmpdir(), "kq-agent-bundle-"));
    try {
      for (const [index, target] of TARGETS.entries()) {
        const bytes = Buffer.alloc(64, index);
        Buffer.from("7f454c460201", "hex").copy(bytes);
        bytes.writeUInt16LE(index === 0 ? 62 : 183, 18);
        writeFileSync(join(directory, `kq-agent-${target}`), bytes);
      }
      const manifest = writeManifest(directory, revision, "0.1.0-rc.1", "1.4.2");
      expect(manifest.revision).toBe(revision);
      expect(manifest.files).toHaveLength(2);
      const checksums = readFileSync(join(directory, "SHA256SUMS"), "utf8");
      for (const line of checksums.trim().split("\n")) {
        const [hash, filename] = line.split("  ");
        expect(
          createHash("sha256")
            .update(readFileSync(join(directory, filename)))
            .digest("hex"),
        ).toBe(hash);
      }
      for (const file of manifest.files) {
        expect(file.size).toBe(64);
        expect(statSync(join(directory, file.name)).mode & 0o777).toBe(0o755);
      }
      expect(() => writeManifest(directory, "main", "0.1.0", "1.4.2")).toThrow("revision");
      writeFileSync(
        join(directory, "kq-agent-bun-linux-arm64"),
        readFileSync(join(directory, "kq-agent-bun-linux-x64")),
      );
      expect(() => writeManifest(directory, revision, "0.1.0", "1.4.2")).toThrow("bun-linux-arm64");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Docker compiles the checked-out Agent and copies only its bundle to the runtime", () => {
    const dockerfile = readFileSync(join(root, "packages/server/Dockerfile"), "utf8");
    expect(dockerfile).toContain("FROM build AS agent-binaries");
    expect(dockerfile).toContain("COPY packages/agent ./packages/agent");
    expect(dockerfile).toContain(
      "COPY --from=agent-binaries /opt/kuintessence/agent /opt/kuintessence/agent",
    );
    expect(dockerfile).toContain(
      'RUN bun scripts/build-agent-bundle.cjs /opt/kuintessence/agent "$KQ_BUILD_REVISION"',
    );
    const workflow = parse(readFileSync(join(root, ".github/workflows/build-images.yml"), "utf8"));
    const verification = workflow.jobs.images.steps.find((step) => step.env?.IMAGE_DIGEST);
    expect(verification.if).toBe("matrix.component == 'server'");
    expect(verification.env.IMAGE_DIGEST).toBe(`\${{ steps.build.outputs.digest }}`);
    expect(verification.run).toContain("scripts/verify-agent-bundle.cjs");
    expect(workflow.jobs["deploy-main"].needs).toBe("images");
    const pr = parse(readFileSync(join(root, ".github/workflows/server-agent-bundle.yml"), "utf8"));
    expect(
      pr.jobs.bundle.steps.find((step) => step.uses === "docker/build-push-action@v6").with.push,
    ).toBe(false);
    expect(pr.jobs.bundle.steps.at(-1).run).toContain("scripts/verify-agent-bundle.cjs");
  });
});

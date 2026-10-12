const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { chmodSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { resolve, join } = require("node:path");

const TARGETS = ["bun-linux-x64", "bun-linux-arm64"];
const root = resolve(__dirname, "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function writeManifest(directory, revision, agentVersion, bunVersion) {
  if (!/^(?:[a-f0-9]{40}|unknown)$/.test(revision)) throw new Error("Invalid build revision");
  const files = TARGETS.map((target) => {
    const name = `kq-agent-${target}`;
    const bytes = readFileSync(join(directory, name));
    const machine = target === "bun-linux-x64" ? 62 : 183;
    if (
      bytes.length < 20 ||
      bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== machine
    ) {
      throw new Error(`Invalid Linux executable for ${target}`);
    }
    chmodSync(join(directory, name), 0o755);
    return { name, target, size: bytes.length, sha256: sha256(bytes) };
  });
  const manifest = { version: 1, revision, agentVersion, bunVersion, files };
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(directory, "manifest.json"), json);
  writeFileSync(
    join(directory, "SHA256SUMS"),
    [
      ...files.map((file) => `${file.sha256}  ${file.name}\n`),
      `${sha256(json)}  manifest.json\n`,
    ].join(""),
  );
  return manifest;
}

if (require.main === module) {
  const [directory, revision] = process.argv.slice(2);
  if (!directory || !/^(?:[a-f0-9]{40}|unknown)$/.test(revision ?? "")) {
    throw new Error("Usage: bun scripts/build-agent-bundle.cjs <output-directory> <revision>");
  }
  mkdirSync(directory, { recursive: true });
  for (const target of TARGETS) {
    const result = spawnSync(
      process.execPath,
      [
        "build",
        "--compile",
        `--target=${target}`,
        // ssh2 falls back to node:crypto; host-native optional addons cannot be cross-compiled.
        "--external=cpu-features",
        "--external=./crypto/build/Release/sshcrypto.node",
        "packages/agent/src/index.ts",
        `--outfile=${resolve(directory, `kq-agent-${target}`)}`,
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Agent compilation failed for ${target}`);
  }
  const agent = JSON.parse(readFileSync(join(root, "packages/agent/package.json"), "utf8"));
  writeManifest(directory, revision, agent.version, Bun.version);
}

module.exports = { TARGETS, writeManifest };

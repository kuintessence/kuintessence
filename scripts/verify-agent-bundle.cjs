const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const { resolve, join } = require("node:path");

const [directory, revision] = process.argv.slice(2);
assert(
  directory && /^[a-f0-9]{40}$/.test(revision ?? ""),
  "Expected bundle directory and commit SHA",
);
const manifestBytes = readFileSync(join(directory, "manifest.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
assert.equal(manifest.version, 1);
assert.equal(manifest.revision, revision);
assert.deepEqual(
  manifest.files.map((file) => file.target),
  ["bun-linux-x64", "bun-linux-arm64"],
);
const sums = [];
for (const file of manifest.files) {
  assert.equal(file.name, `kq-agent-${file.target}`);
  const path = join(directory, file.name);
  const bytes = readFileSync(path);
  assert.equal(bytes.length, file.size);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  assert.equal(bytes.subarray(0, 6).toString("hex"), "7f454c460201");
  assert.equal(bytes.readUInt16LE(18), file.target === "bun-linux-x64" ? 62 : 183);
  assert(statSync(path).mode & 0o111, "Agent must be executable");
  sums.push(`${file.sha256}  ${file.name}\n`);
}
sums.push(`${createHash("sha256").update(manifestBytes).digest("hex")}  manifest.json\n`);
assert.equal(readFileSync(join(directory, "SHA256SUMS"), "utf8"), sums.join(""));
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
const smoke = spawnSync(resolve(directory, "kq-agent-bun-linux-x64"), [], {
  cwd: resolve(directory),
  env: { PATH: "/usr/bin:/bin" },
  encoding: "utf8",
  timeout: 30000,
});
if (smoke.error) throw smoke.error;
assert.equal(smoke.status, 1, "Agent must reject an empty configuration");
assert.match(`${smoke.stdout}${smoke.stderr}`, /Invalid Agent configuration:/);
console.log("Both Agent artifacts match the image revision and checksums; Linux x64 smoke passed.");

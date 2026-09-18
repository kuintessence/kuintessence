import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, chown, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { SpackMaterialManifestSchema, spackMaterialBlobs } from "@kuintessence/shared";
import { z } from "zod";
import { SpackMaterialCache } from "../../../packages/agent/src/spack/material-cache";
import { waitFor } from "../runtime";
import { caseDirectory, jsonRequest, login, OperationSchema, ReleaseSchema } from "./api";

assert.equal(process.env.KQ_PR_TEST, "1");
assert.equal(process.env.SERVER_HTTP_URL, "https://server:3443");
assert.equal(process.env.AGENT_SPACK_INSTALL_ENABLED, "false");
const origin = "https://server:3443";
const token = await login(origin);
const release = ReleaseSchema.parse(
  JSON.parse(await readFile("/case-control/release.json", "utf8")),
);
const cacheDirectory = "/var/lib/kuintessence/spack-materials";
const initial = await readdir(cacheDirectory).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
assert.deepEqual(initial, [], "The Agent must start with an empty material cache");
await waitFor(
  "mTLS Agent control channel",
  async () => z.object({
    agents: z.array(z.object({ agentId: z.string(), controlChannelOnline: z.boolean() })),
  }).parse(await jsonRequest(origin, token, "/cp/software/overview")),
  (view) => view.agents.some((agent) => agent.agentId === "pr-scheduler" && agent.controlChannelOnline),
);
const requested = OperationSchema.parse(
  await jsonRequest(origin, token, "/cp/software/operations", {
    agentId: "pr-scheduler",
    action: "install",
    spec: release.spec,
  }),
);
const completed = await waitFor(
  "Agent material download and lock preflight",
  async () => {
    const page = z.object({ items: z.array(OperationSchema) }).parse(
      await jsonRequest(origin, token, "/cp/software/operations?agentId=pr-scheduler"),
    );
    const operation = page.items.find((item) => item.id === requested.id);
    assert(operation, "Software operation disappeared");
    return operation;
  },
  (operation) => ["succeeded", "failed", "rejected"].includes(operation.status),
);
assert.equal(completed.status, "rejected", "Delivery must reach the disabled managed-install gate");
assert.match(completed.error ?? "", /managed offline Spack execution is not enabled yet/);
const cache = new SpackMaterialCache(cacheDirectory);
const signal = AbortSignal.timeout(120_000);
const bytes = await cache.readMetadata(
  { digest: release.binding.manifestDigest, size: release.manifestSize }, 2 * 1024 ** 2, signal,
);
const manifest = SpackMaterialManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
assert.equal(manifest.spec, release.spec);
const { stdout } = await promisify(execFile)("id", ["-u", "kq"]);
const uid = Number(stdout.trim());
assert(Number.isInteger(uid) && uid > 0);
await mkdir(caseDirectory, { mode: 0o755 });
await chown(caseDirectory, uid, uid);
assert.deepEqual(await readdir("/case-input"), [], "Native input volume must be empty");
await chmod("/case-input", 0o700);
await chown("/case-input", uid, uid);
await mkdir("/case-input/blobs", { mode: 0o700 });
await chown("/case-input/blobs", uid, uid);
await writeFile("/case-input/manifest.json", bytes, { mode: 0o400 });
await chown("/case-input/manifest.json", uid, uid);
const unique = new Map(spackMaterialBlobs(manifest).map((blob) => [blob.digest, blob]));
for (const blob of unique.values()) {
  const cached = await cache.reuse(blob, signal);
  assert(cached, "Agent did not download every declared blob");
  const destination = join("/case-input/blobs", blob.digest.slice(7));
  await copyFile(cached.path, destination);
  await chown(destination, uid, uid);
}
// Only already-verified material bytes go to the native test; no tickets or
// certificate/private cache directories are exposed to recipe execution.
await writeFile(join(caseDirectory, "manifest-digest"), release.binding.manifestDigest, { mode: 0o644 });
console.log(`Spack case: mTLS-dispatched Agent fetched and verified ${unique.size} blobs through Server HTTPS`);

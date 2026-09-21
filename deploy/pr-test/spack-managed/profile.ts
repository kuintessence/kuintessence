import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { SpackInstallSiteProfileSchema } from "../../../packages/agent/src/spack/install-contract";
import { selectedCase } from "../spack-case/fixture";

assert.equal(process.env.KQ_PR_TEST, "1");
assert.equal(process.getuid?.(), 0);
const hash = async (path: string) =>
  createHash("sha256").update(await readFile(path)).digest("hex");
const lock = z.object({
  concrete_specs: z.record(z.string(), z.object({
    external: z.object({
      path: z.string(),
      extra_attributes: z.record(z.string(), z.unknown()).optional(),
    }).optional(),
  })),
}).parse(JSON.parse(await readFile("/case-control/managed-lock.json", "utf8")));
const pins = new Set(["/usr/bin/make"]);
if (selectedCase().id === "samtools") {
  pins.add("/usr/bin/python3");
  pins.add("/usr/bin/perl");
}
function collect(value: unknown): void {
  if (typeof value === "string" && value.includes("/")) {
    assert(value.startsWith("/"), "External attribute must be a pinned absolute path");
    pins.add(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collect(entry);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collect(entry);
  }
}
const externals = Object.entries(lock.concrete_specs).flatMap(([digest, node]) => {
  if (!node.external) return [];
  collect(node.external.extra_attributes);
  return [{ hash: digest, prefix: node.external.path }];
});
const sif = "/opt/kq/runtime/spack.sif";
const info = await stat(sif);
assert.equal(info.uid, 0);
assert.equal(info.mode & 0o222, 0, "SIF must be readonly before Agent starts");
const sifDigest = await hash(sif);
const profile = SpackInstallSiteProfileSchema.parse({
  version: 1,
  storeRoot: "/srv/kq/spack",
  target: "linux-ubuntu20.04-x86_64",
  runtimeSifSha256: sifDigest,
  osReleaseSha256: await hash("/etc/os-release"),
  hostFiles: await Promise.all([...pins].sort().map(async (path) => ({
    path, sha256: await hash(path),
  }))),
  externals,
  // The Agent and Slurm tasks share this single disposable node and bounded FS.
  sharedStoreConfirmed: true,
  compatibleComputeNodesConfirmed: true,
  quotaEnforcedBySite: true,
  trustedRecipesConfirmed: true,
});
const profilePath = "/etc/kuintessence/managed/site.json";
await writeFile(profilePath, `${JSON.stringify(profile)}\n`, { mode: 0o444 });
await chmod(profilePath, 0o444);
const env = {
  AGENT_SPACK_AUDIT_APPTAINER_PATH: "/usr/bin/apptainer",
  AGENT_SPACK_AUDIT_APPTAINER_SHA256: await hash("/usr/bin/apptainer"),
  AGENT_SPACK_AUDIT_SIF_PATH: sif,
  AGENT_SPACK_AUDIT_SIF_SHA256: sifDigest,
  AGENT_SPACK_INSTALL_SITE_PROFILE_PATH: profilePath,
  AGENT_SPACK_INSTALL_SITE_PROFILE_SHA256: await hash(profilePath),
};
await writeFile("/etc/kuintessence/managed/runtime.env",
  `${Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\n")}\n`,
  { mode: 0o444 });

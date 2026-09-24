import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

assert.equal(process.env.KQ_PR_TEST, "1");
assert.equal(process.env.KQ_PR_SPACK_WORKFLOW, "1");
// Only the public key reaches Registry; the ephemeral signer stays in the operator volume.
process.env.ECOSYSTEM_RELEASE_TRUSTED_KEYS = await readFile(
  "/case-control/workflow-trusted-keys.json", "utf8",
);
const { default: application } = await import("../../../packages/registry/src/index");
Bun.serve(application);

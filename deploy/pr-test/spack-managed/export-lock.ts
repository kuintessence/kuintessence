import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";

assert.equal(process.env.KQ_PR_TEST, "1");
await copyFile("/opt/kq-case/spack.lock", "/case-control/managed-lock.json");

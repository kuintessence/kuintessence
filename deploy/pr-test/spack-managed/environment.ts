import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

assert.equal(process.env.KQ_PR_TEST, "1");
assert.equal(process.getuid?.(), 0);
const names = [
  "PATH", "LANG", "LC_ALL", "HOME", "NODE_ENV", "LOG_LEVEL", "BUN_INSTALL_CACHE_DIR",
  "SERVER_GRPC_URL", "SERVER_HTTP_URL", "AGENT_ID", "AGENT_SITE_NAME", "AGENT_DB_PATH",
  "AGENT_MTLS_REQUIRED", "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE",
  "AGENT_SPACK_ENABLED", "AGENT_SPACK_PATH", "AGENT_SPACK_CACHE_DIR",
  "AGENT_SPACK_AUDIT_ENABLED", "AGENT_SPACK_INSTALL_ENABLED", "AGENT_SPAWNER_BACKEND",
  "KQ_AGENT_REGISTRATION_SCHEDULER", "KQ_PR_SCHEDULER", "KQ_PR_TEST", "KQ_PR_SPACK_CASE",
  "KQ_PR_SPACK_WORKFLOW",
];
const lines = names.flatMap((name) => {
  const value = process.env[name];
  if (value === undefined) return [];
  assert(!/[\0\r\n]/.test(value), "Unsupported test environment value");
  return [`${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`];
});
await writeFile("/run/kq-pr/environment", `${lines.join("\n")}\n`, {
  mode: 0o600,
  flag: "wx",
});

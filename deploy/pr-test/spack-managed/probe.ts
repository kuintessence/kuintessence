import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { realSpackAuditProcess } from "../../../packages/agent/src/spack/audit-process";
import { buildSpackAuditCommand, verifySpackAuditRuntime } from "../../../packages/agent/src/spack/audit-runtime";

assert.equal(process.env.KQ_PR_TEST, "1");
assert.equal(process.getuid?.(), 1000);
const values = Object.fromEntries(
  (await readFile("/etc/kuintessence/managed/runtime.env", "utf8")).trim().split("\n")
    .map((line) => line.split("=")),
);
const runtime = {
  apptainerPath: values.AGENT_SPACK_AUDIT_APPTAINER_PATH ?? "",
  apptainerSha256: values.AGENT_SPACK_AUDIT_APPTAINER_SHA256 ?? "",
  sifPath: values.AGENT_SPACK_AUDIT_SIF_PATH ?? "",
  sifSha256: values.AGENT_SPACK_AUDIT_SIF_SHA256 ?? "",
};
const signal = AbortSignal.timeout(90_000);
await verifySpackAuditRuntime(runtime, signal);
const input = await mkdtemp("/var/lib/kuintessence/runtime-probe-");
try {
  await writeFile(join(input, "runtime.json"), JSON.stringify({
    hostNetworkNamespace: await readlink("/proc/self/ns/net"),
    hostPidNamespace: await readlink("/proc/self/ns/pid"),
  }), { mode: 0o400 });
  await copyFile("packages/agent/src/spack/worker/source_audit.py", join(input, "boundary.py"));
  await copyFile("deploy/pr-test/spack-managed/probe.py", join(input, "source_audit.py"));
  const result = await realSpackAuditProcess.run(
    buildSpackAuditCommand(runtime, input, `sha256:${"0".repeat(64)}`),
    {
      cwd: input,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: input,
        LANG: "C.UTF-8",
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      },
      timeoutMs: 90_000,
      maxOutputBytes: 2 * 1024 ** 2,
      signal,
    },
  );
  // This pre-material probe has no recipe, certificate or ticket. Still whitelist
  // runtime diagnostics instead of publishing arbitrary native error strings.
  for (const [name, expression] of [
    ["user-namespace", /user namespace|userns|uid_map/i],
    ["cgroup", /cgroup|systemd|dbus/i],
    ["mount", /mount|squashfuse|overlay/i],
    ["permission", /permission|not permitted/i],
  ] as const) {
    if (expression.test(result.stderr)) console.log(`Managed probe diagnostic: ${name}`);
  }
  if (result.exitCode !== 0) {
    // Only this pre-material probe can expose native diagnostics: its environment
    // is explicitly constructed and its sole input is the boundary verifier.
    // Never reuse this for an Agent operation or a recipe/build process.
    console.error(`Pre-material runtime stderr: ${JSON.stringify(result.stderr.slice(0, 8192))}`);
    console.error(`Pre-material verifier stdout: ${JSON.stringify(result.stdout.slice(0, 1024))}`);
  }
  assert.equal(result.exitCode, 0, "Production Apptainer runtime probe failed");
  assert.equal(result.stdout.trim(), "managed-runtime-boundary-ok");
  console.log("Managed case: production namespace/network/cgroup verifier passed");
} finally {
  await rm(input, { recursive: true, force: true });
}

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, chown, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Spawner } from "../adapters/base";
import { shellQuote } from "../adapters/base";
import { loadAgentConfig } from "../config";
import {
  attestSandboxRuntimeEnvironment,
  buildRuntimeIsolationProbeCommands,
} from "./runtime-attestation";

const roots: string[] = [];
const identity = {
  username: "kqagent",
  uid: process.getuid?.() || 501,
  gid: process.getgid?.() || 20,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kq-runtime-attestation-"));
  roots.push(root);
  await chmod(root, 0o700);
  if (process.getuid?.() === 0) await chown(root, identity.uid, identity.gid);
  const runtimePath = join(root, "runtime.sif");
  const negativeRuntimePath = join(root, "unauthorized.sif");
  const seccompPath = join(root, "seccomp.json");
  const seccompProbePath = join(root, "seccomp-probe.json");
  const eclPath = join(root, "ecl.toml");
  const publicKeyPath = join(root, "runtime-public.pem");
  const apptainerPath = join(root, "apptainer");
  const cgroupPath = join(root, "cgroup-check");
  const contents = new Map<string, string>([
    [runtimePath, "signed runtime"],
    [negativeRuntimePath, "unsigned runtime"],
    [seccompPath, '{"defaultAction":"SCMP_ACT_ALLOW"}'],
    [seccompProbePath, '{"defaultAction":"SCMP_ACT_ALLOW"}'],
    [eclPath, "activated = true"],
    [publicKeyPath, "public key"],
    [apptainerPath, "binary"],
    [cgroupPath, "checker"],
  ]);
  for (const [path, content] of contents) await writeFile(path, content);
  const canonicalRoot = await realpath(root);
  const digest = `sha256:${sha256(contents.get(runtimePath) ?? "")}`;
  const config = loadAgentConfig({
    SERVER_GRPC_URL: "http://localhost:3001",
    AGENT_ID: "agent-test",
    AGENT_SITE_NAME: "site-test",
    AGENT_SANDBOX_ENABLED: "true",
    AGENT_SANDBOX_EXECUTION_MODE: "self-account",
    AGENT_SANDBOX_ROOT: canonicalRoot,
    AGENT_SANDBOX_APPTAINER_PATH: apptainerPath,
    AGENT_SANDBOX_CGROUP_CHECK_PATH: cgroupPath,
    AGENT_SANDBOX_CGROUP_CHECK_SHA256: sha256("checker"),
    AGENT_SANDBOX_ATTESTATION_QUEUE: "compute",
    AGENT_SANDBOX_SIF_PUBLIC_KEY_PATH: publicKeyPath,
    AGENT_SANDBOX_SIF_PUBLIC_KEY_SHA256: sha256(contents.get(publicKeyPath) ?? ""),
    AGENT_SANDBOX_SECCOMP_PROFILE_PATH: seccompPath,
    AGENT_SANDBOX_SECCOMP_PROFILE_SHA256: sha256(contents.get(seccompPath) ?? ""),
    AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_PATH: seccompProbePath,
    AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_SHA256: sha256(contents.get(seccompProbePath) ?? ""),
    AGENT_SANDBOX_ECL_PATH: eclPath,
    AGENT_SANDBOX_ECL_SHA256: sha256(contents.get(eclPath) ?? ""),
    AGENT_SANDBOX_ECL_NEGATIVE_PROBE_SIF_PATH: negativeRuntimePath,
    AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
      [digest]: { kind: "SIF", localPath: runtimePath, signatureVerified: true },
    }),
  });
  const inspectFile = async (path: string) => ({
    canonicalPath: path,
    sha256: sha256(contents.get(path) ?? ""),
    uid: 0,
    mode: path === apptainerPath ? 0o100755 : 0o100444,
    isFile: true,
    isSymbolicLink: false,
  });
  return { config, digest, inspectFile };
}

describe("Sandbox runtime attestation", () => {
  test("probe shells reject missing tools, timeouts, ignored filters and extra network interfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-probe-shell-"));
    roots.push(root);
    const helper = join(root, "tool");
    const runtime = join(root, "runtime");
    const interfaces = join(root, "net-dev");
    await writeFile(
      helper,
      `#!/bin/bash
set -eu
case "$KQ_PROBE_MODE:$1:$KQ_PROBE_CASE" in
  baseline:uname:missing-uname) exit 127 ;;
  baseline:socket:missing-timeout) exit 127 ;;
  production:socket:timeout) echo 'Operation not permitted' >&2; exit 124 ;;
  probe:uname:missing-probe-uname) echo 'Operation not permitted' >&2; exit 127 ;;
  probe:uname:ignored-probe) exit 0 ;;
  production:socket:ignored-production) echo 'Connection refused' >&2; exit 1 ;;
esac
case "$KQ_PROBE_MODE:$1" in
  baseline:uname) echo Linux ;;
  baseline:socket) echo 'Connection refused' >&2; exit 1 ;;
  production:socket|probe:uname) echo 'Operation not permitted' >&2; exit 1 ;;
  *) exit 90 ;;
esac
`,
      { mode: 0o700 },
    );
    await writeFile(
      runtime,
      `#!/usr/bin/python3
import os, sys
os.environ["KQ_PROBE_MODE"] = sys.argv[1]
if sys.argv[1] == "production" and os.environ["KQ_PROBE_CASE"] == "launch-failed":
    sys.exit(126)
command = sys.argv[2:]
if command[0] == "/bin/uname":
    os.execl(${JSON.stringify(helper)}, "tool", "uname")
if command[0] == "/bin/true":
    sys.exit(0)
assert command[:2] == ["/bin/bash", "-c"]
script = command[2].replace("'/usr/bin/timeout'", ${JSON.stringify(`${shellQuote(helper)} socket`)})
script = script.replace("'/bin/uname'", ${JSON.stringify(`${shellQuote(helper)} uname`)})
script = script.replace("/proc/net/dev", ${JSON.stringify(interfaces)})
os.execl("/bin/bash", "bash", "-c", script)
`,
      { mode: 0o700 },
    );
    const script = [
      "set -e",
      ...buildRuntimeIsolationProbeCommands(
        [runtime, "baseline"],
        [runtime, "production"],
        [runtime, "probe"],
      ),
    ].join("\n");
    for (const scenario of [
      "ok",
      "missing-uname",
      "missing-timeout",
      "timeout",
      "missing-probe-uname",
      "ignored-probe",
      "ignored-production",
      "launch-failed",
      "extra-interface",
    ]) {
      await writeFile(
        interfaces,
        `Inter-| Receive\n lo: 0\n${scenario === "extra-interface" ? " eth0: 0\n" : ""}`,
      );
      const child = Bun.spawn(["/bin/bash", "-c", script], {
        env: { ...process.env, KQ_PROBE_CASE: scenario },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ scenario, code: code === 0, stderr }).toEqual({
        scenario,
        code: scenario === "ok",
        stderr: "",
      });
    }
  });

  test("derives readiness only after the signed runtime and Slurm probes succeed", async () => {
    const { config, digest, inspectFile } = await fixture();
    let submittedScript = "";
    const spawner: Spawner = {
      run: async (command, options) => {
        if (command[1] === "verify" || command[1] === "sif") {
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }
        if (command[0] === "squeue") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              jobs: [{ job_id: 42, job_state: "COMPLETED", exit_code: { return_code: 0 } }],
            }),
            stderr: "",
          };
        }
        if (command[0] !== "sbatch") throw new Error(`unexpected command: ${command.join(" ")}`);
        const scriptPath = /\/bin\/bash '([^']+)'/.exec(options?.stdin ?? "")?.[1];
        const outputPath = /^#SBATCH --output=(.+)$/m.exec(options?.stdin ?? "")?.[1];
        if (!scriptPath || !outputPath) throw new Error("incomplete Slurm probe");
        submittedScript = await readFile(scriptPath, "utf8");
        await writeFile(outputPath, "KQ_ATTESTED_NODE=slurm-2\n");
        return { exitCode: 0, stdout: "42\n", stderr: "" };
      },
    };
    const result = await attestSandboxRuntimeEnvironment(config, "slurm", spawner, identity, {
      now: () => 1_000,
      inspectFile,
      validateAncestors: async () => undefined,
    });

    expect(result.missingRequirements).toEqual([]);
    expect(result.runtimeCache[digest]?.attestedNodes).toEqual(["slurm-2"]);
    expect(result.runtimeCache[digest]?.attestedQueue).toBe("compute");
    expect(result.runtimeCache[digest]?.cgroupCheck.path).toBe(
      config.AGENT_SANDBOX_CGROUP_CHECK_PATH,
    );
    expect(result.runtimeCache[digest]?.cgroupCheck.sha256).toBe(
      config.AGENT_SANDBOX_CGROUP_CHECK_SHA256,
    );
    expect(submittedScript).toContain('--job-id "${SLURM_JOB_ID:?');
    expect(submittedScript).toContain("'--cpus' '1' '--memory-mb' '128'");
    expect(submittedScript).not.toContain("grep -Eq '(slurm|job_)'");
    expect(submittedScript.indexOf("--job-id")).toBeLessThan(submittedScript.indexOf("/bin/true"));
    expect(result.runtimeCache[digest]?.runtimeAttestationId).toMatch(/^[0-9a-f]{64}$/);
    expect(submittedScript).toContain("seccomp:");
    expect(submittedScript).toContain("/dev/tcp/127.0.0.1/1");
    expect(submittedScript).toContain("Connection refused");
    expect(submittedScript).toContain("Operation not permitted");
    expect(submittedScript).toContain("/proc/net/dev");
    expect(submittedScript).toContain("exit 41");
    expect(submittedScript).toContain("'no-new-privs'");
    const renewed = await attestSandboxRuntimeEnvironment(config, "slurm", spawner, identity, {
      now: () => 2_000,
      inspectFile,
      validateAncestors: async () => undefined,
    });
    expect(renewed.runtimeCache[digest]?.runtimeAttestationId).toBe(
      result.runtimeCache[digest]?.runtimeAttestationId,
    );
    expect(renewed.runtimeCache[digest]?.expiresAtUnixMs).toBeGreaterThan(
      result.runtimeCache[digest]?.expiresAtUnixMs ?? 0,
    );
    const otherQueue = await attestSandboxRuntimeEnvironment(
      { ...config, AGENT_SANDBOX_ATTESTATION_QUEUE: "other" },
      "slurm",
      spawner,
      identity,
      { now: () => 2_000, inspectFile, validateAncestors: async () => undefined },
    );
    expect(otherQueue.runtimeCache[digest]?.runtimeAttestationId).not.toBe(
      result.runtimeCache[digest]?.runtimeAttestationId,
    );
    const otherProbeHash = "b".repeat(64);
    const otherProbe = await attestSandboxRuntimeEnvironment(
      { ...config, AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_SHA256: otherProbeHash },
      "slurm",
      spawner,
      identity,
      {
        inspectFile: async (path) => ({
          ...(await inspectFile(path)),
          ...(path === config.AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_PATH
            ? { sha256: otherProbeHash }
            : {}),
        }),
        validateAncestors: async () => undefined,
      },
    );
    expect(otherProbe.missingRequirements).toEqual([]);
    expect(otherProbe.runtimeCache[digest]?.runtimeAttestationId).not.toBe(
      result.runtimeCache[digest]?.runtimeAttestationId,
    );
  });

  test("missing checker/queue or a failed native probe cannot publish cgroup readiness", async () => {
    const { config, inspectFile } = await fixture();
    for (const configured of [
      { ...config, AGENT_SANDBOX_CGROUP_CHECK_PATH: undefined },
      { ...config, AGENT_SANDBOX_ATTESTATION_QUEUE: undefined },
      config,
    ]) {
      let probes = 0;
      const result = await attestSandboxRuntimeEnvironment(
        configured,
        "slurm",
        {
          run: async (command) => {
            if (command[0] === "sbatch") probes++;
            return {
              exitCode: command[0] === "sbatch" ? 126 : 0,
              stdout: "",
              stderr: "job memory limit exceeds signed request",
            };
          },
        },
        identity,
        { inspectFile, validateAncestors: async () => undefined },
      );
      expect(result.cgroups).toBe(false);
      expect(result.runtimeCache).toEqual({});
      expect(probes).toBe(configured === config ? 1 : 0);
    }
  });

  test("ignores the configured signatureVerified claim when real verification fails", async () => {
    const { config, inspectFile } = await fixture();
    const result = await attestSandboxRuntimeEnvironment(
      config,
      "slurm",
      {
        run: async (command) => ({
          exitCode: command[1] === "verify" ? 1 : 0,
          stdout: "",
          stderr: "invalid signature",
        }),
      },
      identity,
      { inspectFile, validateAncestors: async () => undefined },
    );

    expect(result.runtimeCache).toEqual({});
    expect(result.missingRequirements).toContain("runtime-attestation-failed");
    expect(result.sifSignatureVerification).toBe(false);
  });
});

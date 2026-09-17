import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Spawner } from "../adapters/base";
import { loadAgentConfig } from "../config";
import { attestSandboxRuntimeEnvironment } from "./runtime-attestation";

const roots: string[] = [];

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
  const runtimePath = join(root, "runtime.sif");
  const negativeRuntimePath = join(root, "unauthorized.sif");
  const seccompPath = join(root, "seccomp.json");
  const seccompProbePath = join(root, "seccomp-probe.json");
  const eclPath = join(root, "ecl.toml");
  const publicKeyPath = join(root, "runtime-public.pem");
  const apptainerPath = join(root, "apptainer");
  const contents = new Map<string, string>([
    [runtimePath, "signed runtime"],
    [negativeRuntimePath, "unsigned runtime"],
    [seccompPath, '{"defaultAction":"SCMP_ACT_ALLOW"}'],
    [seccompProbePath, '{"defaultAction":"SCMP_ACT_ALLOW"}'],
    [eclPath, "activated = true"],
    [publicKeyPath, "public key"],
    [apptainerPath, "binary"],
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
  test("derives readiness only after the signed runtime and Slurm probes succeed", async () => {
    const { config, digest, inspectFile } = await fixture();
    let submittedScript = "";
    const spawner: Spawner = {
      run: async (command) => {
        if (command[1] === "verify" || command[1] === "sif") {
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }
        if (command[0] !== "sbatch") throw new Error(`unexpected command: ${command.join(" ")}`);
        const scriptPath = command.at(-1);
        const outputPath = command.find((part) => part.startsWith("--output="))?.slice(9);
        if (!scriptPath || !outputPath) throw new Error("incomplete Slurm probe");
        submittedScript = await readFile(scriptPath, "utf8");
        await writeFile(outputPath, "KQ_ATTESTED_NODE=slurm-2\n");
        return { exitCode: 0, stdout: "42\n", stderr: "" };
      },
    };
    const identity = {
      username: "kqagent",
      uid: process.getuid?.() ?? 501,
      gid: process.getgid?.() ?? 20,
    };
    const result = await attestSandboxRuntimeEnvironment(config, "slurm", spawner, identity, {
      now: () => 1_000,
      inspectFile,
      validateAncestors: async () => undefined,
    });

    expect(result.missingRequirements).toEqual([]);
    expect(result.runtimeCache[digest]?.attestedNodes).toEqual(["slurm-2"]);
    expect(result.runtimeCache[digest]?.runtimeAttestationId).toMatch(/^[0-9a-f]{64}$/);
    expect(submittedScript).toContain("seccomp:");
    expect(submittedScript).toContain("/dev/tcp/1.1.1.1/53");
    expect(submittedScript).toContain("exit 41");
    expect(submittedScript).toContain("exit 42");
    expect(
      submittedScript
        .split("\n")
        .some(
          (line) =>
            line.startsWith("if ") &&
            line.includes(config.AGENT_SANDBOX_SECCOMP_PROFILE_PATH ?? "") &&
            line.includes("/bin/uname"),
        ),
    ).toBe(true);
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
      {
        username: "kqagent",
        uid: process.getuid?.() ?? 501,
        gid: process.getgid?.() ?? 20,
      },
      { inspectFile, validateAncestors: async () => undefined },
    );

    expect(result.runtimeCache).toEqual({});
    expect(result.missingRequirements).toContain("runtime-attestation-failed");
    expect(result.sifSignatureVerification).toBe(false);
  });
});

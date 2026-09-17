import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJson } from "@kuintessence/shared";
import type { Spawner } from "../adapters/base";
import { shellQuote } from "../adapters/base";
import type { AgentConfig } from "../config";

export interface SandboxProcessIdentity {
  username: string;
  uid: number;
  gid: number;
}

export interface AttestedSandboxRuntime {
  kind: "SIF";
  localPath: string;
  signatureVerified: true;
  runtimeAttestationId: string;
  apptainerPath: string;
  seccompProfilePath: string;
  attestedNodes: string[];
  verifiedAtUnixMs: number;
  expiresAtUnixMs: number;
}

export interface SandboxRuntimeAttestation {
  runtimeCache: Record<string, AttestedSandboxRuntime>;
  networkIsolation: boolean;
  cgroups: boolean;
  seccomp: boolean;
  sifSignatureVerification: boolean;
  ecl: boolean;
  missingRequirements: string[];
}

interface SecureFileFact {
  canonicalPath: string;
  sha256: string;
  uid: number;
  mode: number;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export interface SandboxRuntimeAttestationDeps {
  now?: () => number;
  inspectFile?: (path: string) => Promise<SecureFileFact>;
  validateAncestors?: (path: string) => Promise<void>;
}

export function currentSandboxProcessIdentity(): SandboxProcessIdentity | undefined {
  try {
    const account = userInfo();
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined || account.uid !== uid || account.gid !== gid) {
      return undefined;
    }
    return { username: account.username, uid, gid };
  } catch {
    return undefined;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}

async function inspectSecureFile(path: string): Promise<SecureFileFact> {
  const value = await lstat(path);
  return {
    canonicalPath: await realpath(path),
    sha256: await sha256File(path),
    uid: value.uid,
    mode: value.mode,
    isFile: value.isFile(),
    isSymbolicLink: value.isSymbolicLink(),
  };
}

function assertSecureFile(
  path: string,
  fact: SecureFileFact,
  expectedSha256: string | undefined,
  executable: boolean,
): void {
  if (
    !path.startsWith("/") ||
    fact.canonicalPath !== path ||
    !fact.isFile ||
    fact.isSymbolicLink ||
    fact.uid !== 0 ||
    (fact.mode & 0o022) !== 0 ||
    (executable && (fact.mode & 0o111) === 0)
  ) {
    throw new Error(`Sandbox attestation rejects insecure file ${path}`);
  }
  if (expectedSha256 && fact.sha256 !== expectedSha256) {
    throw new Error(`Sandbox attestation SHA-256 mismatch for ${path}`);
  }
}

async function assertSecureAncestorDirectories(path: string): Promise<void> {
  let current = dirname(path);
  while (current !== "/") {
    const value = await lstat(current);
    if (
      !value.isDirectory() ||
      value.isSymbolicLink() ||
      value.uid !== 0 ||
      (value.mode & 0o022) !== 0
    ) {
      throw new Error(`Sandbox attestation rejects insecure ancestor ${current}`);
    }
    current = dirname(current);
  }
}

function apptainerBaseArgv(
  apptainerPath: string,
  seccompProfilePath: string,
  runtimePath: string,
): string[] {
  return [
    apptainerPath,
    "exec",
    "--containall",
    "--cleanenv",
    "--no-home",
    "--no-eval",
    "--no-mount",
    "hostfs,cwd,home",
    "--net",
    "--network",
    "none",
    "--drop-caps",
    "all",
    "--security",
    `no-new-privs,seccomp:${seccompProfilePath}`,
    "--pwd",
    "/",
    runtimePath,
  ];
}

function shellCommand(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

function sha256Check(path: string, expectedSha256: string): string {
  return `printf '%s  %s\\n' ${shellQuote(expectedSha256)} ${shellQuote(path)} | sha256sum -c -`;
}

async function runSlurmProbe(
  config: AgentConfig,
  spawner: Spawner,
  runtimePath: string,
  negativeRuntimePath: string | undefined,
  seccompProfilePath: string,
  seccompProbeProfilePath: string,
  expectedSha256: {
    apptainer: string;
    runtime: string;
    seccomp: string;
    seccompProbe: string;
  },
): Promise<string[]> {
  const probeRoot = await mkdtemp(join(config.AGENT_SANDBOX_ROOT, ".attest-"));
  const scriptPath = join(probeRoot, "probe.sh");
  const stdoutPath = join(probeRoot, "stdout.log");
  const stderrPath = join(probeRoot, "stderr.log");
  const apptainerPath = config.AGENT_SANDBOX_APPTAINER_PATH;
  const positive = apptainerBaseArgv(apptainerPath, seccompProfilePath, runtimePath);
  const unauthorized = negativeRuntimePath
    ? apptainerBaseArgv(apptainerPath, seccompProfilePath, negativeRuntimePath)
    : undefined;
  const productionSeccompNegative = [...positive, "/bin/uname"];
  const seccompNegative = apptainerBaseArgv(apptainerPath, seccompProbeProfilePath, runtimePath);
  const networkNegative = [
    ...positive,
    "/usr/bin/timeout",
    "3",
    "/bin/bash",
    "-c",
    "exec 3<>/dev/tcp/1.1.1.1/53",
  ];
  const script = [
    "#!/bin/bash",
    "set -euo pipefail",
    sha256Check(apptainerPath, expectedSha256.apptainer),
    sha256Check(runtimePath, expectedSha256.runtime),
    sha256Check(seccompProfilePath, expectedSha256.seccomp),
    sha256Check(seccompProbeProfilePath, expectedSha256.seccompProbe),
    shellCommand([...positive, "/bin/true"]),
    ...(unauthorized
      ? [`if ${shellCommand([...unauthorized, "/bin/true"])}; then exit 41; fi`]
      : []),
    `if ${shellCommand(productionSeccompNegative)}; then exit 42; fi`,
    `if ${shellCommand([...seccompNegative, "/bin/uname"])}; then exit 44; fi`,
    `if ${shellCommand(networkNegative)}; then exit 43; fi`,
    "grep -Eq '(slurm|job_)' /proc/self/cgroup",
    "printf 'KQ_ATTESTED_NODE=%s\\n' \"$(hostname)\"",
  ].join("\n");
  try {
    await writeFile(scriptPath, script, { flag: "wx", mode: 0o700 });
    await chmod(scriptPath, 0o700);
    const command = [
      "sbatch",
      "--wait",
      "--parsable",
      "--job-name=kq-sandbox-attest",
      "--cpus-per-task=1",
      "--mem=128M",
      "--time=00:02:00",
      `--output=${stdoutPath}`,
      `--error=${stderrPath}`,
      ...(config.AGENT_SANDBOX_ATTESTATION_QUEUE
        ? [`--partition=${config.AGENT_SANDBOX_ATTESTATION_QUEUE}`]
        : []),
      scriptPath,
    ];
    const result = await spawner.run(command, { timeoutMs: 150_000 });
    const stdout = await readFile(stdoutPath, "utf8").catch(() => "");
    const stderr = await readFile(stderrPath, "utf8").catch(() => "");
    if (result.exitCode !== 0) {
      throw new Error(
        `Slurm Sandbox attestation failed (${result.exitCode}): ${stderr || result.stderr}`,
      );
    }
    const nodes = stdout
      .split("\n")
      .flatMap((line) => (line.startsWith("KQ_ATTESTED_NODE=") ? [line.slice(17).trim()] : []));
    if (nodes.length === 0 || nodes.some((node) => !/^[A-Za-z0-9._-]{1,255}$/.test(node))) {
      throw new Error("Slurm Sandbox attestation did not report a safe compute node");
    }
    return [...new Set(nodes)].toSorted();
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

export async function attestSandboxRuntimeEnvironment(
  config: AgentConfig,
  adapterType: string,
  spawner: Spawner,
  processIdentity: SandboxProcessIdentity | undefined,
  deps: SandboxRuntimeAttestationDeps = {},
): Promise<SandboxRuntimeAttestation> {
  const runtimeCache: Record<string, AttestedSandboxRuntime> = {};
  const missingRequirements: string[] = [];
  if (
    !config.AGENT_SANDBOX_ENABLED ||
    (config.AGENT_SANDBOX_EXECUTION_MODE === "disabled" && !config.AGENT_SANDBOX_ROOT_IMPERSONATION)
  ) {
    return {
      runtimeCache,
      networkIsolation: false,
      cgroups: false,
      seccomp: false,
      sifSignatureVerification: false,
      ecl: false,
      missingRequirements: ["sandbox-disabled"],
    };
  }
  if (adapterType !== "slurm") {
    return {
      runtimeCache,
      networkIsolation: false,
      cgroups: false,
      seccomp: false,
      sifSignatureVerification: false,
      ecl: false,
      missingRequirements: ["runtime-attestation-adapter-unsupported"],
    };
  }
  if (
    config.AGENT_SANDBOX_EXECUTION_MODE === "self-account" &&
    (!processIdentity || processIdentity.uid <= 0 || processIdentity.gid <= 0)
  ) {
    missingRequirements.push("process-identity");
  }
  const seccompPath = config.AGENT_SANDBOX_SECCOMP_PROFILE_PATH;
  const seccompHash = config.AGENT_SANDBOX_SECCOMP_PROFILE_SHA256;
  const seccompProbePath = config.AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_PATH;
  const seccompProbeHash = config.AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_SHA256;
  const publicKeyPath = config.AGENT_SANDBOX_SIF_PUBLIC_KEY_PATH;
  const publicKeyHash = config.AGENT_SANDBOX_SIF_PUBLIC_KEY_SHA256;
  const eclHash = config.AGENT_SANDBOX_ECL_SHA256;
  const negativeRuntimePath = config.AGENT_SANDBOX_ECL_NEGATIVE_PROBE_SIF_PATH;
  if (!seccompPath || !seccompHash || !seccompProbePath || !seccompProbeHash) {
    missingRequirements.push("seccomp-attestation-profile");
  }
  if (!publicKeyPath || !publicKeyHash) missingRequirements.push("sif-public-key");
  const eclRequired =
    config.AGENT_SANDBOX_EXECUTION_MODE === "root-impersonation" ||
    (config.AGENT_SANDBOX_EXECUTION_MODE === "disabled" && config.AGENT_SANDBOX_ROOT_IMPERSONATION);
  if (eclRequired && (!eclHash || !negativeRuntimePath)) {
    missingRequirements.push("ecl-negative-probe");
  }
  const configuredRuntimes = Object.entries(config.AGENT_SANDBOX_RUNTIME_CACHE_JSON).filter(
    (entry): entry is [string, { kind: "SIF"; localPath: string; signatureVerified: boolean }] =>
      entry[1].kind === "SIF",
  );
  if (configuredRuntimes.length === 0) missingRequirements.push("configured-sif-runtime");
  if (missingRequirements.length > 0) {
    return {
      runtimeCache,
      networkIsolation: false,
      cgroups: false,
      seccomp: false,
      sifSignatureVerification: false,
      ecl: false,
      missingRequirements,
    };
  }
  const inspectFile = deps.inspectFile ?? inspectSecureFile;
  const validateAncestors = deps.validateAncestors ?? assertSecureAncestorDirectories;
  try {
    const managedRoot = await lstat(config.AGENT_SANDBOX_ROOT);
    const expectedRootUid =
      config.AGENT_SANDBOX_EXECUTION_MODE === "self-account" ? processIdentity?.uid : 0;
    if (
      !managedRoot.isDirectory() ||
      managedRoot.isSymbolicLink() ||
      (await realpath(config.AGENT_SANDBOX_ROOT)) !== config.AGENT_SANDBOX_ROOT ||
      managedRoot.uid !== expectedRootUid ||
      (managedRoot.mode & 0o022) !== 0
    ) {
      throw new Error("Sandbox managed root ownership or mode is unsafe");
    }
    const apptainer = await inspectFile(config.AGENT_SANDBOX_APPTAINER_PATH);
    assertSecureFile(config.AGENT_SANDBOX_APPTAINER_PATH, apptainer, undefined, true);
    await validateAncestors(config.AGENT_SANDBOX_APPTAINER_PATH);
    const publicKey = await inspectFile(publicKeyPath as string);
    assertSecureFile(publicKeyPath as string, publicKey, publicKeyHash, false);
    await validateAncestors(publicKeyPath as string);
    const seccomp = await inspectFile(seccompPath as string);
    assertSecureFile(seccompPath as string, seccomp, seccompHash, false);
    await validateAncestors(seccompPath as string);
    JSON.parse(await readFile(seccompPath as string, "utf8"));
    const seccompProbe = await inspectFile(seccompProbePath as string);
    assertSecureFile(seccompProbePath as string, seccompProbe, seccompProbeHash, false);
    await validateAncestors(seccompProbePath as string);
    JSON.parse(await readFile(seccompProbePath as string, "utf8"));
    const ecl = eclHash ? await inspectFile(config.AGENT_SANDBOX_ECL_PATH) : undefined;
    if (ecl) assertSecureFile(config.AGENT_SANDBOX_ECL_PATH, ecl, eclHash, false);
    if (ecl) await validateAncestors(config.AGENT_SANDBOX_ECL_PATH);
    if (negativeRuntimePath) {
      const negativeRuntime = await inspectFile(negativeRuntimePath);
      assertSecureFile(negativeRuntimePath, negativeRuntime, undefined, false);
      await validateAncestors(negativeRuntimePath);
      const negativeInspect = await spawner.run(
        [config.AGENT_SANDBOX_APPTAINER_PATH, "sif", "list", negativeRuntimePath],
        { timeoutMs: 15_000 },
      );
      if (negativeInspect.exitCode !== 0) {
        throw new Error("Sandbox ECL negative probe is not a structurally valid SIF");
      }
    }
    for (const [digest, runtime] of configuredRuntimes) {
      const file = await inspectFile(runtime.localPath);
      assertSecureFile(runtime.localPath, file, digest.slice("sha256:".length), false);
      await validateAncestors(runtime.localPath);
      if ((file.mode & 0o222) !== 0) {
        throw new Error(`Sandbox runtime is writable: ${runtime.localPath}`);
      }
      const verified = await spawner.run(
        [
          config.AGENT_SANDBOX_APPTAINER_PATH,
          "verify",
          "--all",
          "--key",
          publicKeyPath as string,
          runtime.localPath,
        ],
        { timeoutMs: 30_000 },
      );
      if (verified.exitCode !== 0) {
        throw new Error(`Sandbox SIF signature verification failed: ${runtime.localPath}`);
      }
      const attestedNodes = await runSlurmProbe(
        config,
        spawner,
        runtime.localPath,
        negativeRuntimePath,
        seccompPath as string,
        seccompProbePath as string,
        {
          apptainer: apptainer.sha256,
          runtime: file.sha256,
          seccomp: seccomp.sha256,
          seccompProbe: seccompProbe.sha256,
        },
      );
      const verifiedAtUnixMs = (deps.now ?? Date.now)();
      const expiresAtUnixMs = verifiedAtUnixMs + config.AGENT_SANDBOX_ATTESTATION_TTL_SEC * 1_000;
      const runtimeAttestationId = createHash("sha256")
        .update(
          canonicalJson({
            adapterType,
            apptainerSha256: apptainer.sha256,
            attestedNodes,
            digest,
            eclSha256: ecl?.sha256,
            processIdentity,
            publicKeySha256: publicKey.sha256,
            runtimePath: runtime.localPath,
            seccompSha256: seccomp.sha256,
          }),
        )
        .digest("hex");
      runtimeCache[digest] = {
        kind: "SIF",
        localPath: runtime.localPath,
        signatureVerified: true,
        runtimeAttestationId,
        apptainerPath: config.AGENT_SANDBOX_APPTAINER_PATH,
        seccompProfilePath: seccompPath as string,
        attestedNodes,
        verifiedAtUnixMs,
        expiresAtUnixMs,
      };
    }
    return {
      runtimeCache,
      networkIsolation: true,
      cgroups: true,
      seccomp: true,
      sifSignatureVerification: true,
      ecl: eclRequired,
      missingRequirements: [],
    };
  } catch {
    return {
      runtimeCache: {},
      networkIsolation: false,
      cgroups: false,
      seccomp: false,
      sifSignatureVerification: false,
      ecl: false,
      missingRequirements: ["runtime-attestation-failed"],
    };
  }
}

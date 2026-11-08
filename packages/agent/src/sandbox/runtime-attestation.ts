import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, readFile, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import { canonicalJson, createLogger } from "@kuintessence/shared";
import { z } from "zod";
import type { Spawner } from "../adapters/base";
import { shellQuote } from "../adapters/base";
import { PbsProAdapter } from "../adapters/pbs-pro";
import { SlurmAdapter } from "../adapters/slurm";
import { TorqueAdapter } from "../adapters/torque";
import type { AgentConfig } from "../config";
import { buildHpcCgroupCommand, type SandboxCgroupCheck } from "./cgroup-command";
import { runNativeRuntimeProbe } from "./native-runtime-probe";

const logger = createLogger("sandbox-runtime-attestation");

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
  cgroupCheck: SandboxCgroupCheck;
  attestedQueue: string;
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
  seccompProfilePath: string | undefined,
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
    seccompProfilePath ? `no-new-privs,seccomp:${seccompProfilePath}` : "no-new-privs",
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

export function buildRuntimeIsolationProbeCommands(
  unfiltered: string[],
  production: string[],
  seccompProbe: string[],
): string[] {
  const socket = "exec 3<>/dev/tcp/127.0.0.1/1";
  const expectErrno = (command: string[], messages: string[]) =>
    [
      "export LC_ALL=C",
      "rc=0",
      `output=$(${shellCommand(command)} 2>&1) || rc=$?`,
      `[[ $rc == 1 && ( ${messages.map((message) => `$output == *${shellQuote(message)}*`).join(" || ")} ) ]]`,
    ].join("; ");
  const socketCommand = ["/usr/bin/timeout", "3", "/bin/bash", "-c", socket];
  return [
    // The same image must execute the probes before a policy denial can count as evidence.
    shellCommand([...unfiltered, "/bin/uname"]),
    shellCommand([
      ...unfiltered,
      "/bin/bash",
      "-c",
      expectErrno(socketCommand, ["Connection refused", "Network is unreachable"]),
    ]),
    shellCommand([...production, "/bin/true"]),
    shellCommand([
      ...production,
      "/bin/bash",
      "-c",
      expectErrno(socketCommand, ["Operation not permitted"]),
    ]),
    shellCommand([
      ...seccompProbe,
      "/bin/bash",
      "-c",
      expectErrno(["/bin/uname"], ["Operation not permitted"]),
    ]),
    shellCommand([
      ...production,
      "/bin/bash",
      "-c",
      [
        "set -eu",
        "loopback=0",
        "while IFS=: read -r iface counters; do",
        "  [[ -n $counters ]] || continue",
        `  [[ \${iface//[[:space:]]/} == lo ]] || exit 43`,
        "  loopback=$((loopback + 1))",
        "done </proc/net/dev",
        "[[ $loopback == 1 ]]",
      ].join("\n"),
    ]),
  ];
}

export function buildEclRejectionProbeCommand(argv: string[]): string {
  return [
    "rc=0",
    `ecl_error=$(${shellCommand(argv)} 2>&1) || rc=$?`,
    "[[ $rc == 255 && $ecl_error == *'while checking container image with ECL: image signature not valid:'* ]] || exit 41",
  ].join("; ");
}

export function assertPinnedPgpVerification(output: string, fingerprint: string): void {
  const report = z
    .object({
      Signatures: z.number().int().positive(),
      SignerKeys: z
        .array(
          z.object({
            Signer: z.object({
              Partition: z.string(),
              Fingerprint: z.string().regex(/^[a-fA-F0-9]{40}$/),
              // Global trusted keys report false; the CLI's --local prohibits keyserver lookup.
              KeyLocal: z.boolean(),
              KeyCheck: z.literal(true),
              DataCheck: z.literal(true),
            }),
          }),
        )
        .min(1),
    })
    .parse(JSON.parse(output));
  if (
    !report.SignerKeys.some(({ Signer }) => Signer.Partition === "FS") ||
    report.SignerKeys.some(
      ({ Signer }) => Signer.Fingerprint.toLowerCase() !== fingerprint.toLowerCase(),
    )
  ) {
    throw new Error("SIF verification does not match the pinned PGP signer");
  }
}

interface RootProbeAccount extends SandboxProcessIdentity {
  home: string;
}

export async function resolveRootProbeAccount(
  spawner: Spawner,
  username: string,
): Promise<RootProbeAccount> {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(username)) throw new Error("Invalid probe account");
  const result = await spawner.run(["getent", "passwd", username], { timeoutMs: 10_000 });
  const fields = result.stdout.trim().split(":");
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  const home = fields[5];
  if (
    result.exitCode !== 0 ||
    fields.length !== 7 ||
    fields[0] !== username ||
    !/^[0-9]+$/.test(fields[2] ?? "") ||
    !/^[0-9]+$/.test(fields[3] ?? "") ||
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    !Number.isSafeInteger(gid) ||
    gid <= 0 ||
    !home?.startsWith("/") ||
    /[\0\r\n]/.test(home) ||
    home.split("/").includes("..") ||
    result.stdout.trim().includes("\n")
  ) {
    throw new Error("Root Sandbox probe requires a real non-root passwd account");
  }
  return { username, uid, gid, home };
}

async function runHpcProbe(
  config: AgentConfig,
  scheduler: "slurm" | "pbs-pro" | "torque",
  account: RootProbeAccount | undefined,
  spawner: Spawner,
  runtimePath: string,
  negativeRuntimePath: string | undefined,
  seccompProfilePath: string,
  seccompProbeProfilePath: string,
  cgroupCheck: SandboxCgroupCheck,
  expectedSha256: {
    apptainer: string;
    runtime: string;
    seccomp: string;
    seccompProbe: string;
    ecl?: string;
    negativeRuntime?: string;
  },
): Promise<string[]> {
  const apptainerPath = config.AGENT_SANDBOX_APPTAINER_PATH;
  const positive = apptainerBaseArgv(apptainerPath, seccompProfilePath, runtimePath);
  const unfiltered = apptainerBaseArgv(apptainerPath, undefined, runtimePath);
  const unauthorized = negativeRuntimePath
    ? apptainerBaseArgv(apptainerPath, seccompProfilePath, negativeRuntimePath)
    : undefined;
  const seccompNegative = apptainerBaseArgv(apptainerPath, seccompProbeProfilePath, runtimePath);
  const script = [
    "#!/bin/bash",
    "set -euo pipefail",
    `${buildHpcCgroupCommand(cgroupCheck, { cpus: 1, memoryMb: 128 }, scheduler)} >/dev/null`,
    ...(account ? [`[[ $(id -u) == ${account.uid} && $(id -g) == ${account.gid} ]]`] : []),
    sha256Check(apptainerPath, expectedSha256.apptainer),
    sha256Check(runtimePath, expectedSha256.runtime),
    sha256Check(seccompProfilePath, expectedSha256.seccomp),
    sha256Check(seccompProbeProfilePath, expectedSha256.seccompProbe),
    ...(expectedSha256.ecl
      ? [
          `ecl_dir=$(${shellCommand([apptainerPath, "buildcfg"])} | sed -n 's/^APPTAINER_CONFDIR=//p')`,
          `[[ "$ecl_dir/ecl.toml" == ${shellQuote(config.AGENT_SANDBOX_ECL_PATH)} ]]`,
          sha256Check(config.AGENT_SANDBOX_ECL_PATH, expectedSha256.ecl),
        ]
      : []),
    ...(negativeRuntimePath && expectedSha256.negativeRuntime
      ? [sha256Check(negativeRuntimePath, expectedSha256.negativeRuntime)]
      : []),
    ...buildRuntimeIsolationProbeCommands(unfiltered, positive, seccompNegative),
    ...(unauthorized ? [buildEclRejectionProbeCommand([...unauthorized, "/bin/true"])] : []),
    "printf 'KQ_ATTESTED_NODE=%s\\n' \"$(hostname)\"",
  ].join("\n");
  const boundedSpawner: Spawner = {
    run: (command, options) =>
      spawner.run(
        account
          ? [
              "setpriv",
              `--reuid=${account.uid}`,
              `--regid=${account.gid}`,
              "--init-groups",
              "--",
              "env",
              "-i",
              "PATH=/usr/local/bin:/usr/bin:/bin:/opt/pbs/bin",
              `HOME=${account.home}`,
              `USER=${account.username}`,
              `LOGNAME=${account.username}`,
              "LC_ALL=C",
              ...command,
            ]
          : command,
        {
          ...options,
          timeoutMs: Math.min(options?.timeoutMs ?? 10_000, 10_000),
        },
      ),
  };
  return runNativeRuntimeProbe({
    root: config.AGENT_SANDBOX_ROOT,
    queue: config.AGENT_SANDBOX_ATTESTATION_QUEUE as string,
    script,
    ...(account ? { account: { uid: account.uid, gid: account.gid } } : {}),
    adapter: (logDir) => {
      const deps = { spawner: boundedSpawner, logDir };
      if (scheduler === "slurm")
        return new SlurmAdapter("attestation", { ...deps, terminalStatusBackend: "scontrol" });
      return scheduler === "pbs-pro"
        ? new PbsProAdapter("attestation", deps)
        : new TorqueAdapter("attestation", deps);
    },
  });
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
  if (
    (adapterType !== "slurm" && adapterType !== "pbs-pro" && adapterType !== "torque") ||
    (config.AGENT_SANDBOX_EXECUTION_MODE === "self-account" && adapterType !== "slurm")
  ) {
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
  const pgpFingerprint = config.AGENT_SANDBOX_SIF_PGP_FINGERPRINT;
  const eclHash = config.AGENT_SANDBOX_ECL_SHA256;
  const negativeRuntimePath = config.AGENT_SANDBOX_ECL_NEGATIVE_PROBE_SIF_PATH;
  const cgroupPath = config.AGENT_SANDBOX_CGROUP_CHECK_PATH;
  const cgroupHash = config.AGENT_SANDBOX_CGROUP_CHECK_SHA256;
  const attestedQueue = config.AGENT_SANDBOX_ATTESTATION_QUEUE;
  if (!cgroupPath || !cgroupHash) missingRequirements.push("cgroup-checker");
  if (!attestedQueue) missingRequirements.push("runtime-attestation-queue");
  if (!seccompPath || !seccompHash || !seccompProbePath || !seccompProbeHash) {
    missingRequirements.push("seccomp-attestation-profile");
  }
  if (
    (!pgpFingerprint && (!publicKeyPath || !publicKeyHash)) ||
    (pgpFingerprint && (publicKeyPath || publicKeyHash))
  )
    missingRequirements.push("sif-public-key");
  const eclRequired =
    config.AGENT_SANDBOX_EXECUTION_MODE === "root-impersonation" ||
    (config.AGENT_SANDBOX_EXECUTION_MODE === "disabled" && config.AGENT_SANDBOX_ROOT_IMPERSONATION);
  if (eclRequired && (!config.AGENT_SANDBOX_ROOT_IMPERSONATION || processIdentity?.uid !== 0)) {
    missingRequirements.push("root-impersonation-identity");
  }
  if (eclRequired && !config.AGENT_SANDBOX_ATTESTATION_ACCOUNT)
    missingRequirements.push("runtime-attestation-account");
  if (eclRequired && !pgpFingerprint) missingRequirements.push("ecl-pgp-signer");
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
    const probeAccount = eclRequired
      ? await resolveRootProbeAccount(spawner, config.AGENT_SANDBOX_ATTESTATION_ACCOUNT as string)
      : undefined;
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
    if (probeAccount) await chmod(config.AGENT_SANDBOX_ROOT, 0o711);
    const apptainer = await inspectFile(config.AGENT_SANDBOX_APPTAINER_PATH);
    assertSecureFile(config.AGENT_SANDBOX_APPTAINER_PATH, apptainer, undefined, true);
    await validateAncestors(config.AGENT_SANDBOX_APPTAINER_PATH);
    const checker = await inspectFile(cgroupPath as string);
    assertSecureFile(cgroupPath as string, checker, cgroupHash, false);
    await validateAncestors(cgroupPath as string);
    const cgroupCheck = { path: cgroupPath as string, sha256: checker.sha256 };
    const publicKey = publicKeyPath ? await inspectFile(publicKeyPath) : undefined;
    if (publicKey && publicKeyPath) {
      assertSecureFile(publicKeyPath, publicKey, publicKeyHash, false);
      await validateAncestors(publicKeyPath);
    }
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
    let negativeRuntimeSha256: string | undefined;
    if (negativeRuntimePath) {
      const negativeRuntime = await inspectFile(negativeRuntimePath);
      assertSecureFile(negativeRuntimePath, negativeRuntime, undefined, false);
      await validateAncestors(negativeRuntimePath);
      negativeRuntimeSha256 = negativeRuntime.sha256;
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
          ...(pgpFingerprint ? ["--local", "--json"] : ["--key", publicKeyPath as string]),
          runtime.localPath,
        ],
        { timeoutMs: 30_000 },
      );
      if (verified.exitCode !== 0) {
        throw new Error(`Sandbox SIF signature verification failed: ${runtime.localPath}`);
      }
      if (pgpFingerprint) assertPinnedPgpVerification(verified.stdout, pgpFingerprint);
      const attestedNodes = await runHpcProbe(
        config,
        adapterType,
        probeAccount,
        spawner,
        runtime.localPath,
        negativeRuntimePath,
        seccompPath as string,
        seccompProbePath as string,
        cgroupCheck,
        {
          apptainer: apptainer.sha256,
          runtime: file.sha256,
          seccomp: seccomp.sha256,
          seccompProbe: seccompProbe.sha256,
          ecl: ecl?.sha256,
          negativeRuntime: negativeRuntimeSha256,
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
            attestedQueue,
            cgroupCheck,
            digest,
            eclSha256: ecl?.sha256,
            processIdentity,
            probeAccount,
            negativeRuntimeSha256,
            publicKeySha256: publicKey?.sha256,
            pgpFingerprint,
            runtimePath: runtime.localPath,
            seccompSha256: seccomp.sha256,
            seccompProbeSha256: seccompProbe.sha256,
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
        cgroupCheck,
        attestedQueue: attestedQueue as string,
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
  } catch (error) {
    logger.warn({ err: error }, "Sandbox runtime attestation failed");
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

import { EnvironmentNameSchema } from "../schemas/job";
import type { SiteRuntime } from "../software-governance";
import type { MaterializedTask } from "./materialize";

/**
 * Wrap a MaterializedTask into the facility-activated shell command
 * string the current agent `JobSpec.command` expects.
 *
 * argv values are shell-quoted (user input → injection-safe); the facility
 * prefix (Spack spec / Apptainer image) is platform-controlled. Each token is
 * still shell-quoted; safe Spack sigils like `+mpi`/`%gcc` pass unchanged.
 */
const SAFE = /^[A-Za-z0-9_\-./=:+%@]+$/;

function shellQuote(token: string): string {
  if (token.length > 0 && SAFE.test(token)) {
    return token;
  }
  return `'${token.replaceAll("'", "'\\''")}'`;
}

export function assertSiteRuntimeMatches(
  facility: MaterializedTask["facility"],
  executable: string,
  runtime: SiteRuntime,
): void {
  if (
    facility.kind === "Bare" &&
    runtime.kind === "Bare" &&
    (executable === runtime.path || executable === runtime.path.split("/").at(-1))
  )
    return;
  if (
    facility.kind === "Singularity" &&
    runtime.kind === "Singularity" &&
    facility.image === runtime.image &&
    facility.tag === runtime.tag
  )
    return;
  throw new Error("Usecase executable or image differs from its frozen site runtime");
}

export function wrapSiteRuntime(task: MaterializedTask, runtime: SiteRuntime) {
  assertSiteRuntimeMatches(task.facility, task.argv[0] ?? "", runtime);
  const path = shellQuote(runtime.path);
  const container = runtime.kind === "Singularity";
  const argv = container
    ? ["/usr/bin/apptainer", "exec", "--cleanenv", "--no-eval", runtime.path, ...task.argv]
    : [runtime.path, ...task.argv.slice(1)];
  // Keep application environment values out of the digest check and the host container launcher.
  const envVars: Record<string, string> = {};
  const assignments: string[] = [];
  const unset: string[] = [];
  for (const [key, value] of Object.entries(task.envVars)) {
    EnvironmentNameSchema.parse(key);
    const variable = `KQ_SITE_ENV_${key}`;
    envVars[variable] = value;
    unset.push("-u", variable);
    assignments.push(`${container ? "APPTAINERENV_" : ""}${key}="$${variable}"`);
  }
  const launch = ["/usr/bin/env", ...unset, "--", ...assignments, ...argv.map(shellQuote)].join(
    " ",
  );
  // Each signed path names an immutable, site-owned file on the compute node.
  const command = [
    `if [ ! -f ${path} ] || ! kq_site_hash=$(/usr/bin/sha256sum < ${path}) || [ "$kq_site_hash" != '${runtime.sha256}  -' ]; then`,
    "  echo 'Site runtime file is unavailable or has a different SHA-256' >&2",
    "  exit 1",
    "fi",
    launch,
  ].join("\n");
  return { command, envVars };
}

export function wrapCommand(task: MaterializedTask): string {
  const command = task.argv.map(shellQuote).join(" ");
  if (task.facility.kind === "Spack") {
    const spec = [task.facility.name, ...task.facility.argumentList].map(shellQuote).join(" ");
    return `eval "$(spack load --sh ${spec})" && ${command}`;
  }
  if (task.facility.kind === "Singularity") {
    return `apptainer exec ${shellQuote(`${task.facility.image}:${task.facility.tag}`)} ${command}`;
  }
  // Bare: run a binary already present on the cluster (no env activation).
  return command;
}

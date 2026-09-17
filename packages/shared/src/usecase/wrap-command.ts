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

export function wrapCommand(task: MaterializedTask): string {
  const command = task.argv.map(shellQuote).join(" ");
  if (task.facility.kind === "Spack") {
    const spec = [task.facility.name, ...task.facility.argumentList].map(shellQuote).join(" ");
    return `eval "$(spack load --sh ${spec})" && ${command}`;
  }
  if (task.facility.kind === "Singularity") {
    return `apptainer exec ${task.facility.image}:${task.facility.tag} ${command}`;
  }
  // Bare: run a binary already present on the cluster (no env activation).
  return command;
}

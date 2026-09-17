import { realSpawner, type Spawner } from "./base";

/**
 * Minimal raw runner type: accepts a fully-formed argv and returns the
 * process result. The `cwd` semantic is handled at the call-site (via
 * `docker exec -w`) so the runner itself needs no options.
 */
export type RawRun = (
  cmd: string[],
  options?: { timeoutMs?: number; stdin?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Default raw runner for host-side `docker exec`. No `cwd` option is accepted
 * here; callers that need
 * an in-container working directory must embed `-w <path>` in the argv.
 */
const defaultRun: RawRun = (cmd, options) => realSpawner.run(cmd, options);

/**
 * Spawner that prefixes every command with `docker exec <containerId>`,
 * forwarding scheduler CLI calls into a running container.
 *
 * When `options.cwd` is provided the in-container working directory is set
 * via `docker exec -w <cwd>` — NOT via the host-side process cwd — so that
 * the directory change takes effect inside the container as callers expect.
 *
 * Used when the agent runs on a host that does not natively have the
 * scheduler installed (e.g. tests, dev sandboxes). Production agents on
 * HPC login nodes use the default host-side `realSpawner` instead.
 */
export class ContainerSpawner implements Spawner {
  constructor(
    private readonly containerId: string,
    private readonly raw: RawRun = defaultRun,
  ) {}

  async run(cmd: string[], options?: { cwd?: string; timeoutMs?: number; stdin?: string }) {
    const dockerOptions = [
      ...(options?.stdin !== undefined ? ["-i"] : []),
      ...(options?.cwd !== undefined ? ["-w", options.cwd] : []),
    ];
    const argv = ["docker", "exec", ...dockerOptions, this.containerId, ...cmd];
    return this.raw(argv, { timeoutMs: options?.timeoutMs, stdin: options?.stdin });
  }
}

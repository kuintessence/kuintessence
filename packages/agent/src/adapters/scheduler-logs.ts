import { JobLogUnavailableError, type Spawner } from "./base";

/** Diagnostic reads include stderr; usecase output extraction keeps its stdout-only path. */
export async function readSchedulerLogs(
  spawner: Spawner,
  lines: number,
  stdoutPaths: Array<string | undefined>,
  stderrPaths: Array<string | undefined>,
): Promise<string> {
  const read = async (paths: Array<string | undefined>) => {
    for (const path of new Set(paths)) {
      if (!path) continue;
      const result = await spawner.run(["tail", "-n", String(lines), path]);
      if (result.exitCode === 0) return { path, text: result.stdout };
      if (!/no such file(?: or directory)?/i.test(result.stderr)) {
        throw new Error(`tail job log failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
      }
    }
    return undefined;
  };
  const stdout = await read(stdoutPaths);
  // Schedulers may join stdout and stderr into one file.
  const stderr =
    stderrPaths[0] && stderrPaths[0] === stdout?.path ? undefined : await read(stderrPaths);
  if (!stdout && !stderr) throw new JobLogUnavailableError();
  return (stdout?.text ?? "") + (stderr?.text ? `\n[stderr]\n${stderr.text}` : "");
}

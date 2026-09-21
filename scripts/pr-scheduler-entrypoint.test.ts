import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const wrapper = await readFile(join(root, "deploy/pr-test/scheduler-entrypoint.sh"), "utf8");
const temporary: string[] = [];
const marker =
  /^ci-pbs-entrypoint:event=(ERR|EXIT) line=[0-9]{1,5} exit=([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/;

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(body: string) {
  const directory = await mkdtemp(join(tmpdir(), "kq-pr-entrypoint-test-"));
  temporary.push(directory);
  const entrypoint = join(directory, "entrypoint.sh");
  const instrumented = join(directory, "wrapper.sh");
  await writeFile(entrypoint, `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o700 });
  // Replace only the two fixed executable paths; never add a runtime path override.
  await writeFile(
    instrumented,
    wrapper
      .replaceAll("/usr/local/bin/kq-pbs-entrypoint", entrypoint)
      .replaceAll("/usr/local/bin/kq-slurm-entrypoint", entrypoint),
  );
  return { entrypoint, instrumented };
}

async function execute(path: string, scheduler = "pbs", args: string[] = []) {
  const child = Bun.spawn({
    cmd: ["/bin/bash", path, ...args],
    env: {
      PATH: "/usr/bin:/bin",
      KQ_PR_SCHEDULER: scheduler,
      KQ_PR_TEST: "1",
      PR_PRIVATE_FIXTURE: "fixture-private-registration-token",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr, signal: child.signalCode };
  } finally {
    clearTimeout(timer);
  }
}

describe("PR scheduler entrypoint (shell fixtures, no containers)", () => {
  test("only the base PR image adopts the wrapper and keeps tini", async () => {
    const dockerfile = await readFile(join(root, "deploy/pr-test/scheduler.Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      'ENTRYPOINT ["tini", "--", "/bin/bash", "/usr/local/bin/kq-pr-scheduler-entrypoint"]',
    );
    expect(wrapper).toContain('exec /usr/local/bin/kq-slurm-entrypoint "$@"');
    expect(wrapper).toContain('source /usr/local/bin/kq-pbs-entrypoint "$@"');
    expect(wrapper).not.toMatch(/\b(DEBUG|BASH_COMMAND|BASH_ENV)\b|set -[^\n]*[ExT]|export -f/);
    for (const path of [
      "deploy/pr-test/spack-case/scheduler.Dockerfile",
      "deploy/pr-test/spack-managed/runtime.Dockerfile",
    ]) {
      expect(await readFile(join(root, path), "utf8")).not.toContain("kq-pr-scheduler-entrypoint");
    }
  });

  test.each([
    ["simple failure", 'false\nprintf "%s" "$PR_PRIVATE_FIXTURE"', 1, true],
    ["pipeline failure", 'bash -c "exit 19" | cat\nprintf "%s" "$PR_PRIVATE_FIXTURE"', 19, true],
    ["explicit exit", "exit 23", 23, false],
    ["background wait", 'bash -c "exit 29" &\nwait "$!"\nprintf "%s" "$PR_PRIVATE_FIXTURE"', 29, true],
    [
      "command substitution",
      'value="$(bash -c "exit 37")"\nprintf "%s" "$PR_PRIVATE_FIXTURE"',
      37,
      true,
    ],
    ["handled failure", "if false; then exit 99; fi\nfalse || :", 0, false],
    ["success", ":", 0, false],
    [
      "registration child isolation",
      `bash -c 'test -z "$(trap -p ERR EXIT)" && test -z "$(declare -F kq_pr_pbs_marker)" || exit 98; exit 31' "$PR_PRIVATE_FIXTURE"`,
      31,
      true,
    ],
  ] as const)("preserves exit and marker bounds: %s", async (_name, body, code, err) => {
    const paths = await fixture(body);
    const direct = await execute(paths.entrypoint);
    const wrapped = await execute(paths.instrumented);
    expect(direct.code).toBe(code);
    expect(wrapped.code).toBe(direct.code);
    expect(wrapped.signal).toBe(direct.signal);
    expect(direct.stdout).toBe("");
    expect(direct.stderr).toBe("");
    expect(wrapped.stdout).toBe("");
    const lines = wrapped.stderr.trim().split("\n");
    expect(lines).toHaveLength(err ? 2 : 1);
    for (const line of lines) expect(line).toMatch(marker);
    expect(lines.filter((line) => line.includes("event=ERR"))).toHaveLength(err ? 1 : 0);
    expect(lines.at(-1)).toMatch(new RegExp(`event=EXIT line=[0-9]{1,5} exit=${code}$`));
    expect(`${wrapped.stdout}${wrapped.stderr}`).not.toContain("fixture-private");
  });

  test("ERR reports the source line without echoing the failing command or arguments", async () => {
    const paths = await fixture(':\nbash -c "exit 17" "$PR_PRIVATE_FIXTURE"');
    const result = await execute(paths.instrumented);
    expect(result.code).toBe(17);
    expect(result.stderr.split("\n")[0]).toBe("ci-pbs-entrypoint:event=ERR line=4 exit=17");
    expect(result.stderr).not.toContain("fixture-private");
    expect(result.stderr).not.toContain("bash -c");
  });

  test("Slurm exec preserves arguments and has no PBS hooks", async () => {
    const paths = await fixture(
      'test "$1" = expected\ntest -z "$(trap -p ERR EXIT)"\ntest -z "$(declare -F kq_pr_pbs_marker)"\nexit 41',
    );
    const result = await execute(paths.instrumented, "slurm", ["expected"]);
    expect(result.code).toBe(41);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("PBS keeps the direct shell SIGTERM result without installing signal traps", async () => {
    const paths = await fixture('kill -TERM "$$"\nprintf "%s" "$PR_PRIVATE_FIXTURE"');
    const direct = await execute(paths.entrypoint);
    const wrapped = await execute(paths.instrumented);
    expect(direct.code).not.toBe(0);
    expect(wrapped.code).toBe(direct.code);
    expect(wrapped.signal).toBe(direct.signal);
    expect(wrapped.stdout).toBe("");
    for (const line of wrapped.stderr.trim().split("\n").filter(Boolean)) {
      expect(line).toMatch(marker);
    }
  });
});

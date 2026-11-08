import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test.each([
  { directory: "../../scripts/", pattern: "test_sandbox_cgroup_check.py" },
  { directory: "../../../../deploy/schedulers/pbs/", pattern: "test_kq_cgroup_v2.py" },
])("Sandbox cgroup boundary fixtures: $pattern", async ({ directory, pattern }) => {
  const child = Bun.spawn({
    cmd: ["python3", "-I", "-B", "-m", "unittest", "discover", "-s", ".", "-p", pattern, "-v"],
    cwd: fileURLToPath(new URL(directory, import.meta.url)),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toMatchObject({
    exitCode: 0,
    stdout: "",
    stderr: expect.stringContaining("OK"),
  });
}, 30_000);

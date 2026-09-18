import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("source audit worker passes offline Python unittest fixtures", async () => {
  const child = Bun.spawn({
    cmd: [
      "python3",
      "-I",
      "-B",
      "-m",
      "unittest",
      "discover",
      "-s",
      ".",
      "-p",
      "test_source_audit.py",
      "-v",
    ],
    cwd: fileURLToPath(new URL("./worker/", import.meta.url)),
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

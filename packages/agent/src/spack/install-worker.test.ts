import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { SpackInstallReportSchema } from "./install-contract";

test("install worker passes offline mocked Python unittest fixtures", async () => {
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
      "test_install_worker.py",
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

test("mocked native worker reports match the TypeScript install contract for every action", async () => {
  const child = Bun.spawn({
    cmd: [
      "python3",
      "-I",
      "-B",
      "-c",
      [
        "import json, sys",
        "sys.path.insert(0, '.')",
        "from test_install_worker import InstallTests",
        "reports = []",
        "for action in ('install', 'verify', 'load'):",
        "    fixture = InstallTests()",
        "    try:",
        "        fixture.setUp()",
        "        reports.append(fixture.run_worker(action))",
        "    finally:",
        "        fixture.doCleanups()",
        "print(json.dumps(reports))",
      ].join("\n"),
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
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const reports = SpackInstallReportSchema.array().parse(JSON.parse(stdout));
  expect(reports.map((report) => report.action)).toEqual(["install", "verify", "load"]);
  for (const report of reports) {
    expect(report.root.spec).toBe("hello@1.0");
    expect(report.prefix.startsWith(`${report.storePath}/`)).toBe(true);
  }
}, 30_000);

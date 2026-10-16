import { expect, test } from "bun:test";
import { JobLogUnavailableError, type Spawner } from "./base";
import { readSchedulerLogs } from "./scheduler-logs";

function files(contents: Record<string, string>): Spawner {
  return {
    async run(command) {
      const path = command.at(-1) ?? "";
      return path in contents
        ? { exitCode: 0, stdout: contents[path] ?? "", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "No such file or directory" };
    },
  };
}

test("diagnostics include stderr even when stdout is missing", async () => {
  expect(await readSchedulerLogs(files({ err: "failure" }), 10, ["out"], ["err"])).toBe(
    "\n[stderr]\nfailure",
  );
});

test("missing stderr does not hide stdout; empty files remain available", async () => {
  expect(await readSchedulerLogs(files({ out: "value=2" }), 10, ["out"], ["err"])).toBe("value=2");
  expect(await readSchedulerLogs(files({ out: "" }), 10, ["out"], ["err"])).toBe("");
});

test("falls back to retained paths and does not duplicate joined streams", async () => {
  expect(
    await readSchedulerLogs(files({ retained: "output" }), 10, ["gone", "retained"], ["retained"]),
  ).toBe("output");
});

test("missing streams and permission errors remain distinct", async () => {
  await expect(readSchedulerLogs(files({}), 10, ["out"], ["err"])).rejects.toBeInstanceOf(
    JobLogUnavailableError,
  );
  const denied: Spawner = {
    async run() {
      return { exitCode: 1, stdout: "", stderr: "Permission denied" };
    },
  };
  await expect(readSchedulerLogs(denied, 10, ["out"], ["err"])).rejects.toThrow(
    "Permission denied",
  );
});

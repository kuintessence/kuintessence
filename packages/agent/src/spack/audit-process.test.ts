import { afterEach, describe, expect, test } from "bun:test";
import { ChildProcess, type ChildProcessByStdio, spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import {
  createSpackAuditProcess,
  realSpackAuditProcess,
  type SpackAuditProcess,
} from "./audit-process";

type Options = Parameters<SpackAuditProcess["run"]>[1];
const executable = Bun.which("node") ?? process.execPath;
const defaults: Options = {
  cwd: process.cwd(),
  env: {},
  timeoutMs: 2_000,
  maxOutputBytes: 4_096,
};
const children: ChildProcess[] = [];
const descendants: number[] = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function kill(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid) kill(-child.pid);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
  for (const pid of descendants.splice(0)) kill(pid);
});

function fixture(
  overrides: Parameters<typeof createSpackAuditProcess>[0] = {},
  onOutput?: () => void,
) {
  let output = "";
  let environment: NodeJS.ProcessEnv | undefined;
  const runner = createSpackAuditProcess({
    spawnProcess(command, args, options) {
      environment = options.env;
      const child = spawn(command, args, options);
      children.push(child);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        onOutput?.();
      });
      return child;
    },
    ...overrides,
  });
  return {
    run: (source: string, options: Partial<Options> = {}) =>
      runner.run([executable, "-e", source], { ...defaults, ...options }),
    output: () => output,
    environment: () => environment,
  };
}

async function expectStopped(pid: number) {
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  descendants.push(pid);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
      // An orphaned zombie is stopped; only the outer PID namespace can reap it.
      if (process.platform === "linux") {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ESRCH" || error.code === "ENOENT")
      ) {
        return;
      }
      throw error;
    }
    await delay(10);
  }
  throw new Error("Fixture process survived cleanup");
}

function descendantSource(inheritPipes: boolean, exitParent: boolean) {
  return `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], {
      env: {},
      stdio: ${JSON.stringify(inheritPipes ? ["ignore", "inherit", "inherit"] : "ignore")}
    });
    require("node:fs").writeSync(1, String(child.pid));
    ${exitParent ? "process.exit(0);" : "setTimeout(() => {}, 3000);"}
  `;
}

describe("Spack audit process transport (caller supplies isolation)", () => {
  test("returns separate output, cwd, literal argv and nonzero status without a shell", async () => {
    const result = await realSpackAuditProcess.run(
      [
        executable,
        "-e",
        'process.stdout.write(process.cwd() + "\\n" + process.argv[1]); process.stderr.write("err"); process.exitCode = 7;',
        "$(echo should-not-run); *",
      ],
      defaults,
    );
    expect(result).toEqual({
      exitCode: 7,
      stdout: `${defaults.cwd}\n$(echo should-not-run); *`,
      stderr: "err",
    });
  });

  test("supplies exact env without inherited secrets or inherited object properties", async () => {
    const key = "KQ_AUDIT_TEST_PARENT_SECRET";
    const previous = process.env[key];
    process.env[key] = "parent-only-secret";
    try {
      const env: Record<string, string> = { ONLY: "explicit-value" };
      Object.setPrototypeOf(env, { INHERITED: "must-not-pass" });
      const f = fixture();
      const result = await f.run("process.stdout.write(JSON.stringify(process.env))", {
        env,
      });
      expect(f.environment()).toEqual({ ONLY: "explicit-value" });
      const observed = JSON.parse(result.stdout);
      // macOS runtime startup synthesizes this key even with an explicit env.
      if (process.platform === "darwin") delete observed.__CF_USER_TEXT_ENCODING;
      expect(observed).toEqual({ ONLY: "explicit-value" });
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  test("provides stdin EOF", async () => {
    const result = await fixture().run(
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("eof"));',
    );
    expect(result.stdout).toBe("eof");
  });

  test("accepts the exact combined byte limit and preserves output order across writes", async () => {
    const result = await fixture().run(
      `const fs = require("node:fs");
       for (let i = 0; i < 50; i++) { fs.writeSync(1, "ab"); fs.writeSync(2, "cd"); }`,
      { maxOutputBytes: 200 },
    );
    expect(result).toEqual({ exitCode: 0, stdout: "ab".repeat(50), stderr: "cd".repeat(50) });
  });

  test.each([
    'require("node:fs").writeSync(1, "123456"); require("node:fs").writeSync(2, "78901");',
    "process.stdout.write(Buffer.alloc(1024 * 1024)); setTimeout(() => {}, 3000);",
    "process.stderr.write(Buffer.alloc(1024 * 1024)); setTimeout(() => {}, 3000);",
    'process.stdout.write("\\u20ac".repeat(4));',
  ])("rejects output overflow without returning partial success: %s", async (source) => {
    await expect(fixture().run(source, { maxOutputBytes: 10 })).rejects.toThrow("output limit");
  });

  test("decodes UTF-8 only after complete capture, including split codepoints and BOM", async () => {
    const result = await fixture().run(`
      const fs = require("node:fs");
      for (const value of [0xef, 0xbb, 0xbf, 0xe2, 0x82, 0xac]) {
        fs.writeSync(1, Buffer.from([value]));
        fs.writeSync(2, Buffer.from([value]));
      }
    `);
    expect(result.stdout).toBe("\uFEFF\u20ac");
    expect(result.stderr).toBe("\uFEFF\u20ac");
  });

  test.each([1, 2])("rejects invalid UTF-8 on fd %s", async (fd) => {
    await expect(
      fixture().run(`require("node:fs").writeSync(${fd}, Buffer.from([0xc3]));`),
    ).rejects.toThrow("UTF-8");
  });

  test("times out a hanging process and kills it", async () => {
    const f = fixture();
    const start = performance.now();
    await expect(
      f.run("process.stdout.write(String(process.pid)); setTimeout(() => {}, 3000);", {
        timeoutMs: 300,
      }),
    ).rejects.toThrow("timed out");
    expect(performance.now() - start).toBeLessThan(1_500);
    await expectStopped(Number(f.output()));
  });

  test("aborts a running process without exposing the abort reason", async () => {
    const controller = new AbortController();
    const f = fixture({}, () => controller.abort(new Error("secret-abort-reason")));
    const result = f.run("process.stdout.write(String(process.pid)); setTimeout(() => {}, 3000);", {
      signal: controller.signal,
    });
    await expect(result).rejects.toThrow(/^Spack audit process aborted$/);
    await expectStopped(Number(f.output()));
  });

  test("rejects pre-aborted signals without spawning", async () => {
    const runner = createSpackAuditProcess({
      spawnProcess: () => {
        throw new Error("must not spawn");
      },
    });
    await expect(
      runner.run([executable], { ...defaults, signal: AbortSignal.abort("secret") }),
    ).rejects.toThrow(/^Spack audit process aborted$/);
  });

  test.each([
    true,
    false,
  ])("cleans descendants after clean parent exit (pipes=%s)", async (pipes) => {
    const f = fixture();
    const start = performance.now();
    await expect(f.run(descendantSource(pipes, true), { timeoutMs: 700 })).rejects.toThrow(
      "descendants",
    );
    expect(performance.now() - start).toBeLessThan(1_500);
    await expectStopped(Number(f.output()));
  });

  test("kills the whole group on timeout, including inherited descendant pipes", async () => {
    const f = fixture();
    await expect(f.run(descendantSource(true, false), { timeoutMs: 300 })).rejects.toThrow(
      "timed out",
    );
    await expectStopped(Number(f.output()));
  });

  test("kills inherited descendant pipes on abort", async () => {
    const controller = new AbortController();
    const f = fixture({}, () => controller.abort());
    await expect(
      f.run(descendantSource(true, false), { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    await expectStopped(Number(f.output()));
  });

  test("rejects signal termination instead of turning null status into success", async () => {
    await expect(fixture().run('process.kill(process.pid, "SIGKILL");')).rejects.toThrow(
      "terminated",
    );
  });

  test("sanitizes asynchronous spawn failures", async () => {
    await expect(
      realSpackAuditProcess.run(["/nonexistent/secret-command"], {
        ...defaults,
        env: { SECRET: "secret-value" },
      }),
    ).rejects.toThrow(/^Spack audit process spawn failed$/);
  });

  test("sanitizes synchronous spawn failures", async () => {
    const runner = createSpackAuditProcess({
      spawnProcess: () => {
        throw new Error("secret-command secret-value");
      },
    });
    await expect(runner.run([executable], defaults)).rejects.toThrow(
      /^Spack audit process spawn failed$/,
    );
  });

  test.each(["win32", "freebsd"] as const)("fails closed on %s", async (platform) => {
    const runner = createSpackAuditProcess({ platform });
    await expect(runner.run([executable], defaults)).rejects.toThrow("platform not supported");
  });

  test.each([
    { cwd: "" },
    { cwd: "." },
    { cwd: "/bad\0path" },
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 1.5 },
    { timeoutMs: Number.NaN },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { timeoutMs: 30 * 60 * 1_000 + 1 },
    { maxOutputBytes: 0 },
    { maxOutputBytes: -1 },
    { maxOutputBytes: 1.5 },
    { maxOutputBytes: Number.NaN },
    { maxOutputBytes: 4 * 1024 * 1024 + 1 },
    { env: { BAD: undefined } },
    { env: { "BAD=KEY": "secret-value" } },
    { env: { "": "secret-value" } },
    { env: { BAD: "secret\0value" } },
    { env: null },
    { env: [] },
  ])("rejects invalid options without exposing them: %j", async (invalid) => {
    const options = { ...defaults, ...invalid } as Options;
    await expect(realSpackAuditProcess.run([executable], options)).rejects.toThrow(
      /^Invalid Spack audit process options$/,
    );
  });

  test.each(
    [[], [""], ["node"], ["/bin/\0node"], [executable, "\0"]].map((command) => ({ command })),
  )("rejects invalid command: %j", async ({ command }) => {
    await expect(realSpackAuditProcess.run(command, defaults)).rejects.toThrow(
      /^Invalid Spack audit process options$/,
    );
  });

  test("accepts maximum timeout and output bounds without waiting for them", async () => {
    expect(
      await fixture().run("", { timeoutMs: 30 * 60 * 1_000, maxOutputBytes: 4 * 1024 * 1024 }),
    ).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });
});

function simulatedChild() {
  const child = Object.defineProperties(new ChildProcess(), {
    stdout: { value: new PassThrough() },
    stderr: { value: new PassThrough() },
    stdin: { value: null },
    pid: { value: 123_456_789 },
  }) as ChildProcessByStdio<null, PassThrough, PassThrough>;
  const runner = (overrides: Parameters<typeof createSpackAuditProcess>[0] = {}) =>
    createSpackAuditProcess({
      spawnProcess: () => child,
      killProcess: () => true,
      ...overrides,
    });
  return { child, runner };
}

describe("Spack audit process bounded cleanup", () => {
  test("preserves distinct stderr chunks and split UTF-8 in the shared buffer", async () => {
    const { child, runner } = simulatedChild();
    const result = runner({
      killProcess: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    }).run([executable], { ...defaults, maxOutputBytes: 8 });
    child.stderr.emit("data", Buffer.from([0xe2]));
    child.stdout.emit("data", Buffer.from("abc"));
    child.stderr.emit("data", Buffer.from([0x82, 0xac]));
    child.stderr.emit("data", Buffer.from("xy"));
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    expect(await result).toEqual({ exitCode: 0, stdout: "abc", stderr: "\u20acxy" });
  });

  test("handles abort during spawn before the listener is installed", async () => {
    const { child, runner } = simulatedChild();
    const controller = new AbortController();
    const result = runner({
      spawnProcess: () => {
        controller.abort("secret");
        return child;
      },
    }).run([executable], { ...defaults, signal: controller.signal });
    child.emit("close", 0, null);
    await expect(result).rejects.toThrow("aborted");
  });

  test("rejects close past the deadline even before the timer callback runs", async () => {
    const { child, runner } = simulatedChild();
    const result = runner().run([executable], { ...defaults, timeoutMs: 1 });
    const start = performance.now();
    while (performance.now() - start < 5) {
      // Deliberately keep the timer queued until after the close event.
    }
    child.emit("close", 0, null);
    await expect(result).rejects.toThrow("timed out");
  });

  test("does not return success for null status without a signal", async () => {
    const { child, runner } = simulatedChild();
    const result = runner().run([executable], defaults);
    child.emit("close", null, null);
    await expect(result).rejects.toThrow("terminated");
  });

  test("bounds close grace and removes stream, child and abort listeners", async () => {
    const { child, runner } = simulatedChild();
    const controller = new AbortController();
    const start = performance.now();
    await expect(
      runner().run([executable], { ...defaults, timeoutMs: 20, signal: controller.signal }),
    ).rejects.toThrow("timed out");
    expect(performance.now() - start).toBeLessThan(1_000);
    for (const name of ["error", "exit", "close"]) expect(child.listenerCount(name)).toBe(0);
    for (const stream of [child.stdout, child.stderr]) {
      expect(stream?.listenerCount("data")).toBe(0);
      expect(stream?.listenerCount("error")).toBe(0);
      expect(stream?.destroyed).toBe(true);
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
  });

  test("does not stop the deadline at exit when close never arrives", async () => {
    const { child, runner } = simulatedChild();
    const result = runner({
      killProcess: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    }).run([executable], { ...defaults, timeoutMs: 20 });
    child.emit("exit", 0, null);
    await expect(result).rejects.toThrow("timed out");
  });

  test.each(["throw", "false"] as const)("reports group kill failure (%s)", async (mode) => {
    const { runner } = simulatedChild();
    await expect(
      runner({
        killProcess: () => {
          if (mode === "throw") throw Object.assign(new Error("secret"), { code: "EPERM" });
          return false;
        },
      }).run([executable], { ...defaults, timeoutMs: 20 }),
    ).rejects.toThrow(/^Spack audit process group cleanup failed$/);
  });

  test("rejects stream errors without leaking partial output or raw errors", async () => {
    const { child, runner } = simulatedChild();
    const result = runner().run([executable], defaults);
    child.stdout?.emit("data", Buffer.from("secret-partial"));
    child.stderr?.emit("error", new Error("secret-stream-error"));
    child.emit("close", 0, null);
    await expect(result).rejects.toThrow(/^Spack audit process output failed$/);
  });

  test("does not accept a close event as success after overflow", async () => {
    const { child, runner } = simulatedChild();
    const result = runner().run([executable], { ...defaults, maxOutputBytes: 1 });
    child.stdout?.emit("data", Buffer.from("too big"));
    child.emit("close", 0, null);
    await expect(result).rejects.toThrow("output limit");
  });
});

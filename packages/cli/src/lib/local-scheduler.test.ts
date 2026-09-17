import { describe, expect, test } from "bun:test";
import { localSchedulerErrorMessage, parseJobSpec, parseScheduler } from "./local-scheduler";

describe("parseScheduler", () => {
  test("accepts each supported scheduler type", () => {
    expect(parseScheduler("slurm")).toBe("slurm");
    expect(parseScheduler("pbs-pro")).toBe("pbs-pro");
    expect(parseScheduler("torque")).toBe("torque");
    expect(parseScheduler("kubernetes")).toBe("kubernetes");
  });

  test("rejects an unknown scheduler with the list of valid types", () => {
    expect(() => parseScheduler("slrum")).toThrow(/Unknown scheduler "slrum"/);
    expect(() => parseScheduler("slrum")).toThrow(/slurm, pbs-pro, torque, kubernetes/);
  });
});

describe("localSchedulerErrorMessage", () => {
  test("renders a clean per-command hint, never a stack trace", () => {
    const msg = localSchedulerErrorMessage("status", new Error('Executable not found: "squeue"'));
    expect(msg).toContain("kq status (local): Executable not found");
    expect(msg).toContain("sbatch / qsub / kubectl");
    expect(msg).toContain("`kq status` against a Server (without --local)");
    expect(msg).not.toContain("\n    at ");
  });

  test("stringifies non-Error throws and names the command", () => {
    expect(localSchedulerErrorMessage("submit", "boom")).toContain("kq submit (local): boom");
  });

  test("accepts a command-specific alternative hint (serve commands have no --local flag)", () => {
    const msg = localSchedulerErrorMessage(
      "gui serve",
      new Error("No supported scheduler found"),
      "or deploy a Server and open the SPA against it (its standard Server-client mode)",
    );
    expect(msg).toContain("kq gui serve (local): No supported scheduler found");
    expect(msg).toContain("sbatch / qsub / kubectl");
    expect(msg).toContain("deploy a Server and open the SPA against it");
    // `gui serve` is always-local (no --local flag), so the dual-mode tail must not appear.
    expect(msg).not.toContain("--local");
  });
});

describe("parseJobSpec", () => {
  test("parses a valid spec and defaults optional fields", () => {
    const spec = parseJobSpec('{"name":"wrf","command":"echo hi","cpus":4,"memoryMb":8192}');
    expect(spec).toMatchObject({ name: "wrf", command: "echo hi", cpus: 4, memoryMb: 8192 });
    expect(spec.gpus).toBe(0);
    expect(spec.wallTimeSec).toBe(0);
    expect(spec.workingDir).toBe("");
    expect(spec.envVars).toEqual({});
    expect(typeof spec.jobId).toBe("string"); // generated when absent
  });

  test("carries through optional fields when present", () => {
    const spec = parseJobSpec(
      '{"name":"g","command":"./run","cpus":8,"memoryMb":16384,"gpus":2,"wallTimeSec":3600}',
    );
    expect(spec.gpus).toBe(2);
    expect(spec.wallTimeSec).toBe(3600);
  });

  test("coerces envVars values to strings (process env is string→string)", () => {
    const spec = parseJobSpec(
      '{"name":"g","command":"./run","cpus":1,"memoryMb":1,"envVars":{"EPOCHS":10,"DEBUG":true,"NAME":"x"}}',
    );
    expect(spec.envVars).toEqual({ EPOCHS: "10", DEBUG: "true", NAME: "x" });
  });

  test("rejects invalid JSON and missing/mistyped required fields", () => {
    expect(() => parseJobSpec("not json")).toThrow(/not valid JSON/);
    expect(() => parseJobSpec('{"command":"x","cpus":1,"memoryMb":1}')).toThrow(
      /'name' and 'command'/,
    );
    expect(() => parseJobSpec('{"name":"n","command":"x"}')).toThrow(
      /numeric 'cpus' and 'memoryMb'/,
    );
  });
});

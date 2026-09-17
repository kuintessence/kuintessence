import { describe, expect, test } from "bun:test";
import { NotATtyError } from "../tui/run";
import { parseInterval, parsePane, parseScheduler, tuiStartupErrorMessage } from "./tui";

describe("parseInterval", () => {
  test("converts a seconds value to milliseconds", () => {
    expect(parseInterval("5")).toBe(5000);
    expect(parseInterval("2")).toBe(2000);
    expect(parseInterval("1.5")).toBe(1500);
  });

  test("rejects non-numbers and out-of-range values", () => {
    expect(() => parseInterval("abc")).toThrow(/interval/i);
    expect(() => parseInterval("0")).toThrow(/between/i);
    expect(() => parseInterval("0.4")).toThrow(/between/i);
    expect(() => parseInterval("3601")).toThrow(/between/i);
  });
});

describe("parsePane", () => {
  test("accepts a valid pane id", () => {
    expect(parsePane("metrics")).toBe("metrics");
    expect(parsePane("jobs")).toBe("jobs");
  });

  test("rejects an unknown pane with a helpful message", () => {
    expect(() => parsePane("bogus")).toThrow(/Unknown pane "bogus"/);
    expect(() => parsePane("bogus")).toThrow(/jobs/);
  });
});

describe("parseScheduler", () => {
  test("accepts each supported scheduler type (--scheduler in local mode)", () => {
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

describe("tuiStartupErrorMessage", () => {
  test("passes a NotATtyError message through unchanged", () => {
    const msg = tuiStartupErrorMessage(new NotATtyError(), { local: true });
    expect(msg).toBe(new NotATtyError().message);
    expect(msg).not.toContain("kq tui (local)");
  });

  test("local detection failure gets a clean message + install/remote hint", () => {
    const err = new Error("No supported scheduler detected. Install Slurm (sbatch)…");
    const msg = tuiStartupErrorMessage(err, { local: true });
    expect(msg).toContain("kq tui (local): No supported scheduler detected");
    expect(msg).toContain("sbatch / qsub / kubectl");
    expect(msg).not.toMatch(/\bat \//); // no stack frames
  });

  test("remote failure hints at --local", () => {
    const msg = tuiStartupErrorMessage(new Error("connect ECONNREFUSED"), { local: false });
    expect(msg).toContain("kq tui: connect ECONNREFUSED");
    expect(msg).toContain("--local");
  });

  test("non-Error values are stringified", () => {
    expect(tuiStartupErrorMessage("boom", { local: false })).toContain("boom");
  });
});

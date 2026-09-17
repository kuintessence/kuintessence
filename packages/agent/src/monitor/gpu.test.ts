import { describe, expect, test } from "bun:test";
import type { Spawner } from "../adapters/base";
import { parseNvidiaSmiCsv, readGpuMetrics } from "./gpu";

function fixedSpawner(result: { exitCode: number; stdout: string; stderr: string }): Spawner {
  return {
    async run() {
      return result;
    },
  };
}

function throwingSpawner(message: string): Spawner {
  return {
    async run() {
      throw new Error(message);
    },
  };
}

describe("parseNvidiaSmiCsv", () => {
  test("parses standard nvidia-smi --query-gpu output", () => {
    const csv = [
      "0, NVIDIA A100-SXM4-40GB, 1024, 40960, 35",
      "1, NVIDIA A100-SXM4-40GB, 0, 40960, 0",
    ].join("\n");
    const out = parseNvidiaSmiCsv(csv);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      index: 0,
      model: "NVIDIA A100-SXM4-40GB",
      memUsedMb: 1024,
      memTotalMb: 40960,
      utilPercent: 35,
    });
    expect(out[1]?.index).toBe(1);
    expect(out[1]?.utilPercent).toBe(0);
  });

  test("ignores blank lines and trims whitespace", () => {
    const csv = "\n  0  ,  Tesla V100  ,  100  ,  16384  ,  10  \n\n";
    const out = parseNvidiaSmiCsv(csv);
    expect(out).toHaveLength(1);
    expect(out[0]?.model).toBe("Tesla V100");
    expect(out[0]?.memUsedMb).toBe(100);
  });

  test("drops lines with bad numeric fields", () => {
    const csv = ["0, A100, abc, 40960, 35", "1, A100, 1024, 40960, 50"].join("\n");
    const out = parseNvidiaSmiCsv(csv);
    expect(out).toHaveLength(1);
    expect(out[0]?.index).toBe(1);
  });

  test("empty input → empty array", () => {
    expect(parseNvidiaSmiCsv("")).toEqual([]);
    expect(parseNvidiaSmiCsv("\n\n  \n")).toEqual([]);
  });
});

describe("readGpuMetrics", () => {
  test("returns parsed GPUs on a clean nvidia-smi exit", async () => {
    const spawner = fixedSpawner({
      exitCode: 0,
      stdout: "0, A100, 1024, 40960, 35\n1, A100, 2048, 40960, 50\n",
      stderr: "",
    });
    const out = await readGpuMetrics({ spawner });
    expect(out).toHaveLength(2);
    expect(out[0]?.index).toBe(0);
  });

  test("returns [] when nvidia-smi missing (spawner throws)", async () => {
    const out = await readGpuMetrics({ spawner: throwingSpawner("ENOENT") });
    expect(out).toEqual([]);
  });

  test("returns [] when nvidia-smi exits non-zero", async () => {
    const out = await readGpuMetrics({
      spawner: fixedSpawner({ exitCode: 9, stdout: "", stderr: "no devices" }),
    });
    expect(out).toEqual([]);
  });

  test("returns [] when stdout is empty", async () => {
    const out = await readGpuMetrics({
      spawner: fixedSpawner({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(out).toEqual([]);
  });
});

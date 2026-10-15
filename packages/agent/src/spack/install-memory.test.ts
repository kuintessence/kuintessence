import { describe, expect, test } from "bun:test";
import { admitSpackManagedMemory } from "./install-memory";
import { installMemoryFixture } from "./install-test-fixture";

function admit(meminfo: string) {
  return admitSpackManagedMemory(new AbortController().signal, {
    platform: "linux",
    readFile: installMemoryFixture({ "/proc/meminfo": meminfo }).readFile,
  });
}

describe("managed worker host memory admission", () => {
  test.each([
    "",
    "SwapTotal: 0 kB\nSwapFree: 0 kB\n",
    "SwapFree: 999999999 kB\n",
  ])("accepts the exact boundary independently of swap: %s", async (swap) => {
    await admit(`MemTotal: 4718592 kB\nMemAvailable: 4718592 kB\n${swap}`);
  });

  test("reads only meminfo, without discovering cgroup namespaces or ancestors", async () => {
    const reads: string[] = [];
    const signal = new AbortController().signal;
    await admitSpackManagedMemory(signal, {
      platform: "linux",
      readFile: async (path, readSignal) => {
        reads.push(path);
        expect(readSignal).toBe(signal);
        return installMemoryFixture().readFile(path);
      },
    });
    expect(reads).toEqual(["/proc/meminfo"]);
  });

  test.each([
    [3812352, 3000000],
    [4718591, 4718591],
    [8388608, 4718591],
    [8388608, 0],
  ])("rejects insufficient physical memory despite swap: total=%i available=%i", async (total, available) => {
    await expect(
      admit(`MemTotal: ${total} kB\nMemAvailable: ${available} kB\nSwapFree: 999999999 kB\n`),
    ).rejects.toThrow("4 GiB + 512 MiB");
  });

  test.each([
    "MemTotal",
    "MemAvailable",
  ])("rejects missing, duplicate or invalid %s", async (name) => {
    const other = name === "MemTotal" ? "MemAvailable" : "MemTotal";
    const valid = `${name}: 4718592 kB\n`;
    for (const field of [
      "",
      valid + valid,
      `${name}: 4718592 MB\n`,
      ...["", "-1", "+1", "1.5", "1e10", "NaN", "Infinity", "9007199254740992", "1 2"].map(
        (value) => `${name}: ${value} kB\n`,
      ),
    ]) {
      await expect(admit(`${other}: 4718592 kB\n${field}`)).rejects.toThrow("metadata");
    }
  });

  test("rejects empty or inconsistent metadata", async () => {
    await expect(admit("")).rejects.toThrow("metadata");
    await expect(admit("MemTotal: 8388608 kB\nMemAvailable: 8388609 kB\n")).rejects.toThrow(
      "metadata",
    );
  });

  test.each(["ENOENT", "EACCES", "EIO"])("fails closed on read error %s", async (code) => {
    await expect(
      admitSpackManagedMemory(new AbortController().signal, {
        platform: "linux",
        readFile: async () => {
          throw Object.assign(new Error("read failure"), { code });
        },
      }),
    ).rejects.toThrow("metadata");
  });

  test("rejects non-Linux before reading", async () => {
    let reads = 0;
    await expect(
      admitSpackManagedMemory(new AbortController().signal, {
        platform: "darwin",
        readFile: async () => {
          reads++;
          return "";
        },
      }),
    ).rejects.toThrow("metadata");
    expect(reads).toBe(0);
  });

  test.each([
    "before",
    "during-success",
    "during-failure",
  ])("preserves cancellation %s read", async (when) => {
    const controller = new AbortController();
    const reason = new Error("memory admission cancelled");
    if (when === "before") controller.abort(reason);
    let reads = 0;
    await expect(
      admitSpackManagedMemory(controller.signal, {
        platform: "linux",
        readFile: async (path) => {
          reads++;
          controller.abort(reason);
          if (when === "during-failure") throw new Error("read failure");
          return installMemoryFixture().readFile(path);
        },
      }),
    ).rejects.toBe(reason);
    expect(reads).toBe(when === "before" ? 0 : 1);
  });
});

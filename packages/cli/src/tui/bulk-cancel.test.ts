import { describe, expect, test } from "bun:test";
import { bulkCancelNotice, cancelEach } from "./bulk-cancel";

describe("cancelEach", () => {
  test("tallies all successes", async () => {
    const seen: string[] = [];
    const r = await cancelEach(
      async (id) => {
        seen.push(id);
      },
      ["a", "b", "c"],
    );
    expect(r).toEqual({ ok: 3, failed: [] });
    expect(seen).toEqual(["a", "b", "c"]);
  });

  test("a failing id doesn't abort the rest; failures are collected", async () => {
    const r = await cancelEach(
      async (id) => {
        if (id === "b") throw new Error("nope");
      },
      ["a", "b", "c"],
    );
    expect(r).toEqual({ ok: 2, failed: ["b"] });
  });

  test("empty input is a no-op", async () => {
    let called = 0;
    const r = await cancelEach(async () => {
      called++;
    }, []);
    expect(r).toEqual({ ok: 0, failed: [] });
    expect(called).toBe(0);
  });
});

describe("bulkCancelNotice", () => {
  test("all-success message is pluralized", () => {
    expect(bulkCancelNotice(3, [])).toBe("Cancelled 3 marked jobs");
    expect(bulkCancelNotice(1, [])).toBe("Cancelled 1 marked job");
  });

  test("lists the failed ids when some fail", () => {
    expect(bulkCancelNotice(2, ["x", "y"])).toBe("Cancelled 2, failed 2 (x, y)");
  });
});

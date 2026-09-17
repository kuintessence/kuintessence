import { describe, expect, test } from "bun:test";
import {
  RequirementsSchema,
  SchedulingStrategySchema,
  SlugSchema,
  TransferStrategySchema,
  UuidSchema,
} from "./common";

describe("SlugSchema", () => {
  test("accepts a CEL-safe identifier", () => {
    expect(SlugSchema.parse("solveOne")).toBe("solveOne");
    expect(SlugSchema.parse("_x1")).toBe("_x1");
  });

  test("rejects hyphens and leading digits", () => {
    expect(() => SlugSchema.parse("a-b")).toThrow();
    expect(() => SlugSchema.parse("1x")).toThrow();
  });
});

describe("UuidSchema", () => {
  test("accepts a uuid", () => {
    expect(UuidSchema.parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
  });

  test("rejects a non-uuid", () => {
    expect(() => UuidSchema.parse("nope")).toThrow();
  });
});

describe("SchedulingStrategySchema", () => {
  test("accepts Auto without queues", () => {
    expect(SchedulingStrategySchema.parse({ type: "Auto" })).toEqual({ type: "Auto" });
  });

  test("accepts Manual with queues", () => {
    const r = SchedulingStrategySchema.parse({
      type: "Manual",
      queues: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    });
    expect(r.type).toBe("Manual");
  });

  test("accepts Prefer with queues", () => {
    const r = SchedulingStrategySchema.parse({
      type: "Prefer",
      queues: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    });
    expect(r.type).toBe("Prefer");
  });

  test("rejects Manual without queues", () => {
    expect(() => SchedulingStrategySchema.parse({ type: "Manual" })).toThrow();
  });

  test("rejects Manual and Prefer with empty queues", () => {
    expect(() => SchedulingStrategySchema.parse({ type: "Manual", queues: [] })).toThrow();
    expect(() => SchedulingStrategySchema.parse({ type: "Prefer", queues: [] })).toThrow();
  });

  test("rejects Manual with multiple queues", () => {
    expect(() =>
      SchedulingStrategySchema.parse({
        type: "Manual",
        queues: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"],
      }),
    ).toThrow();
  });
});

describe("TransferStrategySchema", () => {
  test("accepts Network and Disk", () => {
    expect(TransferStrategySchema.parse({ type: "Network" }).type).toBe("Network");
    expect(TransferStrategySchema.parse({ type: "Disk" }).type).toBe("Disk");
  });
});

describe("RequirementsSchema", () => {
  test("accepts a partial spec", () => {
    expect(RequirementsSchema.parse({ cpuCores: 16 }).cpuCores).toBe(16);
  });

  test("rejects negative node counts", () => {
    expect(() => RequirementsSchema.parse({ nodeCount: -1 })).toThrow();
  });

  test("rejects unknown fields", () => {
    expect(() => RequirementsSchema.parse({ gpus: 4 })).toThrow();
  });
});

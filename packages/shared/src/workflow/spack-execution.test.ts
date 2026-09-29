import { describe, expect, test } from "bun:test";
import { SPACK_EXECUTION_PLACEHOLDER, SpackExecutionSchema } from "./spack-execution";

describe("internal Spack execution contract", () => {
  test("keeps older Agents fail-closed without embedding the real command", () => {
    expect(SPACK_EXECUTION_PLACEHOLDER).toBe("exit 125");
  });

  test("accepts a bounded structured intent including variants", () => {
    expect(
      SpackExecutionSchema.parse({
        spec: " hello@1.0 +mpi %gcc ",
        command: "hello 'an argument'",
      }),
    ).toEqual({ spec: "hello@1.0 +mpi %gcc", command: "hello 'an argument'" });
  });

  test.each([
    { spec: "", command: "hello" },
    { spec: "hello\nother", command: "hello" },
    { spec: "hello\0", command: "hello" },
    { spec: "a".repeat(4097), command: "hello" },
    { spec: "hello", command: " " },
    { spec: "hello", command: "hello\0" },
    { spec: "hello", command: "a".repeat(64 * 1024 + 1) },
    { spec: "hello", command: "hello", install: true },
  ])("rejects malformed or oversized intent %#", (value) => {
    expect(SpackExecutionSchema.safeParse(value).success).toBe(false);
  });
});

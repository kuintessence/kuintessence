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

test("pins full DAG, material, lock and target instead of accepting an abbreviated hash", () => {
  const pin = {
    dagHash: "a".repeat(32),
    manifestDigest: `sha256:${"b".repeat(64)}`,
    lockfileDigest: `sha256:${"c".repeat(64)}`,
    spackVersion: "1.0.0" as const,
    target: "linux-ubuntu24.04-x86_64",
  };
  expect(
    SpackExecutionSchema.parse({ spec: "gzip@1.13", command: "gzip --version", pin }).pin,
  ).toEqual(pin);
  for (const changed of [
    { dagHash: "abcdefg" },
    { dagHash: "0".repeat(32) },
    { lockfileDigest: "" },
    { spackVersion: "latest" },
    { target: "x86_64" },
  ])
    expect(
      SpackExecutionSchema.safeParse({
        spec: "gzip@1.13",
        command: "gzip",
        pin: { ...pin, ...changed },
      }).success,
    ).toBe(false);
});

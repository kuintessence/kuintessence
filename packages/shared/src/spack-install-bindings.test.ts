import { describe, expect, test } from "bun:test";
import {
  SpackInstallBindingChangeSchema,
  SpackInstallBindingQuerySchema,
} from "./spack-install-bindings";

describe("Spack install binding contracts", () => {
  const query = { scope: "platform", spec: "hello@2.12.1" };
  const binding = { repositoryId: "a".repeat(64), manifestDigest: `sha256:${"b".repeat(64)}` };
  const change = { ...query, action: "bind", binding, expectedRevision: 0, reason: "Initial" };

  test("accepts exact specs and explicit revision-checked transitions", () => {
    expect(SpackInstallBindingChangeSchema.parse(change)).toEqual(change);
    expect(
      SpackInstallBindingChangeSchema.safeParse({
        ...query,
        action: "disable",
        expectedRevision: 1,
        reason: "Maintenance",
      }).success,
    ).toBe(true);
  });

  test("rejects ambiguous specs, unbounded revisions and unknown scope", () => {
    for (const spec of ["", " hello", "hello ", "hello\nother", "x".repeat(501)]) {
      expect(SpackInstallBindingQuerySchema.safeParse({ ...query, spec }).success).toBe(false);
    }
    for (const expectedRevision of [-1, 1.5, 2_147_483_647]) {
      expect(
        SpackInstallBindingChangeSchema.safeParse({ ...change, expectedRevision }).success,
      ).toBe(false);
    }
    expect(SpackInstallBindingQuerySchema.safeParse({ ...query, scope: "*" }).success).toBe(false);
    expect(SpackInstallBindingChangeSchema.safeParse({ ...change, force: true }).success).toBe(
      false,
    );
    expect(SpackInstallBindingChangeSchema.safeParse({ ...change, reason: " " }).success).toBe(
      false,
    );
  });
});

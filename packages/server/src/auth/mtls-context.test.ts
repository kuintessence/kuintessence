import { describe, expect, test } from "bun:test";
import { mtlsContext, runWithMtlsContext } from "./mtls-context";

describe("mtls-context", () => {
  test("returns null when no context is active", () => {
    expect(mtlsContext.getStore()).toBeUndefined();
  });

  test("runWithMtlsContext exposes verified agentId via getStore", async () => {
    let inner: { agentId: string | null; fingerprintSha256: string | null } | undefined;
    await runWithMtlsContext(
      { agentId: "agent-7", fingerprintSha256: "f".repeat(64) },
      async () => {
        inner = mtlsContext.getStore();
      },
    );
    expect(inner).toEqual({ agentId: "agent-7", fingerprintSha256: "f".repeat(64) });
  });

  test("contexts are isolated across nested runs", async () => {
    let outer: string | undefined;
    let inner: string | undefined;
    await runWithMtlsContext({ agentId: "outer", fingerprintSha256: "0".repeat(64) }, async () => {
      outer = mtlsContext.getStore()?.agentId ?? undefined;
      await runWithMtlsContext(
        { agentId: "inner", fingerprintSha256: "1".repeat(64) },
        async () => {
          inner = mtlsContext.getStore()?.agentId ?? undefined;
        },
      );
      // Outer context restored after nested run completes
      expect(mtlsContext.getStore()?.agentId).toBe("outer");
    });
    expect(outer).toBe("outer");
    expect(inner).toBe("inner");
  });
});

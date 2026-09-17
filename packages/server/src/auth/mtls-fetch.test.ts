import { describe, expect, test } from "bun:test";
import type { AgentCertLookup } from "../middleware/mtls";
import { mtlsContext } from "./mtls-context";
import { wrapWithMtls } from "./mtls-fetch";

const FP = "ab".repeat(32);

describe("wrapWithMtls", () => {
  test("when disabled, calls inner unchanged and exposes null agentId", async () => {
    let seen: { agentId: string | null } | undefined;
    const inner = async (req: Request): Promise<Response> => {
      seen = mtlsContext.getStore();
      return new Response(`hello ${req.method}`, { status: 200 });
    };
    const wrapped = wrapWithMtls(inner, { enabled: false, lookup: async () => null });
    const res = await wrapped(new Request("http://x", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(seen?.agentId).toBeNull();
  });

  test("when enabled, rejects requests without fingerprint header (401)", async () => {
    const lookup: AgentCertLookup = async () => null;
    const wrapped = wrapWithMtls(async () => new Response("nope"), {
      enabled: true,
      lookup,
    });
    const res = await wrapped(new Request("http://x", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  test("when enabled and fingerprint maps to ledger, sets agentId in context", async () => {
    let seenAgentId: string | null | undefined;
    const wrapped = wrapWithMtls(
      async () => {
        seenAgentId = mtlsContext.getStore()?.agentId ?? undefined;
        return new Response("ok", { status: 200 });
      },
      {
        enabled: true,
        lookup: async (fp) => (fp === FP ? { agentId: "agent-mapped", revokedAt: null } : null),
      },
    );
    const res = await wrapped(
      new Request("http://x", {
        method: "POST",
        headers: { "x-agent-cert-fingerprint": FP },
      }),
    );
    expect(res.status).toBe(200);
    expect(seenAgentId).toBe("agent-mapped");
  });
});

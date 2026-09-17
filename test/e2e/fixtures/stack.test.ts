import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Stack, startStack } from "./stack";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 240_000);

afterAll(async () => {
  await stack?.stop();
});

describe("e2e stack fixture", () => {
  test("server /api/health returns ok", async () => {
    const r = await fetch(`${stack.serverBaseUrl}/api/health`);
    expect(r.status).toBe(200);
  });

  test("agent registers via gRPC and is listable", async () => {
    const r = await fetch(`${stack.serverBaseUrl}/api/agents`, {
      headers: { Authorization: `Bearer ${stack.adminToken}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { agents: Array<{ agentId: string }> };
    expect(body.agents.length).toBeGreaterThanOrEqual(1);
    expect(body.agents.some((a) => a.agentId === "agent-e2e-1")).toBe(true);
  });
});

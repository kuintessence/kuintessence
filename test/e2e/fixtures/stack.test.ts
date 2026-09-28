import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { E2E_SPACK_PACKAGE } from "./governed-package";
import { type Stack, startStack } from "./stack";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 240_000);

afterAll(async () => {
  await stack?.stop();
});

describe("e2e stack fixture", () => {
  test("Spack fixture returns an explicit activation shell for its installed package", async () => {
    const result = await stack.slurm.exec(["spack", "load", "--sh", `${E2E_SPACK_PACKAGE}@1`]);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "export KQ_E2E_SPACK_LOADED=1\n",
      stderr: "",
    });
  });

  test("Spack fixture rejects unknown packages and unsupported load requests", async () => {
    for (const args of [
      ["load"],
      ["load", "--sh"],
      ["load", "--sh", E2E_SPACK_PACKAGE],
      ["load", "--sh", "not-installed@1"],
      ["load", "--sh", `${E2E_SPACK_PACKAGE}@2`],
      ["load", "--csh", `${E2E_SPACK_PACKAGE}@1`],
      ["load", "--sh", `${E2E_SPACK_PACKAGE}@1`, "extra"],
      ["install", E2E_SPACK_PACKAGE],
    ]) {
      const result = await stack.slurm.exec(["spack", ...args]);
      expect(result).toEqual({ exitCode: 2, stdout: "", stderr: "" });
    }
  });

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

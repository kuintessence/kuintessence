import { expect, test } from "bun:test";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import type { CpConsoleService } from "../services/cp-console";
import type { SoftwareOperationService } from "../software-governance/operation-service";
import type { SourceAuditProofs } from "../software-governance/source-audit-proofs";
import { buildCpRouter } from "./cp";

const operationId = "00000000-0000-4000-8000-000000000001";
const actor = "00000000-0000-4000-8000-000000000002";
const base = `/api/cp/software/operations/${operationId}/source-audit-proof`;
function fixture(allowed = true) {
  const calls: unknown[] = [];
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, {
      sub: "opaque-subject",
      userId: actor,
      email: "operator@example.invalid",
      role: "super_admin",
      orgIds: [],
    });
    await next();
  });
  app.route(
    "/api/cp",
    buildCpRouter({
      consoleService: {} as CpConsoleService,
      softwareOperations: {
        getOperation: async () => ({ agentId: "target" }),
        requestSourceAudit: async (input: unknown) => {
          calls.push(["audit", input]);
          return { id: operationId, auditOnly: true, status: "queued" };
        },
        assertAgentInScope: async () => {
          if (!allowed) throw new AppError(ErrorCode.FORBIDDEN, "Agent is outside CP scope", 403);
        },
      } as unknown as SoftwareOperationService,
      sourceAuditProofs: {
        get: async (id: string) => {
          calls.push(["get", id]);
          return { valid: false, revoked: true };
        },
        revoke: async (...args: unknown[]) => {
          calls.push(["revoke", ...args]);
        },
      } as unknown as SourceAuditProofs,
    }),
  );
  return { app, calls };
}

test("proof query reports persisted validity; revoke uses the canonical actor and a required reason", async () => {
  const { app, calls } = fixture();
  const query = await app.request(base);
  expect(query.status).toBe(200);
  expect(await query.json()).toEqual({ valid: false, revoked: true });
  const revoke = await app.request(`${base}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "materials quarantined" }),
  });
  expect(revoke.status).toBe(200);
  expect(calls).toEqual([
    ["get", operationId],
    ["revoke", operationId, actor, "materials quarantined"],
  ]);
});

test("out-of-scope callers cannot query or revoke proofs", async () => {
  const { app, calls } = fixture(false);
  expect((await app.request(base)).status).toBe(403);
  expect(
    (
      await app.request(`${base}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "deny" }),
      })
    ).status,
  ).toBe(403);
  expect(calls).toEqual([]);
});

test("revoke rejects an empty reason or client-supplied authority", async () => {
  const { app, calls } = fixture();
  for (const body of [
    { reason: " " },
    { reason: "deny", actor: "forged" },
    { reason: "deny", ready: true },
  ]) {
    const response = await app.request(`${base}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  }
  expect(calls).toEqual([]);
});

test("standalone audit requires operation authorization and an idempotency key", async () => {
  const { app, calls } = fixture();
  const url = "/api/cp/software/operations/source-audit";
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "audit-request" },
    body: JSON.stringify({ agentId: "target", spec: "review@1" }),
  };
  const response = await app.request(url, init);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ auditOnly: true, status: "queued" });
  expect(calls).toEqual([
    [
      "audit",
      expect.objectContaining({
        agentId: "target",
        spec: "review@1",
        requestedBy: actor,
        idempotencyKey: "audit-request",
        agentScopeVerified: true,
      }),
    ],
  ]);
  const denied = fixture(false);
  expect((await denied.app.request(url, init)).status).toBe(403);
  expect(denied.calls).toEqual([]);
  expect(
    (await app.request(url, { ...init, headers: { "Content-Type": "application/json" } })).status,
  ).toBe(400);
});

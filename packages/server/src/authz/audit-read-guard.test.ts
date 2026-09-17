import { describe, expect, test } from "bun:test";
import { AppError } from "@kuintessence/shared";
import { Hono } from "hono";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { requireAuditReadPermission } from "./audit-read-guard";
import type { AuthzService } from "./service";

describe("audit read guard", () => {
  test("enforce mode reads after grant and denies after revoke", async () => {
    let relationshipExists = true;
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        if (!relationshipExists) {
          throw new AppError("FORBIDDEN", "Need audit read permission", 403);
        }
      },
    } as unknown as AuthzService;
    const principal: BoundPrincipal = {
      sub: "auditor",
      email: "auditor@example.test",
      role: "user",
      userId: "00000000-0000-4000-8000-000000000401",
      orgId: null,
      orgIds: [],
      memberships: [],
      capabilities: ["audit_readonly"],
    };
    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof AppError) {
        return c.json(error.toJSON(), error.statusCode as 403);
      }
      throw error;
    });
    app.use("*", async (c, next) => {
      c.set("principal" as never, principal);
      await next();
    });
    app.get("/audit", async (c) => {
      await requireAuditReadPermission(c, authz, "audit_read", "test");
      return c.json({ success: true });
    });

    expect((await app.request("/audit")).status).toBe(200);
    relationshipExists = false;
    principal.capabilities = [];
    expect((await app.request("/audit")).status).toBe(403);
  });
});

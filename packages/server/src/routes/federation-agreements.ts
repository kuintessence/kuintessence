import { AppError, ErrorCode } from "@kuintessence/shared";
import { FederationAgreementSchema, FederationError } from "@kuintessence/shared/federation";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { FederationAgreementService } from "../federation/agreements";
import type { FederationActor } from "../federation/permissions";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

export function createFederationAgreementRoutes(service: FederationAgreementService) {
  const r = new Hono<{ Variables: { federationActor: FederationActor } }>();
  r.use("/federation/agreements/*", async (c, next) => {
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!principal?.userId || !principal.orgId || c.get("automation" as never))
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "A human session and active organization are required",
        403,
      );
    c.set("federationActor", { userId: principal.userId, orgId: principal.orgId });
    await next();
  });
  r.use("/federation/agreements/*", bodyLimit({ maxSize: 600000 }));
  r.onError((error, c) => {
    if (error instanceof FederationError) {
      const status =
        error.code === "POLICY_DENIED" ? 403 : error.code === "INVALID_MESSAGE" ? 400 : 409;
      return c.json({ error: { code: error.code } }, status);
    }
    throw error;
  });
  const id = z.object({ revisionId: z.uuid() });
  const page = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });
  r.get("/federation/agreements", kqValidator("query", page), async (c) => {
    const { limit, offset } = c.req.valid("query");
    return c.json({
      success: true,
      data: await service.list(c.get("federationActor"), limit, offset),
    });
  });
  r.get(
    "/federation/agreements/:revisionId/reservations",
    kqValidator("param", id),
    kqValidator("query", page),
    async (c) => {
      const { limit, offset } = c.req.valid("query");
      return c.json({
        success: true,
        data: await service.listReservations(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          limit,
          offset,
        ),
      });
    },
  );
  r.get("/federation/agreements/:revisionId", kqValidator("param", id), async (c) =>
    c.json({
      success: true,
      data: await service.get(c.get("federationActor"), c.req.valid("param").revisionId),
    }),
  );
  r.post(
    "/federation/agreements/approve",
    kqValidator(
      "json",
      z.strictObject({
        terms: FederationAgreementSchema,
        executionUserId: z.uuid().optional(),
      }),
    ),
    async (c) =>
      c.json(
        {
          success: true,
          data: await service.approve(c.get("federationActor"), c.req.valid("json")),
        },
        201,
      ),
  );
  r.post(
    "/federation/agreements/:revisionId/counterparty",
    kqValidator("param", id),
    kqValidator("json", z.strictObject({ approvalJws: z.string().min(1).max(524288) })),
    async (c) =>
      c.json({
        success: true,
        data: await service.attachCounterparty(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          c.req.valid("json").approvalJws,
        ),
      }),
  );
  r.post(
    "/federation/agreements/:revisionId/state",
    kqValidator("param", id),
    kqValidator("json", z.strictObject({ state: z.enum(["active", "suspended", "revoked"]) })),
    async (c) => {
      await service.setState(
        c.get("federationActor"),
        c.req.valid("param").revisionId,
        c.req.valid("json").state,
      );
      return c.json({ success: true });
    },
  );
  return r;
}

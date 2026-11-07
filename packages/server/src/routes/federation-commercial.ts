import { AppError, ErrorCode } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { CommercialAgreementSchema } from "@kuintessence/shared/federation/commercial";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { FederationCommercialAgreementService } from "../federation/commercial-agreements";
import type { FederationCommercialSubmissionService } from "../federation/commercial-submissions";
import type { FederationActor } from "../federation/permissions";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

export function createFederationCommercialRoutes(
  agreements: FederationCommercialAgreementService,
  submissions: FederationCommercialSubmissionService,
) {
  const r = new Hono<{ Variables: { federationActor: FederationActor } }>();
  r.use("/federation/commercial-agreements/*", async (c, next) => {
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!principal?.userId || !principal.orgId || c.get("automation" as never))
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "A human session and active organization are required",
        403,
      );
    c.set("federationActor", { userId: principal.userId, orgId: principal.orgId });
    c.header("cache-control", "no-store");
    await next();
  });
  r.use("/federation/commercial-agreements/*", bodyLimit({ maxSize: 600000 }));
  r.onError((error, c) => {
    if (error instanceof FederationError)
      return c.json(
        { error: { code: error.code } },
        error.code === "POLICY_DENIED" ? 403 : error.code === "INVALID_MESSAGE" ? 400 : 409,
      );
    throw error;
  });
  const id = z.object({ revisionId: z.uuid() });
  const page = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });
  r.get("/federation/commercial-agreements", kqValidator("query", page), async (c) => {
    const { limit, offset } = c.req.valid("query");
    return c.json({
      success: true,
      data: await agreements.list(c.get("federationActor"), limit, offset),
    });
  });
  r.post(
    "/federation/commercial-agreements/approve",
    kqValidator("json", z.strictObject({ terms: CommercialAgreementSchema })),
    async (c) =>
      c.json(
        {
          success: true,
          data: await agreements.approve(c.get("federationActor"), c.req.valid("json").terms),
        },
        201,
      ),
  );
  r.get("/federation/commercial-agreements/:revisionId", kqValidator("param", id), async (c) =>
    c.json({
      success: true,
      data: await agreements.get(c.get("federationActor"), c.req.valid("param").revisionId),
    }),
  );
  r.post(
    "/federation/commercial-agreements/:revisionId/counterparty",
    kqValidator("param", id),
    kqValidator("json", z.strictObject({ approvalJws: z.string().min(1).max(524288) })),
    async (c) =>
      c.json({
        success: true,
        data: await agreements.attachCounterparty(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          c.req.valid("json").approvalJws,
        ),
      }),
  );
  r.get(
    "/federation/commercial-agreements/:revisionId/submissions",
    kqValidator("param", id),
    kqValidator("query", page),
    async (c) => {
      const { limit, offset } = c.req.valid("query");
      return c.json({
        success: true,
        data: await submissions.status(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          limit,
          offset,
        ),
      });
    },
  );
  r.post(
    "/federation/commercial-agreements/:revisionId/submissions/:submissionId/retry",
    kqValidator("param", id.extend({ submissionId: z.uuid() })),
    async (c) => {
      const { revisionId, submissionId } = c.req.valid("param");
      await submissions.retry(c.get("federationActor"), revisionId, submissionId);
      return c.json({ success: true });
    },
  );
  return r;
}

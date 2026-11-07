import { AppError, ErrorCode } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  CommercialExecutionApprovalSchema,
  CommercialUsageCorrectionInputSchema,
} from "@kuintessence/shared/federation/commercial";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { FederationCommercialAgreementService } from "../federation/commercial-agreements";
import type { FederationCommercialExecutionService } from "../federation/commercial-execution";
import type { FederationCommercialSubmissionService } from "../federation/commercial-submissions";
import type { FederationExecutionConfirmationService } from "../federation/execution-confirmation";
import type { FederationExecutionStopService } from "../federation/execution-stop";
import { FabricClientFailure } from "../federation/fabric-client";
import type { FederationActor } from "../federation/permissions";
import type { FederationUsageService } from "../federation/usage";
import type { FederationUsageExchange } from "../federation/usage-exchange";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

export function createFederationCommercialRoutes(
  agreements: FederationCommercialAgreementService,
  submissions: FederationCommercialSubmissionService,
  usage?: FederationUsageService,
  exchange?: FederationUsageExchange,
  execution?: FederationCommercialExecutionService,
  confirmation?: FederationExecutionConfirmationService,
  stops?: FederationExecutionStopService,
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
    if (error instanceof FabricClientFailure)
      return c.json({ error: { code: error.code } }, error.needsReview ? 502 : 503);
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
  if (execution) {
    const record = id.extend({ recordId: z.uuid() });
    const path = "/federation/commercial-agreements/:revisionId/execution-approvals";
    if (stops)
      r.post(
        `${path}/:recordId/stop`,
        kqValidator("param", record),
        kqValidator("json", z.strictObject({})),
        async (c) =>
          c.json(
            {
              success: true,
              data: await stops.request(
                c.get("federationActor"),
                c.req.valid("param").revisionId,
                c.req.valid("param").recordId,
              ),
            },
            202,
          ),
      );
    if (confirmation)
      r.post(
        `${path}/:recordId/confirm`,
        kqValidator("param", record),
        kqValidator("json", z.strictObject({})),
        async (c) =>
          c.json(
            {
              success: true,
              data: await confirmation.request(
                c.get("federationActor"),
                c.req.valid("param").revisionId,
                c.req.valid("param").recordId,
              ),
            },
            202,
          ),
      );
    r.post(
      `${path}/:recordId/activate`,
      kqValidator("param", record),
      kqValidator("json", z.strictObject({ activationId: z.uuid() })),
      async (c) =>
        c.json(
          {
            success: true,
            data: await execution.activate(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("param").recordId,
              c.req.valid("json").activationId,
            ),
          },
          202,
        ),
    );
    r.get(path, kqValidator("param", id), kqValidator("query", page), async (c) => {
      const { limit, offset } = c.req.valid("query");
      return c.json({
        success: true,
        data: await execution.list(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          limit,
          offset,
        ),
      });
    });
    r.post(
      path,
      kqValidator("param", id),
      kqValidator("json", CommercialExecutionApprovalSchema),
      async (c) =>
        c.json(
          {
            success: true,
            data: await execution.approve(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("json"),
            ),
          },
          201,
        ),
    );
    r.get(`${path}/:recordId`, kqValidator("param", record), async (c) =>
      c.json({
        success: true,
        data: await execution.get(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          c.req.valid("param").recordId,
        ),
      }),
    );
    r.post(
      `${path}/:recordId/counterparty`,
      kqValidator("param", record),
      kqValidator("json", z.strictObject({ approvalJws: z.string().min(1).max(524288) })),
      async (c) =>
        c.json({
          success: true,
          data: await execution.attachCounterparty(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").recordId,
            c.req.valid("json").approvalJws,
          ),
        }),
    );
  }
  if (usage) {
    const task = id.extend({ reservationId: z.uuid() });
    r.get(
      "/federation/commercial-agreements/:revisionId/usage",
      kqValidator("param", id),
      kqValidator("query", page),
      async (c) => {
        const { limit, offset } = c.req.valid("query");
        return c.json({
          success: true,
          data: await usage.list(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            limit,
            offset,
          ),
        });
      },
    );
    r.get(
      "/federation/commercial-agreements/:revisionId/usage/:reservationId",
      kqValidator("param", task),
      kqValidator("query", page),
      async (c) => {
        const { revisionId, reservationId } = c.req.valid("param");
        return c.json({
          success: true,
          data: await usage.get(
            c.get("federationActor"),
            revisionId,
            reservationId,
            c.req.valid("query").limit,
            c.req.valid("query").offset,
          ),
        });
      },
    );
    r.post(
      "/federation/commercial-agreements/:revisionId/usage/:reservationId/corrections",
      kqValidator("param", task),
      kqValidator("json", CommercialUsageCorrectionInputSchema),
      async (c) => {
        const { revisionId, reservationId } = c.req.valid("param");
        return c.json({
          success: true,
          data: await usage.correct(
            c.get("federationActor"),
            revisionId,
            reservationId,
            c.req.valid("json"),
          ),
        });
      },
    );
    r.post(
      "/federation/commercial-agreements/:revisionId/usage/:reservationId/retry",
      kqValidator("param", task),
      kqValidator("json", z.strictObject({})),
      async (c) => {
        const { revisionId, reservationId } = c.req.valid("param");
        await usage.retry(c.get("federationActor"), revisionId, reservationId);
        return c.json({ success: true });
      },
    );
  }
  if (exchange) {
    const operation = id.extend({ operationId: z.uuid() });
    r.get(
      "/federation/commercial-agreements/:revisionId/received-usage",
      kqValidator("param", id),
      kqValidator("query", page),
      async (c) => {
        const { limit, offset } = c.req.valid("query");
        return c.json({
          success: true,
          data: await exchange.list(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            limit,
            offset,
          ),
        });
      },
    );
    r.get(
      "/federation/commercial-agreements/:revisionId/received-usage/:operationId",
      kqValidator("param", operation),
      kqValidator("query", page),
      async (c) => {
        const { revisionId, operationId } = c.req.valid("param"),
          { limit, offset } = c.req.valid("query");
        return c.json({
          success: true,
          data: await exchange.get(
            c.get("federationActor"),
            revisionId,
            operationId,
            limit,
            offset,
          ),
        });
      },
    );
    r.post(
      "/federation/commercial-agreements/:revisionId/received-usage/:operationId/refresh",
      kqValidator("param", operation),
      kqValidator("json", z.strictObject({})),
      async (c) => {
        const { revisionId, operationId } = c.req.valid("param");
        await exchange.retry(c.get("federationActor"), revisionId, operationId);
        return c.json({ success: true });
      },
    );
  }
  return r;
}

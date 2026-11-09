import { AppError, ErrorCode } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import {
  CasePublicationDraftSchema,
  CasePublicationSchema,
} from "@kuintessence/shared/federation/case-ledger";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { FederationCasePublicationService } from "../federation/case-publications";
import type { FederationCommercialApprovalExchange } from "../federation/commercial-approval-exchange";
import type { FederationActor } from "../federation/permissions";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

export function createFederationCasePublicationRoutes(
  service: FederationCasePublicationService,
  exchange?: FederationCommercialApprovalExchange,
) {
  const r = new Hono<{ Variables: { federationActor: FederationActor } }>();
  const root = "/federation/case-publications",
    path = `${root}/:revisionId`;
  r.use(`${root}/*`, bodyLimit({ maxSize: 600000 }));
  r.use(`${root}/*`, async (c, next) => {
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
  r.onError((error, c) => {
    if (error instanceof FederationError)
      return c.json(
        { error: { code: error.code } },
        error.code === "POLICY_DENIED" ? 403 : error.code === "INVALID_MESSAGE" ? 400 : 409,
      );
    throw error;
  });
  const id = z.object({ revisionId: z.uuid() }),
    publication = id.extend({ publicationId: z.uuid() });
  if (exchange) {
    r.get(
      `${path}/exchange`,
      kqValidator("param", id),
      kqValidator(
        "query",
        z.strictObject({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      ),
      async (c) => {
        const { limit, offset } = c.req.valid("query");
        return c.json(
          await exchange.list(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            limit,
            offset,
            "case-publication",
          ),
        );
      },
    );
    r.post(
      `${path}/:publicationId/exchange/retry`,
      kqValidator("param", publication),
      kqValidator("json", z.strictObject({})),
      async (c) => {
        const { revisionId, publicationId } = c.req.valid("param");
        await exchange.retry(c.get("federationActor"), {
          agreementRevisionId: revisionId,
          recordKind: "case-publication",
          recordId: publicationId,
        });
        return c.json({ ok: true });
      },
    );
  }
  r.get(
    path,
    kqValidator("param", id),
    kqValidator(
      "query",
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        caseId: z.uuid().optional(),
        publicationId: z.uuid().optional(),
      }),
    ),
    async (c) => {
      const { limit, offset, caseId, publicationId } = c.req.valid("query");
      return c.json(
        await service.list(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          limit,
          offset,
          { caseId, publicationId },
        ),
      );
    },
  );
  r.post(
    `${path}/draft`,
    kqValidator("param", id),
    kqValidator("json", CasePublicationDraftSchema),
    async (c) =>
      c.json(
        await service.draft(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          c.req.valid("json"),
        ),
      ),
  );
  r.post(
    `${path}/approve`,
    kqValidator("param", id),
    kqValidator("json", CasePublicationSchema),
    async (c) =>
      c.json(
        await service.approve(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          c.req.valid("json"),
        ),
      ),
  );
  r.post(
    `${path}/:publicationId/counterparty`,
    kqValidator("param", publication),
    kqValidator("json", z.strictObject({ approvalJws: z.string().min(1).max(524288) })),
    async (c) => {
      const { revisionId, publicationId } = c.req.valid("param");
      return c.json(
        await service.attachCounterparty(
          c.get("federationActor"),
          revisionId,
          publicationId,
          c.req.valid("json").approvalJws,
        ),
      );
    },
  );
  r.post(
    `${path}/:publicationId/revoke`,
    kqValidator("param", publication),
    kqValidator("json", z.strictObject({})),
    async (c) => {
      const { revisionId, publicationId } = c.req.valid("param");
      return c.json(await service.revoke(c.get("federationActor"), revisionId, publicationId));
    },
  );
  return r;
}

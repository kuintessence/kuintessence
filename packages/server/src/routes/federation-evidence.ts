import { AppError, ErrorCode } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import {
  CommercialDisclosureReadScopeSchema,
  CommercialEvidenceCaseInputSchema,
} from "@kuintessence/shared/federation/disclosure-authorization";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { FederationArbitrationContextService } from "../federation/arbitration-context";
import type { FederationEvidenceService } from "../federation/disclosure-delivery";
import { FederationDeliveryError } from "../federation/outbound-client";
import type { FederationActor } from "../federation/permissions";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";

export function createFederationEvidenceRoutes(
  service: FederationEvidenceService,
  arbitration?: FederationArbitrationContextService,
) {
  const r = new Hono<{ Variables: { federationActor: FederationActor } }>();
  const path = "/federation/evidence-cases";
  r.use(`${path}/*`, bodyLimit({ maxSize: 600000 }));
  r.use(`${path}/*`, async (c, next) => {
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
    if (error instanceof FederationDeliveryError)
      return c.json(
        { error: { code: error.code } },
        error.code === "DELIVERY_UNAVAILABLE" ? 503 : 502,
      );
    if (error instanceof FederationError)
      return c.json(
        { error: { code: error.code } },
        error.code === "POLICY_DENIED" ? 403 : error.code === "INVALID_MESSAGE" ? 400 : 409,
      );
    throw error;
  });
  const id = z.object({ caseId: z.uuid() });
  const page = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });
  r.post(path, kqValidator("json", CommercialEvidenceCaseInputSchema), async (c) =>
    c.json(await service.register(c.get("federationActor"), c.req.valid("json")), 201),
  );
  r.get(path, kqValidator("query", page), async (c) => {
    const { limit, offset } = c.req.valid("query");
    return c.json(await service.list(c.get("federationActor"), limit, offset));
  });
  r.post(
    `${path}/:caseId/close`,
    kqValidator("param", id),
    kqValidator("json", z.strictObject({})),
    async (c) => c.json(await service.close(c.get("federationActor"), c.req.valid("param").caseId)),
  );
  r.get(
    `${path}/:caseId/disclosures`,
    kqValidator("param", id),
    kqValidator("query", page),
    async (c) => {
      const { limit, offset } = c.req.valid("query");
      return c.json(
        await service.materials(
          c.get("federationActor"),
          c.req.valid("param").caseId,
          limit,
          offset,
        ),
      );
    },
  );
  r.post(
    `${path}/:caseId/disclosures`,
    kqValidator("param", id),
    kqValidator("json", CommercialDisclosureReadScopeSchema),
    async (c) =>
      c.json(
        {
          disclosure: await service.import(
            c.get("federationActor"),
            c.req.valid("param").caseId,
            c.req.valid("json"),
          ),
        },
        201,
      ),
  );
  r.get(
    `${path}/:caseId/disclosures/:grantId`,
    kqValidator("param", id.extend({ grantId: z.uuid() })),
    async (c) => {
      const { caseId, grantId } = c.req.valid("param");
      return c.json({ disclosure: await service.read(c.get("federationActor"), caseId, grantId) });
    },
  );
  r.get(`${path}/:caseId/arbitration-context`, kqValidator("param", id), async (c) => {
    if (!arbitration) throw new FederationError("ASSET_UNAVAILABLE");
    return c.json({
      data: await arbitration.read(c.get("federationActor"), c.req.valid("param").caseId),
    });
  });
  return r;
}

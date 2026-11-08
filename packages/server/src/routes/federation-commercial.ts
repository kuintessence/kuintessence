import { AppError, ErrorCode } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialDiscountSchema,
  CommercialExecutionApprovalSchema,
  CommercialReservationSchema,
  CommercialSettlementSchema,
  CommercialUsageCorrectionInputSchema,
} from "@kuintessence/shared/federation/commercial";
import { CommercialApprovalRecordKindSchema } from "@kuintessence/shared/federation/commercial-approval-exchange";
import { MarketRequestSchema } from "@kuintessence/shared/federation/market-request";
import { FederationTerminalProposalSchema } from "@kuintessence/shared/federation/terminal-proposal";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { FederationBillingService } from "../federation/billing";
import type { FederationClosingAutomation } from "../federation/closing-automation";
import {
  ClosingPolicyInputSchema,
  type FederationClosingPolicyService,
} from "../federation/closing-policy";
import type { FederationCommercialAgreementService } from "../federation/commercial-agreements";
import type { FederationCommercialApprovalExchange } from "../federation/commercial-approval-exchange";
import type { FederationCommercialExecutionService } from "../federation/commercial-execution";
import type { FederationCommercialSubmissionService } from "../federation/commercial-submissions";
import type { FederationExecutionAutomation } from "../federation/execution-automation";
import type { FederationExecutionConfirmationService } from "../federation/execution-confirmation";
import type { FederationExecutionStopService } from "../federation/execution-stop";
import type { FederationExecutionTerminalService } from "../federation/execution-terminal";
import type { FederationTerminalExchange } from "../federation/execution-terminal-exchange";
import { FabricClientFailure } from "../federation/fabric-client";
import type { FederationMarketRequestService } from "../federation/market-requests";
import type { FederationActor } from "../federation/permissions";
import {
  type FederationReservationPolicyService,
  ReservationPolicyInputSchema,
} from "../federation/reservation-policy";
import type { FederationReservationProposalService } from "../federation/reservation-proposals";
import type { FederationSettlementService } from "../federation/settlement";
import {
  type FederationTerminalPolicyService,
  TerminalPolicyInputSchema,
} from "../federation/terminal-policy";
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
  terminals?: FederationExecutionTerminalService,
  terminalExchange?: FederationTerminalExchange,
  terminalPolicies?: FederationTerminalPolicyService,
  approvalExchange?: FederationCommercialApprovalExchange,
  reservationPolicies?: FederationReservationPolicyService,
  reservationProposals?: FederationReservationProposalService,
  executionAutomation?: FederationExecutionAutomation,
  marketRequests?: FederationMarketRequestService,
  billing?: FederationBillingService,
  settlements?: FederationSettlementService,
  closingPolicies?: FederationClosingPolicyService,
  closing?: FederationClosingAutomation,
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
  r.use("/federation/commercial-agreements/*", (c, next) =>
    bodyLimit({
      maxSize: c.req.path.endsWith("/terminal/countersign") ? 16 * 1024 * 1024 : 600000,
    })(c, next),
  );
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
  if (settlements) {
    const path = "/federation/commercial-agreements/:revisionId/settlements";
    r.get(
      path,
      kqValidator("param", id),
      kqValidator("query", page.extend({ recordId: z.uuid().optional() })),
      async (c) => {
        const { limit, offset, recordId } = c.req.valid("query");
        return c.json({
          data: await settlements.list(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            limit,
            offset,
            recordId,
          ),
        });
      },
    );
    r.post(
      `${path}/draft`,
      kqValidator("param", id),
      kqValidator("json", z.strictObject({ billId: z.uuid(), settlementId: z.uuid() })),
      async (c) => {
        const input = c.req.valid("json");
        return c.json({
          data: await settlements.draft(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            input.billId,
            input.settlementId,
          ),
        });
      },
    );
    r.post(
      `${path}/approve`,
      kqValidator("param", id),
      kqValidator("json", CommercialSettlementSchema),
      async (c) =>
        c.json(
          {
            data: await settlements.approve(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("json"),
            ),
          },
          201,
        ),
    );
    r.post(
      `${path}/:settlementId/counterparty`,
      kqValidator("param", id.extend({ settlementId: z.uuid() })),
      kqValidator("json", z.strictObject({ approvalJws: z.string().min(1).max(524288) })),
      async (c) =>
        c.json({
          data: await settlements.attachCounterparty(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").settlementId,
            c.req.valid("json").approvalJws,
          ),
        }),
    );
  }
  if (billing) {
    const path = "/federation/commercial-agreements/:revisionId/bills";
    r.get(
      "/federation/commercial-agreements/:revisionId/discounts",
      kqValidator("param", id),
      kqValidator("query", page),
      async (c) => {
        const { limit, offset } = c.req.valid("query");
        return c.json({
          data: await billing.listDiscounts(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            limit,
            offset,
          ),
        });
      },
    );
    r.get(
      path,
      kqValidator("param", id),
      kqValidator("query", page.extend({ recordId: z.uuid().optional() })),
      async (c) => {
        const { limit, offset, recordId } = c.req.valid("query");
        return c.json({
          data: await billing.list(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            limit,
            offset,
            recordId,
          ),
        });
      },
    );
    r.post(
      `${path}/draft`,
      kqValidator("param", id),
      kqValidator(
        "json",
        z.strictObject({ reportId: z.uuid(), billId: z.uuid(), discountId: z.uuid().optional() }),
      ),
      async (c) => {
        const input = c.req.valid("json");
        return c.json({
          data: await billing.draft(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            input.reportId,
            input.billId,
            input.discountId,
          ),
        });
      },
    );
    r.post(
      `${path}/approve`,
      kqValidator("param", id),
      kqValidator("json", CommercialBillSchema),
      async (c) =>
        c.json(
          {
            data: await billing.approve(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("json"),
            ),
          },
          201,
        ),
    );
    r.post(
      `${path}/:billId/counterparty`,
      kqValidator("param", id.extend({ billId: z.uuid() })),
      kqValidator("json", z.strictObject({ approvalJws: z.string().min(1).max(524288) })),
      async (c) =>
        c.json({
          data: await billing.attachCounterparty(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").billId,
            c.req.valid("json").approvalJws,
          ),
        }),
    );
    r.post(
      "/federation/commercial-agreements/:revisionId/discounts/approve",
      kqValidator("param", id),
      kqValidator("json", CommercialDiscountSchema),
      async (c) =>
        c.json(
          {
            data: await billing.approveDiscount(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("json"),
            ),
          },
          201,
        ),
    );
    r.post(
      "/federation/commercial-agreements/:revisionId/discounts/import",
      kqValidator("param", id),
      kqValidator("json", z.strictObject({ providerJws: z.string().min(1).max(524288) })),
      async (c) =>
        c.json(
          {
            data: await billing.importDiscount(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("json").providerJws,
            ),
          },
          201,
        ),
    );
  }
  if (marketRequests) {
    const path = "/federation/commercial-agreements/:revisionId/market-requests";
    r.get(path, kqValidator("param", id), kqValidator("query", page), async (c) => {
      const { limit, offset } = c.req.valid("query");
      return c.json({
        success: true,
        data: await marketRequests.list(
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
      kqValidator("json", z.strictObject({ policyId: z.uuid(), request: MarketRequestSchema })),
      async (c) => {
        const input = c.req.valid("json");
        return c.json(
          {
            success: true,
            data: await marketRequests.submit(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              input.policyId,
              input.request,
            ),
          },
          202,
        );
      },
    );
    r.post(
      `${path}/:reservationId/retry`,
      kqValidator("param", id.extend({ reservationId: z.uuid() })),
      kqValidator("json", z.strictObject({})),
      async (c) => {
        const params = c.req.valid("param");
        await marketRequests.retry(
          c.get("federationActor"),
          params.revisionId,
          params.reservationId,
        );
        return c.json({ success: true });
      },
    );
  }
  if (executionAutomation)
    r.post(
      "/federation/commercial-agreements/:revisionId/reservation-proposals/:reservationId/execution-retry",
      kqValidator("param", id.extend({ reservationId: z.uuid() })),
      kqValidator("json", z.strictObject({})),
      async (c) => {
        await executionAutomation.retry(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          c.req.valid("param").reservationId,
        );
        return c.json({ success: true });
      },
    );
  if (reservationProposals) {
    const path = "/federation/commercial-agreements/:revisionId/reservation-proposals";
    r.get(path, kqValidator("param", id), kqValidator("query", page), async (c) =>
      c.json({
        success: true,
        data: await reservationProposals.list(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          c.req.valid("query").limit,
          c.req.valid("query").offset,
        ),
      }),
    );
    r.post(
      path,
      kqValidator("param", id),
      kqValidator(
        "json",
        z.strictObject({ policyId: z.uuid(), proposal: CommercialReservationSchema }),
      ),
      async (c) =>
        c.json(
          {
            success: true,
            data: await reservationProposals.submit(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("json").policyId,
              c.req.valid("json").proposal,
            ),
          },
          202,
        ),
    );
    r.post(
      `${path}/:reservationId/retry`,
      kqValidator("param", id.extend({ reservationId: z.uuid() })),
      kqValidator("json", z.strictObject({})),
      async (c) =>
        c.json({
          success: true,
          data: await reservationProposals.retry(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").reservationId,
          ),
        }),
    );
  }
  if (reservationPolicies) {
    const path = "/federation/commercial-agreements/:revisionId/reservation-policies";
    r.get(path, kqValidator("param", id), kqValidator("query", page), async (c) =>
      c.json({
        success: true,
        data: await reservationPolicies.list(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          c.req.valid("query").limit,
          c.req.valid("query").offset,
        ),
      }),
    );
    r.post(
      path,
      kqValidator("param", id),
      kqValidator("json", ReservationPolicyInputSchema),
      async (c) =>
        c.json(
          {
            success: true,
            data: await reservationPolicies.grant(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("json"),
            ),
          },
          201,
        ),
    );
    r.post(
      `${path}/:policyId/revoke`,
      kqValidator("param", id.extend({ policyId: z.uuid() })),
      kqValidator("json", z.strictObject({})),
      async (c) =>
        c.json({
          success: true,
          data: await reservationPolicies.revoke(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").policyId,
          ),
        }),
    );
  }
  if (approvalExchange) {
    const path = "/federation/commercial-agreements/:revisionId/approval-exchange";
    r.get(path, kqValidator("param", id), kqValidator("query", page), async (c) =>
      c.json({
        success: true,
        data: await approvalExchange.list(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          c.req.valid("query").limit,
          c.req.valid("query").offset,
        ),
      }),
    );
    r.post(
      `${path}/:recordKind/:recordId/retry`,
      kqValidator(
        "param",
        id.extend({ recordKind: CommercialApprovalRecordKindSchema, recordId: z.uuid() }),
      ),
      kqValidator("json", z.strictObject({})),
      async (c) => {
        const { revisionId, recordKind, recordId } = c.req.valid("param");
        await approvalExchange.retry(c.get("federationActor"), {
          agreementRevisionId: revisionId,
          recordKind,
          recordId,
        });
        return c.json({ success: true });
      },
    );
  }
  if (closing) {
    const path = "/federation/commercial-agreements/:revisionId/closing-tasks";
    r.get(path, kqValidator("param", id), kqValidator("query", page), async (c) =>
      c.json({
        success: true,
        data: await closing.list(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          c.req.valid("query").limit,
          c.req.valid("query").offset,
        ),
      }),
    );
    r.post(
      `${path}/:kind/:referenceId/retry`,
      kqValidator(
        "param",
        id.extend({ kind: z.enum(["bill", "settlement"]), referenceId: z.uuid() }),
      ),
      kqValidator("json", z.strictObject({})),
      async (c) => {
        const params = c.req.valid("param");
        await closing.retry(
          c.get("federationActor"),
          params.revisionId,
          params.kind,
          params.referenceId,
        );
        return c.json({ success: true });
      },
    );
  }
  if (closingPolicies) {
    const path = "/federation/commercial-agreements/:revisionId/closing-policies";
    r.get(path, kqValidator("param", id), kqValidator("query", page), async (c) =>
      c.json({
        success: true,
        data: await closingPolicies.list(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          c.req.valid("query").limit,
          c.req.valid("query").offset,
        ),
      }),
    );
    r.post(
      path,
      kqValidator("param", id),
      kqValidator("json", ClosingPolicyInputSchema),
      async (c) =>
        c.json(
          {
            success: true,
            data: await closingPolicies.grant(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("json"),
            ),
          },
          201,
        ),
    );
    r.post(
      `${path}/:policyId/revoke`,
      kqValidator("param", id.extend({ policyId: z.uuid() })),
      kqValidator("json", z.strictObject({})),
      async (c) =>
        c.json({
          success: true,
          data: await closingPolicies.revoke(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").policyId,
          ),
        }),
    );
  }
  if (terminalPolicies) {
    const path = "/federation/commercial-agreements/:revisionId/terminal-policies";
    r.get(path, kqValidator("param", id), kqValidator("query", page), async (c) =>
      c.json({
        success: true,
        data: await terminalPolicies.list(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          c.req.valid("query").limit,
          c.req.valid("query").offset,
        ),
      }),
    );
    r.post(
      path,
      kqValidator("param", id),
      kqValidator("json", TerminalPolicyInputSchema),
      async (c) =>
        c.json(
          {
            success: true,
            data: await terminalPolicies.grant(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("json"),
            ),
          },
          201,
        ),
    );
    r.post(
      `${path}/:policyId/revoke`,
      kqValidator("param", id.extend({ policyId: z.uuid() })),
      kqValidator("json", z.strictObject({})),
      async (c) =>
        c.json({
          success: true,
          data: await terminalPolicies.revoke(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").policyId,
          ),
        }),
    );
    r.post(
      "/federation/commercial-agreements/:revisionId/execution-approvals/:recordId/terminal/automatic-retry",
      kqValidator("param", id.extend({ recordId: z.uuid() })),
      kqValidator("json", z.strictObject({})),
      async (c) => {
        await terminalPolicies.retry(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          c.req.valid("param").recordId,
        );
        return c.json({ success: true });
      },
    );
  }
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
    if (terminalExchange) {
      r.get(`${path}/:recordId/terminal/exchange`, kqValidator("param", record), async (c) => {
        const { revisionId, recordId } = c.req.valid("param");
        return c.json({
          data: await terminalExchange.get(c.get("federationActor"), revisionId, recordId),
        });
      });
      r.post(
        `${path}/:recordId/terminal/refresh`,
        kqValidator("param", record),
        kqValidator("json", z.strictObject({})),
        async (c) => {
          const { revisionId, recordId } = c.req.valid("param");
          await terminalExchange.retry(c.get("federationActor"), revisionId, recordId);
          return c.json({ data: { queued: true } }, 202);
        },
      );
      if (terminals)
        r.post(
          `${path}/:recordId/terminal/countersign-received`,
          kqValidator("param", record),
          kqValidator("json", z.strictObject({})),
          async (c) => {
            const { revisionId, recordId } = c.req.valid("param"),
              actor = c.get("federationActor");
            const received = await terminalExchange.get(actor, revisionId, recordId);
            if (!received.sync?.proposal) throw new FederationError("DATA_WAITING");
            return c.json({
              data: await terminals.countersign(
                actor,
                revisionId,
                recordId,
                received.sync.proposal,
              ),
            });
          },
        );
    }
    if (terminals) {
      r.get(`${path}/:recordId/terminal/proposal`, kqValidator("param", record), async (c) =>
        c.json({
          success: true,
          data: await terminals.proposal(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").recordId,
          ),
        }),
      );
      r.post(
        `${path}/:recordId/terminal/countersign`,
        kqValidator("param", record),
        kqValidator("json", FederationTerminalProposalSchema),
        async (c) =>
          c.json({
            success: true,
            data: await terminals.countersign(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("param").recordId,
              c.req.valid("json"),
            ),
          }),
      );
      r.get(`${path}/:recordId/terminal`, kqValidator("param", record), async (c) =>
        c.json({
          success: true,
          data: await terminals.get(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").recordId,
          ),
        }),
      );
      r.post(
        `${path}/:recordId/terminal`,
        kqValidator("param", record),
        kqValidator("json", z.strictObject({})),
        async (c) =>
          c.json({
            success: true,
            data: await terminals.approve(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("param").recordId,
            ),
          }),
      );
    }
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

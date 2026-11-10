import { AppError, ErrorCode } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import {
  CommercialArbitrationPolicyDraftSchema,
  CommercialArbitrationPolicySchema,
} from "@kuintessence/shared/federation/arbitration-policy";
import {
  CommercialAdjustmentDraftInputSchema,
  CommercialAdjustmentSchema,
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialDiscountSchema,
  CommercialExecutionApprovalSchema,
  CommercialPaymentDraftInputSchema,
  CommercialPaymentSchema,
  CommercialRefundDraftInputSchema,
  CommercialRefundSchema,
  CommercialReservationSchema,
  CommercialSettlementSchema,
  CommercialUsageCorrectionInputSchema,
} from "@kuintessence/shared/federation/commercial";
import { CommercialApprovalRecordKindSchema } from "@kuintessence/shared/federation/commercial-approval-exchange";
import {
  CommercialDisclosureDraftSchema,
  CommercialDisclosureSchema,
} from "@kuintessence/shared/federation/disclosure";
import {
  CommercialDisclosurePolicyDraftSchema,
  CommercialDisclosurePolicySchema,
} from "@kuintessence/shared/federation/disclosure-authorization";
import {
  CommercialDisputeDraftSchema,
  CommercialDisputeSchema,
} from "@kuintessence/shared/federation/disputes";
import { MarketRequestSchema } from "@kuintessence/shared/federation/market-request";
import { FederationTerminalProposalSchema } from "@kuintessence/shared/federation/terminal-proposal";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { FederationAdjustmentService } from "../federation/adjustment";
import type { FederationArbitrationDecisionDelivery } from "../federation/arbitration-decision-delivery";
import type { FederationArbitrationPolicyService } from "../federation/arbitration-policy";
import type { FederationArbitrationResolutionService } from "../federation/arbitration-resolution";
import type { FederationArbitrationRevocationDelivery } from "../federation/arbitration-revocations";
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
import type { FederationDisclosureService } from "../federation/disclosure";
import type { FederationDisclosurePolicyService } from "../federation/disclosure-policy";
import type { FederationDisputeDelivery } from "../federation/dispute-delivery";
import type { FederationDisputeFreezeExchange } from "../federation/dispute-freeze-exchange";
import type { FederationDisputeService } from "../federation/disputes";
import type { FederationExecutionAutomation } from "../federation/execution-automation";
import type { FederationExecutionConfirmationService } from "../federation/execution-confirmation";
import type { FederationExecutionStopService } from "../federation/execution-stop";
import type { FederationExecutionTerminalService } from "../federation/execution-terminal";
import type { FederationTerminalExchange } from "../federation/execution-terminal-exchange";
import { FabricClientFailure } from "../federation/fabric-client";
import type { FederationMarketRequestService } from "../federation/market-requests";
import type { FederationPaymentService } from "../federation/payment";
import type { FederationActor } from "../federation/permissions";
import type { FederationRefundService } from "../federation/refund";
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
  adjustments?: FederationAdjustmentService,
  refunds?: FederationRefundService,
  payments?: FederationPaymentService,
  disclosurePolicies?: FederationDisclosurePolicyService,
  disputes?: FederationDisputeService,
  disputeDelivery?: FederationDisputeDelivery,
  disputeFreezes?: FederationDisputeFreezeExchange,
  disclosures?: FederationDisclosureService,
  arbitrationPolicies?: FederationArbitrationPolicyService,
  arbitrationRevocations?: FederationArbitrationRevocationDelivery,
  arbitrationDecisions?: FederationArbitrationDecisionDelivery,
  arbitrationResolution?: FederationArbitrationResolutionService,
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
    if (error instanceof FederationError && error.code === "STORAGE_PRESSURE")
      return c.json({ error: { code: error.code } }, 503);
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
  if (disputeDelivery) {
    const path = "/federation/commercial-agreements/:revisionId/disputes/:caseId/delivery";
    const params = id.extend({ caseId: z.uuid() });
    r.get(path, kqValidator("param", params), async (c) => {
      const { revisionId, caseId } = c.req.valid("param");
      return c.json({
        data: await disputeDelivery.status(c.get("federationActor"), revisionId, caseId),
      });
    });
    r.post(
      `${path}/retry`,
      kqValidator("param", params),
      kqValidator("json", z.object({}).strict()),
      async (c) => {
        const { revisionId, caseId } = c.req.valid("param");
        await disputeDelivery.retry(c.get("federationActor"), revisionId, caseId);
        return c.json({ data: { queued: true } });
      },
    );
  }
  if (disputeFreezes) {
    const path = "/federation/commercial-agreements/:revisionId/disputes/:caseId/freeze";
    const params = id.extend({ caseId: z.uuid() });
    r.get(path, kqValidator("param", params), async (c) => {
      const { revisionId, caseId } = c.req.valid("param");
      return c.json({
        data: await disputeFreezes.status(c.get("federationActor"), revisionId, caseId),
      });
    });
    r.post(
      `${path}/retry`,
      kqValidator("param", params),
      kqValidator("json", z.object({}).strict()),
      async (c) => {
        const { revisionId, caseId } = c.req.valid("param");
        await disputeFreezes.retry(c.get("federationActor"), revisionId, caseId);
        return c.json({ data: { queued: true } });
      },
    );
  }
  if (arbitrationDecisions)
    r.get(
      "/federation/commercial-agreements/:revisionId/disputes/:caseId/arbitration-decision",
      kqValidator("param", id.extend({ caseId: z.uuid() })),
      async (c) => {
        const { revisionId, caseId } = c.req.valid("param");
        return c.json({
          data: await arbitrationDecisions.receivedDecision(
            c.get("federationActor"),
            revisionId,
            caseId,
          ),
        });
      },
    );
  if (arbitrationResolution) {
    const path =
      "/federation/commercial-agreements/:revisionId/disputes/:caseId/arbitration-resolution";
    const params = id.extend({ caseId: z.uuid() });
    r.get(path, kqValidator("param", params), async (c) => {
      const { revisionId, caseId } = c.req.valid("param");
      return c.json({
        data: await arbitrationResolution.read(c.get("federationActor"), revisionId, caseId),
      });
    });
    r.post(
      path,
      kqValidator("param", params),
      kqValidator("json", z.strictObject({})),
      async (c) => {
        const { revisionId, caseId } = c.req.valid("param");
        return c.json({
          data: await arbitrationResolution.execute(c.get("federationActor"), revisionId, caseId),
        });
      },
    );
  }
  if (disputes) {
    const path = "/federation/commercial-agreements/:revisionId/disputes";
    r.get(
      `${path}/:caseId/arbitration-binding`,
      kqValidator("param", id.extend({ caseId: z.uuid() })),
      async (c) => {
        const { revisionId, caseId } = c.req.valid("param");
        return c.json({
          data: await disputes.arbitrationBinding(c.get("federationActor"), revisionId, caseId),
        });
      },
    );
    r.get(
      path,
      kqValidator("param", id),
      kqValidator("query", page.extend({ caseId: z.uuid().optional() })),
      async (c) => {
        const { limit, offset, caseId } = c.req.valid("query");
        return c.json({
          data: await disputes.list(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            limit,
            offset,
            caseId,
          ),
        });
      },
    );
    r.get(
      `${path}/:caseId/financial-view`,
      kqValidator("param", id.extend({ caseId: z.uuid() })),
      async (c) => {
        const { revisionId, caseId } = c.req.valid("param");
        return c.json({
          data: await disputes.financialView(c.get("federationActor"), revisionId, caseId),
        });
      },
    );
    r.post(
      `${path}/draft`,
      kqValidator("param", id),
      kqValidator("json", CommercialDisputeDraftSchema),
      async (c) =>
        c.json({
          data: await disputes.draft(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("json"),
          ),
        }),
    );
    r.post(
      `${path}/open`,
      kqValidator("param", id),
      kqValidator("json", CommercialDisputeSchema),
      async (c) =>
        c.json({
          data: await disputes.open(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("json"),
          ),
        }),
    );
  }
  if (disclosures) {
    const path = "/federation/commercial-agreements/:revisionId/disclosures";
    const grant = id.extend({ grantId: z.uuid() });
    r.get(
      path,
      kqValidator("param", id),
      kqValidator(
        "query",
        page.extend({
          caseId: z.uuid().optional(),
          grantId: z.uuid().optional(),
        }),
      ),
      async (c) => {
        const { limit, offset, caseId, grantId } = c.req.valid("query");
        return c.json({
          data: await disclosures.list(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            limit,
            offset,
            { caseId, grantId },
          ),
        });
      },
    );
    r.post(
      `${path}/draft`,
      kqValidator("param", id),
      kqValidator("json", CommercialDisclosureDraftSchema),
      async (c) =>
        c.json({
          data: await disclosures.draft(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("json"),
          ),
        }),
    );
    r.post(
      `${path}/approve`,
      kqValidator("param", id),
      kqValidator("json", CommercialDisclosureSchema),
      async (c) =>
        c.json({
          data: await disclosures.approve(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("json"),
          ),
        }),
    );
    r.post(
      `${path}/:grantId/counterparty`,
      kqValidator("param", grant),
      kqValidator("json", z.object({ approvalJws: z.string().min(1).max(524288) }).strict()),
      async (c) =>
        c.json({
          data: await disclosures.attachCounterparty(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").grantId,
            c.req.valid("json").approvalJws,
          ),
        }),
    );
    r.post(
      `${path}/:grantId/revoke`,
      kqValidator("param", grant),
      kqValidator("json", z.object({}).strict()),
      async (c) =>
        c.json({
          data: await disclosures.revoke(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").grantId,
          ),
        }),
    );
  }
  if (arbitrationRevocations) {
    const path =
      "/federation/commercial-agreements/:revisionId/arbitration-policies/:policyId/revocation-deliveries";
    const params = id.extend({ policyId: z.uuid() });
    r.get(path, kqValidator("param", params), async (c) => {
      const p = c.req.valid("param");
      return c.json({
        success: true,
        data: await arbitrationRevocations.status(
          c.get("federationActor"),
          p.revisionId,
          p.policyId,
        ),
      });
    });
    r.post(
      `${path}/:receivingSiteId/retry`,
      kqValidator("param", params.extend({ receivingSiteId: z.uuid() })),
      kqValidator("json", z.strictObject({})),
      async (c) => {
        const p = c.req.valid("param");
        await arbitrationRevocations.retry(
          c.get("federationActor"),
          p.revisionId,
          p.policyId,
          p.receivingSiteId,
        );
        return c.json({ success: true });
      },
    );
  }
  if (arbitrationPolicies) {
    const path = "/federation/commercial-agreements/:revisionId/arbitration-policies";
    const policyId = id.extend({ policyId: z.uuid() });
    r.get(
      path,
      kqValidator("param", id),
      kqValidator("query", page.extend({ policyId: z.uuid().optional() })),
      async (c) => {
        const { limit, offset, policyId } = c.req.valid("query");
        return c.json({
          data: await arbitrationPolicies.list(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            limit,
            offset,
            policyId,
          ),
        });
      },
    );
    r.post(
      `${path}/draft`,
      kqValidator("param", id),
      kqValidator("json", CommercialArbitrationPolicyDraftSchema),
      async (c) =>
        c.json({
          data: await arbitrationPolicies.draft(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("json"),
          ),
        }),
    );
    r.post(
      `${path}/approve`,
      kqValidator("param", id),
      kqValidator("json", CommercialArbitrationPolicySchema),
      async (c) =>
        c.json({
          data: await arbitrationPolicies.approve(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("json"),
          ),
        }),
    );
    r.post(
      `${path}/:policyId/counterparty`,
      kqValidator("param", policyId),
      kqValidator("json", z.strictObject({ approvalJws: z.string().min(1).max(524288) })),
      async (c) =>
        c.json({
          data: await arbitrationPolicies.attachCounterparty(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").policyId,
            c.req.valid("json").approvalJws,
          ),
        }),
    );
    r.post(
      `${path}/:policyId/revoke`,
      kqValidator("param", policyId),
      kqValidator("json", z.strictObject({})),
      async (c) =>
        c.json({
          data: await arbitrationPolicies.revoke(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").policyId,
          ),
        }),
    );
    r.post(
      `${path}/:policyId/ledger-revocation`,
      kqValidator("param", policyId),
      kqValidator("json", z.strictObject({})),
      async (c) =>
        c.json({
          data: await arbitrationPolicies.submitRevocation(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").policyId,
          ),
        }),
    );
  }
  if (disclosurePolicies) {
    const path = "/federation/commercial-agreements/:revisionId/disclosure-policies";
    const policyId = id.extend({ policyId: z.uuid() });
    r.get(
      path,
      kqValidator("param", id),
      kqValidator("query", page.extend({ policyId: z.uuid().optional() })),
      async (c) => {
        const { limit, offset, policyId } = c.req.valid("query");
        return c.json({
          data: await disclosurePolicies.list(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            limit,
            offset,
            policyId,
          ),
        });
      },
    );
    r.post(
      `${path}/draft`,
      kqValidator("param", id),
      kqValidator("json", CommercialDisclosurePolicyDraftSchema),
      async (c) =>
        c.json({
          data: await disclosurePolicies.draft(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("json"),
          ),
        }),
    );
    r.post(
      `${path}/approve`,
      kqValidator("param", id),
      kqValidator("json", CommercialDisclosurePolicySchema),
      async (c) =>
        c.json({
          data: await disclosurePolicies.approve(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("json"),
          ),
        }),
    );
    r.post(
      `${path}/:policyId/counterparty`,
      kqValidator("param", policyId),
      kqValidator("json", z.strictObject({ approvalJws: z.string().min(1).max(524288) })),
      async (c) =>
        c.json({
          data: await disclosurePolicies.attachCounterparty(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").policyId,
            c.req.valid("json").approvalJws,
          ),
        }),
    );
    r.post(
      `${path}/:policyId/revoke`,
      kqValidator("param", policyId),
      kqValidator("json", z.strictObject({})),
      async (c) =>
        c.json({
          data: await disclosurePolicies.revoke(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").policyId,
          ),
        }),
    );
  }
  if (payments) {
    const path = "/federation/commercial-agreements/:revisionId/payments";
    r.get(
      path,
      kqValidator("param", id),
      kqValidator(
        "query",
        page.extend({
          billId: z.uuid().optional(),
          paymentId: z.uuid().optional(),
          recordId: z.uuid().optional(),
        }),
      ),
      async (c) => {
        const { limit, offset, billId, paymentId, recordId } = c.req.valid("query");
        return c.json({
          data: await payments.list(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            limit,
            offset,
            billId,
            paymentId,
            recordId,
          ),
        });
      },
    );
    r.post(
      `${path}/draft`,
      kqValidator("param", id),
      kqValidator("json", CommercialPaymentDraftInputSchema),
      async (c) =>
        c.json({
          data: await payments.draft(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("json"),
          ),
        }),
    );
    r.post(
      `${path}/approve`,
      kqValidator("param", id),
      kqValidator("json", CommercialPaymentSchema),
      async (c) =>
        c.json(
          {
            data: await payments.approve(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("json"),
            ),
          },
          201,
        ),
    );
    r.post(
      `${path}/:receiptId/counterparty`,
      kqValidator("param", id.extend({ receiptId: z.uuid() })),
      kqValidator("json", z.strictObject({ approvalJws: z.string().min(1).max(524288) })),
      async (c) =>
        c.json({
          data: await payments.attachCounterparty(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").receiptId,
            c.req.valid("json").approvalJws,
          ),
        }),
    );
  }
  if (adjustments) {
    const path = "/federation/commercial-agreements/:revisionId/adjustments";
    r.get(
      path,
      kqValidator("param", id),
      kqValidator(
        "query",
        page.extend({ recordId: z.uuid().optional(), settlementId: z.uuid().optional() }),
      ),
      async (c) => {
        const { limit, offset, recordId, settlementId } = c.req.valid("query");
        return c.json({
          data: await adjustments.list(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            limit,
            offset,
            recordId,
            settlementId,
          ),
        });
      },
    );
    r.post(
      `${path}/draft`,
      kqValidator("param", id),
      kqValidator("json", CommercialAdjustmentDraftInputSchema),
      async (c) =>
        c.json({
          data: await adjustments.draft(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("json"),
          ),
        }),
    );
    r.post(
      `${path}/approve`,
      kqValidator("param", id),
      kqValidator("json", CommercialAdjustmentSchema),
      async (c) =>
        c.json(
          {
            data: await adjustments.approve(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("json"),
            ),
          },
          201,
        ),
    );
    r.post(
      `${path}/:adjustmentId/counterparty`,
      kqValidator("param", id.extend({ adjustmentId: z.uuid() })),
      kqValidator("json", z.strictObject({ approvalJws: z.string().min(1).max(524288) })),
      async (c) =>
        c.json({
          data: await adjustments.attachCounterparty(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").adjustmentId,
            c.req.valid("json").approvalJws,
          ),
        }),
    );
  }
  if (refunds) {
    const path = "/federation/commercial-agreements/:revisionId/refunds";
    r.get(
      path,
      kqValidator("param", id),
      kqValidator("query", page.extend({ recordId: z.uuid().optional() })),
      async (c) => {
        const { limit, offset, recordId } = c.req.valid("query");
        return c.json({
          data: await refunds.list(
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
      kqValidator("json", CommercialRefundDraftInputSchema),
      async (c) => {
        const input = c.req.valid("json");
        return c.json({
          data: await refunds.draft(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            input.operationId,
            input.refundId,
            input.reason,
          ),
        });
      },
    );
    r.post(
      `${path}/approve`,
      kqValidator("param", id),
      kqValidator("json", CommercialRefundSchema),
      async (c) =>
        c.json(
          {
            data: await refunds.approve(
              c.get("federationActor"),
              c.req.valid("param").revisionId,
              c.req.valid("json"),
            ),
          },
          201,
        ),
    );
    r.post(
      `${path}/:refundId/counterparty`,
      kqValidator("param", id.extend({ refundId: z.uuid() })),
      kqValidator("json", z.strictObject({ approvalJws: z.string().min(1).max(524288) })),
      async (c) =>
        c.json({
          data: await refunds.attachCounterparty(
            c.get("federationActor"),
            c.req.valid("param").revisionId,
            c.req.valid("param").refundId,
            c.req.valid("json").approvalJws,
          ),
        }),
    );
  }
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
        id.extend({ kind: z.enum(["bill", "settlement", "refund"]), referenceId: z.uuid() }),
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
    kqValidator("query", page.extend({ arbitrationPolicyId: z.uuid().optional() })),
    async (c) => {
      const { limit, offset, arbitrationPolicyId } = c.req.valid("query");
      return c.json({
        success: true,
        data: await submissions.status(
          c.get("federationActor"),
          c.req.valid("param").revisionId,
          limit,
          offset,
          arbitrationPolicyId,
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

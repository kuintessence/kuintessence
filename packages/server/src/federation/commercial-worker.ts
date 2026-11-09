import { createLogger } from "@kuintessence/shared";
import type { FederationAccountingCollection } from "./accounting-collection";
import type { FederationAgreementExchange } from "./agreement-exchange";
import type { FederationArbitrationRevocationDelivery } from "./arbitration-revocations";
import type { FederationCaseRevocationDelivery } from "./case-revocations";
import type { FederationCaseSubmissionService } from "./case-submissions";
import type { FederationClosingAutomation } from "./closing-automation";
import type { FederationCommercialApprovalExchange } from "./commercial-approval-exchange";
import type { FederationCommercialSubmissionService } from "./commercial-submissions";
import type { FederationCompletionCapacity } from "./completion-capacity";
import type { FederationDisputeDelivery } from "./dispute-delivery";
import type { FederationDisputeFreezeExchange } from "./dispute-freeze-exchange";
import type { FederationExecutionAutomation } from "./execution-automation";
import type { FederationExecutionStopService } from "./execution-stop";
import type { FederationTerminalExchange } from "./execution-terminal-exchange";
import type { FederationMarketService } from "./market";
import type { FederationMarketRequestService } from "./market-requests";
import type { FederationReservationProposalService } from "./reservation-proposals";
import type { FederationTerminalAutomation } from "./terminal-automation";
import type { FederationUsageService } from "./usage";
import type { FederationUsageExchange } from "./usage-exchange";

const logger = createLogger("federation-commercial");
export class FederationCommercialWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly service: FederationCommercialSubmissionService,
    private readonly usage?: FederationUsageService,
    private readonly exchange?: FederationUsageExchange,
    private readonly accounting?: FederationAccountingCollection,
    private readonly market?: FederationMarketService,
    private readonly stops?: FederationExecutionStopService,
    private readonly terminals?: FederationTerminalExchange,
    private readonly terminalAutomation?: FederationTerminalAutomation,
    private readonly approvals?: FederationCommercialApprovalExchange,
    private readonly proposals?: FederationReservationProposalService,
    private readonly executionAutomation?: FederationExecutionAutomation,
    private readonly agreements?: FederationAgreementExchange,
    private readonly marketRequests?: FederationMarketRequestService,
    private readonly closing?: FederationClosingAutomation,
    private readonly completion?: FederationCompletionCapacity,
    private readonly disputes?: FederationDisputeDelivery,
    private readonly disputeFreezes?: FederationDisputeFreezeExchange,
    private readonly cases?: FederationCaseSubmissionService,
    private readonly caseRevocations?: FederationCaseRevocationDelivery,
    private readonly arbitrationRevocations?: FederationArbitrationRevocationDelivery,
  ) {}

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, 10_000);
    this.timer.unref();
    void this.tick();
  }

  tick() {
    if (this.running) return this.running;
    this.running = (async () => {
      if (this.market) {
        try {
          await this.market.reconcileClosures();
        } catch {
          logger.error(
            "Market closure observation failed; existing intents and allocations remain durable",
          );
        }
      }
      if (this.agreements) {
        try {
          await this.agreements.discover();
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.agreements.advanceNext())) break;
        } catch {
          logger.error(
            "Execution consent exchange failed; original institutional approvals remain in PostgreSQL",
          );
        }
      }
      if (this.marketRequests) {
        try {
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.marketRequests.advanceNext())) break;
        } catch {
          logger.error(
            "Automatic market requests failed; private task intents remain in PostgreSQL",
          );
        }
      }
      if (this.proposals) {
        try {
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.proposals.advanceNext())) break;
        } catch {
          logger.error(
            "Reservation proposal processing failed; original intent remains in PostgreSQL",
          );
        }
      }
      if (this.approvals) {
        try {
          await this.approvals.discover();
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.approvals.advanceNext())) break;
        } catch {
          logger.error(
            "Commercial signature exchange failed; approved records remain in PostgreSQL",
          );
        }
      }
      if (this.executionAutomation) {
        try {
          await this.executionAutomation.discover();
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.executionAutomation.advanceNext())) break;
        } catch {
          logger.error(
            "Automatic activation and execution confirmation failed; intent remains in PostgreSQL",
          );
        }
      }
      if (this.stops) {
        try {
          for (let i = 0; i < 8 && !this.stopped; i++) if (!(await this.stops.advanceNext())) break;
        } catch {
          logger.error("Execution stop delivery failed; local stop intent remains in PostgreSQL");
        }
      }
      if (this.terminals) {
        try {
          await this.terminals.discover();
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.terminals.advanceNext())) break;
        } catch {
          logger.error(
            "Terminal exchange failed; received evidence and signatures remain in PostgreSQL",
          );
        }
      }
      if (this.terminalAutomation) {
        try {
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.terminalAutomation.advanceNext())) break;
        } catch {
          logger.error(
            "Automatic terminal approval failed; institutional authority and evidence remain in PostgreSQL",
          );
        }
      }
      if (this.usage) {
        try {
          await this.usage.discover();
          for (let i = 0; i < 8 && !this.stopped; i++) if (!(await this.usage.advanceNext())) break;
        } catch {
          logger.error("Usage scan failed; original evidence remains in PostgreSQL");
        }
      }
      if (this.accounting) {
        try {
          await this.accounting.discover();
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.accounting.advanceNext())) break;
        } catch {
          logger.error("Accounting collection failed; original evidence remains in PostgreSQL");
        }
      }
      if (this.exchange) {
        try {
          await this.exchange.discover();
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.exchange.advanceNext())) break;
        } catch {
          logger.error("Usage exchange scan failed; received evidence remains in PostgreSQL");
        }
      }
      if (this.disputes) {
        try {
          await this.disputes.discover();
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.disputes.advanceNext())) break;
        } catch {
          logger.error(
            "Dispute delivery failed; original notices and local freezes remain in PostgreSQL",
          );
        }
      }
      if (this.disputeFreezes) {
        try {
          await this.disputeFreezes.discover();
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.disputeFreezes.advanceNext())) break;
        } catch {
          logger.error(
            "Dispute freeze exchange failed; original proofs and pending local freezes remain durable",
          );
        }
      }
      if (this.arbitrationRevocations) {
        try {
          await this.arbitrationRevocations.discover();
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.arbitrationRevocations.advanceNext())) break;
        } catch {
          logger.error(
            "Arbitration withdrawal delivery failed; signed notices and receipts remain durable",
          );
        }
      }
      if (this.caseRevocations) {
        try {
          await this.caseRevocations.discover();
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.caseRevocations.advanceNext())) break;
        } catch {
          logger.error(
            "Case withdrawal delivery failed; signed notices and receipts remain durable",
          );
        }
      }
      if (this.cases) {
        try {
          await this.cases.discover();
          for (let i = 0; i < 8 && !this.stopped; i++) if (!(await this.cases.advanceNext())) break;
        } catch {
          logger.error(
            "Case ledger scan failed; original signatures and recovery checkpoints remain durable",
          );
        }
      }
      if (this.closing) {
        try {
          await this.closing.discover();
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.closing.advanceNext())) break;
        } catch {
          logger.error(
            "Automatic commercial closing failed; original approvals and progress remain in PostgreSQL",
          );
        }
      }
      if (this.market) {
        try {
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.market.advanceNext())) break;
        } catch {
          logger.error(
            "Market submission failed; original intent and checkpoints remain in PostgreSQL",
          );
        }
      }
      if (this.completion) {
        try {
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.completion.advanceNext())) break;
        } catch {
          logger.error("Completion capacity reconciliation failed; allocations remain reserved");
        }
      }
      for (let i = 0; i < 8 && !this.stopped; i++) if (!(await this.service.advanceNext())) break;
    })()
      .catch(() => {
        logger.error(
          "Commercial scan failed; signed records and recovery checkpoints remain in PostgreSQL",
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}

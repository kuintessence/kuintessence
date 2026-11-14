import {
  FederationAgreementContextSchema,
  FederationCurrentCapabilitiesSchema,
} from "@kuintessence/shared/federation";
import {
  type CommercialAgreement,
  CommercialAgreementApprovalSchema,
  CommercialAgreementSummarySchema,
  CommercialSubmissionsViewSchema,
} from "@kuintessence/shared/federation/commercial";
import type { CommercialDispute } from "@kuintessence/shared/federation/disputes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ApiError, type ApiOrganizationScope, api } from "../../lib/api-client";
import { federationReadFailed } from "../../lib/federation-query-state";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { CommercialAdjustmentPanel } from "./CommercialAdjustmentPanel";
import { CommercialAutomationPanel } from "./CommercialAutomationPanel";
import { CommercialBillingPanel } from "./CommercialBillingPanel";
import { CommercialClosingPanel } from "./CommercialClosingPanel";
import { CommercialDetail } from "./CommercialDetail";
import { CommercialDisputePanel } from "./CommercialDisputePanel";
import { CommercialEditor } from "./CommercialEditor";
import { CommercialGovernancePanel } from "./CommercialGovernancePanel";
import { CommercialHistoryRecoveryImport } from "./CommercialHistoryRecoveryImport";
import { CommercialHistoryRecoveryPanel } from "./CommercialHistoryRecoveryPanel";
import { CommercialMarketRequestsPanel } from "./CommercialMarketRequestsPanel";
import { CommercialPaymentPanel } from "./CommercialPaymentPanel";
import { CommercialRefundPanel } from "./CommercialRefundPanel";
import { CommercialSettlementPanel } from "./CommercialSettlementPanel";
import { CommercialTerms } from "./CommercialTerms";
import { CommercialUsagePanel } from "./CommercialUsagePanel";
import {
  FederationEmpty,
  FederationLoadError,
  FederationPanelHeader,
  FederationRefreshNotice,
} from "./FederationLayout";

const path = "/federation/commercial-agreements";
type Action =
  | { kind: "sign"; terms: CommercialAgreement }
  | { kind: "attach"; revisionId: string; approvalJws: string }
  | { kind: "retry"; revisionId: string; submissionId: string };

export function CommercialPanel({
  scope,
  switching,
}: {
  scope: ApiOrganizationScope;
  switching: boolean;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const key = ["federation", "commercial", scope.organizationId, scope.authRevision];
  const readOnly = useMobileMutationBlocked(path);
  const [disputeSubject, setDisputeSubject] = useState<CommercialDispute["subject"] | null>(null);
  const [section, setSection] = useState("terms");
  const [recovering, setRecovering] = useState<{
    organizationId: string;
    authRevision: string | null;
    revisionId: string;
    submissionId: string;
  } | null>(null);
  const [closingRecord, setClosingRecord] = useState<{
    kind: "bill" | "settlement" | "refund";
    recordId: string;
  } | null>(null);
  const [adjustmentSettlement, setAdjustmentSettlement] = useState<string | undefined>();
  const [paymentBill, setPaymentBill] = useState<string | undefined>();
  const [settlementBill, setSettlementBill] = useState<string | undefined>();
  const [billingReport, setBillingReport] = useState<string | undefined>();
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const activeRecovery =
    recovering?.organizationId === scope.organizationId &&
    recovering.authRevision === scope.authRevision &&
    recovering.revisionId === selected
      ? recovering
      : null;
  const [creating, setCreating] = useState(false);
  const [confirmation, setConfirmation] = useState<Action | null>(null);
  const capabilities = useQuery({
    queryKey: ["federation", "current-capabilities", scope.organizationId, scope.authRevision],
    queryFn: async () =>
      FederationCurrentCapabilitiesSchema.parse(
        (await api.get<{ data: unknown }>("/federation/capabilities", scope)).data,
      ),
  });
  const grants =
    !capabilities.isError && capabilities.data?.orgId === scope.organizationId
      ? capabilities.data.effectiveCapabilities
      : [];
  const canRead = grants.includes("agreement.read");
  const openDispute =
    !readOnly && grants.includes("dispute.open")
      ? (subject: CommercialDispute["subject"]) => {
          setDisputeSubject(subject);
          setSection("disputes");
        }
      : undefined;
  const canApprove = grants.includes("agreement.approve") && !readOnly;
  const canAdjust = grants.includes("adjustment.approve") && !readOnly;
  const canSettle = grants.includes("settlement.approve") && !readOnly;
  const canPay = grants.includes("payment.approve") && !readOnly;
  const canBill = grants.includes("billing.approve") && !readOnly;
  const context = useQuery({
    queryKey: ["federation", "agreements", scope.organizationId, scope.authRevision, "context"],
    enabled: canRead,
    queryFn: async () =>
      FederationAgreementContextSchema.parse(
        (await api.get<{ data: unknown }>("/federation/agreements/context", scope)).data,
      ),
  });
  const list = useQuery({
    queryKey: [...key, "list", page],
    enabled: canRead,
    queryFn: async () =>
      z
        .array(CommercialAgreementSummarySchema)
        .parse(
          (await api.get<{ data: unknown }>(`${path}?limit=20&offset=${page * 20}`, scope)).data,
        ),
  });
  const detail = useQuery({
    queryKey: [...key, "detail", selected],
    enabled: canRead && !!selected && !!context.data,
    queryFn: async () => {
      const row = CommercialAgreementApprovalSchema.parse(
        (await api.get<{ data: unknown }>(`${path}/${selected}`, scope)).data,
      );
      if (
        row.localOrgId !== scope.organizationId ||
        row.localSiteId !== context.data?.localSiteId ||
        row.revisionId !== selected
      )
        throw new Error("Commercial scope mismatch");
      return row;
    },
  });
  const requiresLedger =
    detail.data?.terms.agreement.mode !== "bilateral_direct" && !!detail.data?.counterpartyJws;
  const submissions = useQuery({
    queryKey: [...key, "submissions", selected],
    enabled: canRead && !!selected && !detail.isError && requiresLedger,
    queryFn: async () =>
      CommercialSubmissionsViewSchema.parse(
        (
          await api.get<{ data: unknown }>(
            `${path}/${selected}/submissions?limit=100&offset=0`,
            scope,
          )
        ).data,
      ),
    refetchInterval: (query) =>
      query.state.data?.submissions.some((item) => item.state === "pending") ? 10000 : false,
    refetchIntervalInBackground: false,
  });
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      if (!canApprove || switching) throw new Error("Commercial approval is unavailable");
      if (action.kind === "sign") await api.post(`${path}/approve`, { terms: action.terms }, scope);
      else if (action.kind === "attach")
        await api.post(
          `${path}/${action.revisionId}/counterparty`,
          { approvalJws: action.approvalJws },
          scope,
        );
      else
        await api.post(
          `${path}/${action.revisionId}/submissions/${action.submissionId}/retry`,
          {},
          scope,
        );
    },
    onSuccess: async (_, action) => {
      setConfirmation(null);
      setCreating(false);
      if (action.kind === "sign") {
        setSelected(action.terms.agreement.agreementRevisionId);
        setSection("terms");
        setClosingRecord(null);
        setBillingReport(undefined);
        setSettlementBill(undefined);
        setPaymentBill(undefined);
        setAdjustmentSettlement(undefined);
      }
      await client.invalidateQueries({ queryKey: key });
    },
  });
  const busy =
    switching ||
    mutation.isPending ||
    capabilities.isFetching ||
    context.isFetching ||
    context.isError ||
    !context.data;
  const confirm = (action: Action) => {
    mutation.reset();
    setConfirmation(action);
  };
  const refresh = () => {
    void capabilities.refetch();
    void context.refetch();
    void client.invalidateQueries({ queryKey: key });
  };
  if (capabilities.isPending) return <p role="status">{t("federation.loading")}</p>;
  if (capabilities.isError)
    return (
      <div role="alert">
        <p>{t("federation.loadFailed")}</p>
        <Button variant="outline" onClick={refresh}>
          {t("federation.refresh")}
        </Button>
      </div>
    );
  if (!canRead)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("federation.agreements.noPermission")}
      </p>
    );
  return (
    <div className="space-y-5">
      <FederationRefreshNotice query={list} onRetry={() => void list.refetch()} />
      <FederationPanelHeader title={t("federation.commercial.title")}>
        {canApprove && !creating && !selected ? (
          <Button
            disabled={busy}
            onClick={() => {
              setCreating(true);
              setSelected(null);
            }}
          >
            {t("federation.commercial.newContract")}
          </Button>
        ) : null}
      </FederationPanelHeader>
      {readOnly ? (
        <p className="text-sm text-muted-foreground">{t("federation.agreements.desktopOnly")}</p>
      ) : null}
      {context.isError ? (
        <FederationLoadError
          onRetry={() => void context.refetch()}
          message={t(
            context.error instanceof ApiError && context.error.status === 404
              ? "federation.agreements.notConfigured"
              : "federation.loadFailed",
          )}
        />
      ) : null}
      {creating && context.data && canApprove ? (
        <CommercialEditor
          scope={scope}
          localSiteId={context.data.localSiteId}
          disabled={busy}
          onReview={(terms) => confirm({ kind: "sign", terms })}
          onCancel={() => setCreating(false)}
        />
      ) : selected ? (
        <>
          <Button
            className="self-start"
            variant="ghost"
            disabled={mutation.isPending}
            onClick={() => setSelected(null)}
          >
            {t("federation.commercial.back")}
          </Button>
          {detail.isError ? (
            <FederationLoadError onRetry={() => void detail.refetch()} />
          ) : detail.isPending ? (
            <p role="status">{t("federation.loading")}</p>
          ) : (
            <Tabs
              key={detail.data.revisionId}
              value={section}
              onValueChange={(value) => {
                setSection(value);
                setDisputeSubject(null);
                setClosingRecord(null);
                setBillingReport(undefined);
                setSettlementBill(undefined);
                setPaymentBill(undefined);
                setAdjustmentSettlement(undefined);
              }}
            >
              <TabsList
                className="grid w-full max-w-full grid-cols-1 items-start gap-4 rounded-none border-b border-border bg-transparent p-0 pb-4 sm:grid sm:w-full sm:grid-cols-3"
                aria-label={t("federation.usage.contractSections")}
              >
                <fieldset className="min-w-0">
                  <legend className="mb-2 text-xs font-medium text-muted-foreground">
                    {t("federation.commercial.sectionGroups.contract")}
                  </legend>
                  <div className="flex flex-wrap gap-1">
                    <TabsTrigger
                      value="terms"
                      className="min-h-10 whitespace-normal px-3 py-2 text-sm"
                    >
                      {t("federation.commercial.terms")}
                    </TabsTrigger>
                    <TabsTrigger
                      value="governance"
                      className="min-h-10 whitespace-normal px-3 py-2 text-sm"
                    >
                      {t("federation.governance.title")}
                    </TabsTrigger>
                    {detail.data.terms.agreement.mode === "ledger_coordinated" ? (
                      <>
                        <TabsTrigger
                          value="automation"
                          className="min-h-10 whitespace-normal px-3 py-2 text-sm"
                        >
                          {t("federation.automation.title")}
                        </TabsTrigger>
                        <TabsTrigger
                          value="market-requests"
                          className="min-h-10 whitespace-normal px-3 py-2 text-sm"
                        >
                          {t("federation.marketRequest.title")}
                        </TabsTrigger>
                      </>
                    ) : null}
                  </div>
                </fieldset>
                <fieldset className="min-w-0">
                  <legend className="mb-2 text-xs font-medium text-muted-foreground">
                    {t("federation.commercial.sectionGroups.accounts")}
                  </legend>
                  <div className="flex flex-wrap gap-1">
                    <TabsTrigger
                      value="usage"
                      className="min-h-10 whitespace-normal px-3 py-2 text-sm"
                    >
                      {t("federation.usage.title")}
                    </TabsTrigger>
                    <TabsTrigger
                      value="bills"
                      className="min-h-10 whitespace-normal px-3 py-2 text-sm"
                    >
                      {t("federation.billing.title")}
                    </TabsTrigger>
                    <TabsTrigger
                      value="settlements"
                      className="min-h-10 whitespace-normal px-3 py-2 text-sm"
                    >
                      {t("federation.settlement.title")}
                    </TabsTrigger>
                    <TabsTrigger
                      value="adjustments"
                      className="min-h-10 whitespace-normal px-3 py-2 text-sm"
                    >
                      {t("federation.adjustment.title")}
                    </TabsTrigger>
                    {detail.data.terms.consideration === "paid" ? (
                      <TabsTrigger
                        value="payments"
                        className="min-h-10 whitespace-normal px-3 py-2 text-sm"
                      >
                        {t("federation.payment.title")}
                      </TabsTrigger>
                    ) : null}
                    {detail.data.terms.agreement.mode !== "ledger_coordinated" ? (
                      <TabsTrigger
                        value="refunds"
                        className="min-h-10 whitespace-normal px-3 py-2 text-sm"
                      >
                        {t("federation.refund.title")}
                      </TabsTrigger>
                    ) : null}
                  </div>
                </fieldset>
                <fieldset className="min-w-0">
                  <legend className="mb-2 text-xs font-medium text-muted-foreground">
                    {t("federation.commercial.sectionGroups.resolution")}
                  </legend>
                  <div className="flex flex-wrap gap-1">
                    {grants.includes("dispute.read") ||
                    grants.includes("dispute.open") ||
                    grants.includes("dispute.resolve") ? (
                      <TabsTrigger
                        value="disputes"
                        className="min-h-10 whitespace-normal px-3 py-2 text-sm"
                      >
                        {t("federation.dispute.title")}
                      </TabsTrigger>
                    ) : null}
                    <TabsTrigger
                      value="closing"
                      className="min-h-10 whitespace-normal px-3 py-2 text-sm"
                    >
                      {t("federation.closing.title")}
                    </TabsTrigger>
                  </div>
                </fieldset>
              </TabsList>
              <TabsContent value="terms">
                <CommercialDetail
                  approval={detail.data}
                  writable={canApprove}
                  busy={busy || detail.isFetching}
                  submissions={submissions.data}
                  loadingSubmissions={requiresLedger && submissions.isPending}
                  failedSubmissions={requiresLedger && submissions.isError}
                  onAttach={(approvalJws) =>
                    confirm({ kind: "attach", revisionId: detail.data.revisionId, approvalJws })
                  }
                  onRetry={(submissionId) =>
                    confirm({ kind: "retry", revisionId: detail.data.revisionId, submissionId })
                  }
                  onRecoverHistory={
                    !readOnly &&
                    grants.includes("attestation.recover") &&
                    detail.data.terms.agreement.mode === "bilateral_attested"
                      ? (submissionId) =>
                          setRecovering({
                            organizationId: scope.organizationId,
                            authRevision: scope.authRevision,
                            revisionId: detail.data.revisionId,
                            submissionId,
                          })
                      : undefined
                  }
                />
                <CommercialHistoryRecoveryImport
                  key={`${scope.organizationId}:${scope.authRevision}:${detail.data.revisionId}`}
                  approval={detail.data}
                  scope={scope}
                  writable={
                    !readOnly &&
                    grants.includes("attestation.recover") &&
                    detail.data.terms.agreement.mode === "bilateral_attested" &&
                    !activeRecovery
                  }
                  busy={busy || detail.isFetching}
                  onImported={(submissionId) =>
                    setRecovering({
                      organizationId: scope.organizationId,
                      authRevision: scope.authRevision,
                      revisionId: detail.data.revisionId,
                      submissionId,
                    })
                  }
                />
                {activeRecovery && grants.includes("attestation.recover") ? (
                  <CommercialHistoryRecoveryPanel
                    approval={detail.data}
                    scope={scope}
                    submissionId={activeRecovery.submissionId}
                    grants={grants}
                    readOnly={readOnly}
                    busy={busy || detail.isFetching}
                    onClose={() => setRecovering(null)}
                  />
                ) : null}
              </TabsContent>
              <TabsContent value="market-requests">
                <CommercialMarketRequestsPanel
                  approval={detail.data}
                  scope={scope}
                  grants={grants}
                  readOnly={readOnly}
                  busy={busy || detail.isFetching}
                />
              </TabsContent>
              <TabsContent value="automation">
                <CommercialAutomationPanel
                  approval={detail.data}
                  scope={scope}
                  grants={grants}
                  writable={canApprove}
                  busy={busy || detail.isFetching}
                />
              </TabsContent>
              <TabsContent value="usage">
                <CommercialUsagePanel
                  onOpenDispute={openDispute}
                  key={`${scope.organizationId}:${scope.authRevision}:${detail.data.revisionId}`}
                  onDraftBill={
                    canBill
                      ? (reportId) => {
                          setBillingReport(reportId);
                          setSection("bills");
                        }
                      : undefined
                  }
                  approval={detail.data}
                  scope={scope}
                  writable={canApprove}
                  busy={busy || detail.isFetching}
                />
              </TabsContent>
              <TabsContent value="bills">
                <CommercialBillingPanel
                  onOpenDispute={openDispute}
                  approval={detail.data}
                  scope={scope}
                  writable={canBill}
                  busy={busy || detail.isFetching}
                  recordId={closingRecord?.kind === "bill" ? closingRecord.recordId : undefined}
                  reportId={billingReport}
                  onOpenPayments={
                    detail.data.terms.consideration === "paid"
                      ? (billId) => {
                          setPaymentBill(billId);
                          setSection("payments");
                        }
                      : undefined
                  }
                  onDraftSettlement={
                    canSettle
                      ? (billId) => {
                          setSettlementBill(billId);
                          setSection("settlements");
                        }
                      : undefined
                  }
                />
              </TabsContent>
              <TabsContent value="settlements">
                <CommercialSettlementPanel
                  onOpenDispute={openDispute}
                  approval={detail.data}
                  scope={scope}
                  writable={canSettle}
                  busy={busy || detail.isFetching}
                  recordId={
                    closingRecord?.kind === "settlement" ? closingRecord.recordId : undefined
                  }
                  billId={settlementBill}
                  onOpenAdjustments={(settlementId) => {
                    setAdjustmentSettlement(settlementId);
                    setSection("adjustments");
                  }}
                />
              </TabsContent>
              <TabsContent value="refunds">
                <CommercialRefundPanel
                  approval={detail.data}
                  scope={scope}
                  writable={canSettle}
                  busy={busy || detail.isFetching}
                  recordId={closingRecord?.kind === "refund" ? closingRecord.recordId : undefined}
                />
              </TabsContent>
              <TabsContent value="adjustments">
                <CommercialAdjustmentPanel
                  onOpenDispute={openDispute}
                  approval={detail.data}
                  scope={scope}
                  writable={canAdjust}
                  busy={busy || detail.isFetching}
                  settlementId={adjustmentSettlement}
                  onOpenSettlement={(recordId) => {
                    setClosingRecord({ kind: "settlement", recordId });
                    setSettlementBill(undefined);
                    setPaymentBill(undefined);
                    setSection("settlements");
                  }}
                />
              </TabsContent>
              <TabsContent value="payments">
                <CommercialPaymentPanel
                  onOpenDispute={openDispute}
                  approval={detail.data}
                  scope={scope}
                  writable={canPay}
                  busy={busy || detail.isFetching}
                  billId={paymentBill}
                  onOpenBill={(recordId) => {
                    setClosingRecord({ kind: "bill", recordId });
                    setBillingReport(undefined);
                    setSection("bills");
                  }}
                />
              </TabsContent>
              <TabsContent value="disputes">
                {grants.includes("dispute.read") ||
                grants.includes("dispute.open") ||
                grants.includes("dispute.resolve") ? (
                  <CommercialDisputePanel
                    subject={disputeSubject}
                    onClearSubject={() => setDisputeSubject(null)}
                    approval={detail.data}
                    scope={scope}
                    grants={grants}
                    readOnly={readOnly}
                    busy={busy || detail.isFetching}
                  />
                ) : null}
              </TabsContent>
              <TabsContent value="governance">
                <CommercialGovernancePanel
                  approval={detail.data}
                  scope={scope}
                  grants={grants}
                  readOnly={readOnly}
                  busy={busy || detail.isFetching}
                />
              </TabsContent>
              <TabsContent value="closing">
                <CommercialClosingPanel
                  approval={detail.data}
                  scope={scope}
                  canBill={canBill}
                  canSettle={canSettle}
                  busy={busy || detail.isFetching}
                  onOpenRecord={(kind, recordId) => {
                    setClosingRecord({ kind, recordId });
                    setBillingReport(undefined);
                    setSettlementBill(undefined);
                    setPaymentBill(undefined);
                    setAdjustmentSettlement(undefined);
                    setSection(
                      kind === "bill" ? "bills" : kind === "refund" ? "refunds" : "settlements",
                    );
                  }}
                />
              </TabsContent>
            </Tabs>
          )}
        </>
      ) : federationReadFailed(list) ? (
        <FederationLoadError onRetry={() => void list.refetch()} />
      ) : list.isPending || !list.data ? (
        <p role="status">{t("federation.loading")}</p>
      ) : (
        <>
          {list.data.length ? (
            <ul className="federation-list divide-y divide-border">
              {list.data.map((row) => (
                <li key={row.revisionId}>
                  <button
                    type="button"
                    className="federation-list-row flex w-full flex-col gap-3 p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:flex-row sm:justify-between"
                    onClick={() => {
                      setSelected(row.revisionId);
                      setDisputeSubject(null);
                      setSection("terms");
                      setClosingRecord(null);
                      setBillingReport(undefined);
                      setSettlementBill(undefined);
                      setPaymentBill(undefined);
                      setAdjustmentSettlement(undefined);
                    }}
                  >
                    <span className="min-w-0 space-y-1">
                      <span className="block break-words font-medium">
                        {row.sourceName || row.sourceSiteId} → {row.targetName || row.targetSiteId}
                      </span>
                      <time
                        dateTime={row.createdAt}
                        className="block text-xs text-muted-foreground"
                      >
                        {new Date(row.createdAt).toLocaleDateString()}
                      </time>
                    </span>
                    <span className="shrink-0 text-sm">
                      <span className="block">
                        {t(`federation.commercial.considerations.${row.consideration}`)}
                      </span>
                      <span className="block text-muted-foreground">
                        {t(
                          row.hasCounterpartyApproval
                            ? "federation.agreements.bothSigned"
                            : "federation.agreements.awaitingSignature",
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <FederationEmpty>{t("federation.commercial.empty")}</FederationEmpty>
          )}
          {page > 0 || list.data.length === 20 ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={page === 0 || list.isFetching}
                onClick={() => setPage(page - 1)}
              >
                {t("federation.previous")}
              </Button>
              <Button
                variant="outline"
                disabled={list.data.length < 20 || list.isFetching}
                onClick={() => setPage(page + 1)}
              >
                {t("federation.next")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) {
            setConfirmation(null);
            mutation.reset();
          }
        }}
      >
        <DialogContent
          dismissible={!mutation.isPending}
          outsideDismissPolicy="never"
          className="sm:max-w-3xl"
        >
          <DialogHeader>
            <DialogTitle>
              {t(`federation.commercial.actions.${confirmation?.kind ?? "sign"}`)}
            </DialogTitle>
            <DialogDescription>
              {t(
                confirmation?.kind === "retry"
                  ? "federation.commercial.retryEffect"
                  : "federation.commercial.noExecution",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {confirmation?.kind === "sign" ? (
              <CommercialTerms terms={confirmation.terms} />
            ) : (
              <p className="break-all font-mono text-sm">{confirmation?.revisionId}</p>
            )}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {t("federation.agreements.saveFailed")}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => {
                  setConfirmation(null);
                  mutation.reset();
                }}
              >
                {t("federation.cancel")}
              </Button>
              <Button
                disabled={busy || !canApprove || !confirmation}
                onClick={() => confirmation && mutation.mutate(confirmation)}
              >
                {t(mutation.isPending ? "federation.saving" : "federation.confirm")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

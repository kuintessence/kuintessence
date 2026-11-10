import {
  type CommercialAdjustment,
  CommercialAdjustmentApprovalSchema,
  CommercialAdjustmentDraftInputSchema,
  CommercialAdjustmentListSchema,
  CommercialAdjustmentSchema,
  type CommercialAgreementApproval,
} from "@kuintessence/shared/federation/commercial";
import type { CommercialDispute } from "@kuintessence/shared/federation/disputes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
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
import { Input, Textarea } from "../ui/input";
import { CommercialAdjustmentTerms } from "./CommercialAdjustmentTerms";

type Action =
  | { kind: "approve"; adjustment: CommercialAdjustment }
  | { kind: "attach"; adjustmentId: string; approvalJws: string }
  | { kind: "retry"; submissionId: string };

type AdjustmentProps = {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  writable: boolean;
  busy: boolean;
  onOpenDispute?: (subject: CommercialDispute["subject"]) => void;
  recordId?: string;
  settlementId?: string;
  onOpenSettlement: (id: string) => void;
};

export function CommercialAdjustmentPanel(props: AdjustmentProps) {
  return (
    <AdjustmentPanel
      key={`${props.scope.organizationId}:${props.scope.authRevision}:${props.approval.revisionId}:${props.recordId ?? ""}:${props.settlementId ?? ""}`}
      {...props}
    />
  );
}

function AdjustmentPanel({
  approval,
  scope,
  writable,
  busy,
  settlementId,
  recordId,
  onOpenSettlement,
  onOpenDispute,
}: AdjustmentProps) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const id = useId();
  const canWrite = useRef(writable);
  const returnFocus = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  canWrite.current = writable;
  const base = `/federation/commercial-agreements/${approval.revisionId}`;
  const key = [
    "federation",
    "commercial",
    scope.organizationId,
    scope.authRevision,
    "adjustments",
    approval.revisionId,
  ];
  const provider = approval.localSiteId === approval.terms.agreement.targetSiteId;
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(recordId ?? null);
  const [filter, setFilter] = useState(recordId);
  const [creating, setCreating] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [settlement, setSettlement] = useState(settlementId ?? "");
  const [json, setJson] = useState("");
  const [signature, setSignature] = useState("");
  const [draft, setDraft] = useState<CommercialAdjustment | null>(null);
  const [intent, setIntent] = useState<Action | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!writable) {
      setIntent(null);
      setDraft(null);
      setCreating(false);
      setJson("");
      setSignature("");
      setAmount("");
      setReason("");
      setEvidence("");
    }
  }, [writable]);
  const checkAdjustment = (adjustment: CommercialAdjustment) => {
    const contract = approval.terms;
    if (
      (settlementId !== undefined && adjustment.settlementId !== settlementId) ||
      adjustment.domainId !== contract.domainId ||
      adjustment.agreementRevisionId !== approval.revisionId ||
      adjustment.sourceSiteId !== contract.agreement.sourceSiteId ||
      adjustment.targetSiteId !== contract.agreement.targetSiteId ||
      adjustment.unit !== contract.agreement.unit
    )
      throw new Error("Adjustment scope mismatch");
    return adjustment;
  };
  const list = useQuery({
    queryKey: [...key, page, filter, settlementId],
    enabled: !!approval.counterpartyJws,
    queryFn: async () => {
      const value = CommercialAdjustmentListSchema.parse(
        (
          await api.get<{ data: unknown }>(
            `${base}/adjustments?limit=20&offset=${page * 20}${filter ? `&recordId=${encodeURIComponent(filter)}` : ""}${settlementId ? `&settlementId=${encodeURIComponent(settlementId)}` : ""}`,
            scope,
          )
        ).data,
      );
      for (const { adjustment } of value.data) {
        if (
          (filter !== undefined && adjustment.adjustmentId !== filter) ||
          (settlementId !== undefined && adjustment.settlementId !== settlementId) ||
          adjustment.localOrgId !== scope.organizationId ||
          adjustment.localSiteId !== approval.localSiteId ||
          adjustment.agreementRevisionId !== approval.revisionId ||
          adjustment.adjustmentId !== adjustment.payload.adjustmentId ||
          adjustment.settlementId !== adjustment.payload.settlementId
        )
          throw new Error("Adjustment scope mismatch");
        checkAdjustment(adjustment.payload);
      }
      if (settlementId && value.summary?.settlementId !== settlementId)
        throw new Error("Adjustment summary scope mismatch");
      return value;
    },
    refetchInterval: intent || creating || signature ? false : 10000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
  });
  const generate = useMutation({
    mutationFn: async () => {
      if (!writable || busy) throw new Error("Adjustment drafting unavailable");
      const input = CommercialAdjustmentDraftInputSchema.parse({
        settlementId: settlement.trim(),
        adjustmentId: crypto.randomUUID(),
        chargedAmount: amount,
        reason,
        supportingEvidenceDigest: evidence.trim() || null,
      });
      const draft = checkAdjustment(
        CommercialAdjustmentSchema.parse(
          (await api.post<{ data: unknown }>(`${base}/adjustments/draft`, input, scope)).data,
        ),
      );
      if (
        draft.settlementId !== input.settlementId ||
        draft.adjustmentId !== input.adjustmentId ||
        draft.chargedAmount !== input.chargedAmount ||
        draft.reason !== input.reason ||
        draft.supportingEvidenceDigest !== input.supportingEvidenceDigest
      )
        throw new Error("Draft identity mismatch");
      return draft;
    },
    onSuccess: (adjustment) => {
      if (!canWrite.current) return;
      setDraft(adjustment);
      setMessage(null);
    },
  });
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      if (!writable || busy) throw new Error("Adjustment approval unavailable");
      if (action.kind === "approve") {
        checkAdjustment(action.adjustment);
        const saved = CommercialAdjustmentApprovalSchema.parse(
          (
            await api.post<{ data: unknown }>(
              `${base}/adjustments/approve`,
              action.adjustment,
              scope,
            )
          ).data,
        );
        if (
          saved.adjustmentId !== action.adjustment.adjustmentId ||
          saved.localOrgId !== scope.organizationId ||
          saved.localSiteId !== approval.localSiteId ||
          saved.agreementRevisionId !== approval.revisionId ||
          saved.settlementId !== action.adjustment.settlementId ||
          JSON.stringify(saved.payload) !== JSON.stringify(action.adjustment)
        )
          throw new Error("Adjustment approval scope mismatch");
      } else if (action.kind === "attach") {
        const saved = CommercialAdjustmentApprovalSchema.parse(
          (
            await api.post<{ data: unknown }>(
              `${base}/adjustments/${action.adjustmentId}/counterparty`,
              { approvalJws: action.approvalJws },
              scope,
            )
          ).data,
        );
        checkAdjustment(saved.payload);
        if (
          saved.adjustmentId !== action.adjustmentId ||
          saved.payload.adjustmentId !== action.adjustmentId ||
          saved.settlementId !== saved.payload.settlementId ||
          saved.localOrgId !== scope.organizationId ||
          saved.localSiteId !== approval.localSiteId ||
          saved.agreementRevisionId !== approval.revisionId ||
          saved.counterpartyJws !== action.approvalJws
        )
          throw new Error("Adjustment attachment scope mismatch");
      } else await api.post(`${base}/submissions/${action.submissionId}/retry`, {}, scope);
    },
    onSuccess: async () => {
      setIntent(null);
      setDraft(null);
      setJson("");
      setSignature("");
      setCreating(false);
      setPage(0);
      setSelected(null);
      setFilter(undefined);
      await client.invalidateQueries({ queryKey: key });
    },
  });
  const blocked = busy || mutation.isPending || generate.isPending || list.isError;
  const review = (action: Action) => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mutation.reset();
    setMessage(null);
    setIntent(action);
  };
  const exportAdjustment = (adjustment: CommercialAdjustment) => {
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(adjustment, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `adjustment-${adjustment.adjustmentId}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(null);
    } catch {
      setMessage(t("federation.commercial.exportFailed"));
    }
  };
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(t("federation.agreements.copied"));
    } catch {
      setMessage(t("federation.agreements.copyFailed"));
    }
  };
  const current = !list.isError
    ? list.data?.data.find((row) => row.adjustment.adjustmentId === selected)
    : undefined;
  const ledgerLabel = (row: NonNullable<typeof current>) => {
    const mode = approval.terms.agreement.mode;
    if (mode === "bilateral_direct") return t("federation.billing.states.direct");
    if (row.ledger) return t(`federation.billing.states.${row.ledger.state}`);
    if (!provider && mode === "bilateral_attested")
      return t("federation.billing.states.remoteLedger");
    return t(
      row.adjustment.arbitrationDecisionId || row.adjustment.counterpartyJws
        ? "federation.settlement.notQueued"
        : "federation.billing.states.awaitingSignatures",
    );
  };
  if (!approval.counterpartyJws)
    return <p className="text-sm">{t("federation.agreements.awaitingSignature")}</p>;
  return (
    <section
      ref={panel}
      aria-label={t("federation.adjustment.title")}
      tabIndex={-1}
      className="space-y-5"
    >
      <div className="flex flex-wrap justify-end gap-2">
        {writable && !creating ? (
          <Button
            disabled={blocked}
            onClick={() => {
              setCreating(true);
              setSelected(null);
              setFilter(undefined);
              setMessage(null);
            }}
          >
            {t("federation.adjustment.newAdjustment")}
          </Button>
        ) : null}
      </div>
      {settlementId ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="break-all">
            {t("federation.settlement.settlementId")}: {settlementId}
          </span>
          <Button variant="outline" onClick={() => onOpenSettlement(settlementId)}>
            {t("federation.adjustment.openSettlement")}
          </Button>
        </div>
      ) : null}
      {!list.isError && list.data?.summary ? (
        <dl className="grid max-w-xl gap-4 sm:grid-cols-2 text-sm tabular-nums">
          <div>
            <dt className="text-muted-foreground">{t("federation.adjustment.originalCharge")}</dt>
            <dd className="mt-1 break-all">
              {list.data.summary.originalChargedAmount} {approval.terms.agreement.unit}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("federation.adjustment.currentCharge")}</dt>
            <dd className="mt-1 break-all font-semibold">
              {list.data.summary.currentChargedAmount === null
                ? t("federation.settlement.notApplied")
                : `${list.data.summary.currentChargedAmount} ${approval.terms.agreement.unit}`}
            </dd>
          </div>
        </dl>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {list.isError ? <p role="alert">{t("federation.loadFailed")}</p> : null}
      {filter && !current ? (
        <Button
          variant="ghost"
          onClick={() => {
            setFilter(undefined);
            setSelected(null);
          }}
        >
          {t("federation.adjustment.back")}
        </Button>
      ) : null}
      {creating && writable ? (
        <div className="space-y-5">
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="ghost"
              disabled={blocked}
              onClick={() => {
                setCreating(false);
                setDraft(null);
                setJson("");
              }}
            >
              {t("federation.adjustment.back")}
            </Button>
            {draft ? (
              <Button variant="outline" onClick={() => exportAdjustment(draft)}>
                {t("federation.adjustment.exportAdjustment")}
              </Button>
            ) : null}
          </div>
          {draft ? (
            <>
              <CommercialAdjustmentTerms adjustment={draft} />
              <Button
                disabled={blocked}
                onClick={() => review({ kind: "approve", adjustment: draft })}
              >
                {t("federation.billing.review")}
              </Button>
            </>
          ) : (
            <>
              <form
                className="grid max-w-xl gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  generate.mutate();
                }}
              >
                <label htmlFor={`${id}-settlement`} className="text-sm font-medium">
                  {t("federation.settlement.settlementId")}
                </label>
                <Input
                  id={`${id}-settlement`}
                  value={settlement}
                  maxLength={36}
                  disabled={blocked || !!settlementId}
                  onChange={(e) => setSettlement(e.target.value)}
                  required
                />
                <label htmlFor={`${id}-amount`} className="text-sm font-medium">
                  {t("federation.adjustment.chargedAmount")} ({approval.terms.agreement.unit})
                </label>
                <Input
                  id={`${id}-amount`}
                  value={amount}
                  inputMode="numeric"
                  maxLength={38}
                  disabled={blocked}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
                <label htmlFor={`${id}-reason`} className="text-sm font-medium">
                  {t("federation.adjustment.reason")}
                </label>
                <Textarea
                  id={`${id}-reason`}
                  value={reason}
                  maxLength={4096}
                  disabled={blocked}
                  onChange={(e) => setReason(e.target.value)}
                  required
                />
                <label htmlFor={`${id}-evidence`} className="text-sm font-medium">
                  {t("federation.adjustment.evidenceOptional")}
                </label>
                <Input
                  id={`${id}-evidence`}
                  value={evidence}
                  maxLength={71}
                  disabled={blocked}
                  onChange={(e) => setEvidence(e.target.value)}
                />
                {generate.isError ? (
                  <p role="alert" className="text-sm text-status-failed">
                    {t("federation.adjustment.draftFailed")}
                  </p>
                ) : null}
                <Button
                  className="justify-self-start"
                  disabled={
                    blocked ||
                    !CommercialAdjustmentDraftInputSchema.safeParse({
                      settlementId: settlement.trim(),
                      adjustmentId: "00000000-0000-4000-8000-000000000000",
                      chargedAmount: amount,
                      reason,
                      supportingEvidenceDigest: evidence.trim() || null,
                    }).success
                  }
                >
                  {t("federation.billing.generate")}
                </Button>
              </form>
              <div className="space-y-3 border-t border-border pt-4">
                <label htmlFor={`${id}-json`} className="block text-sm font-medium">
                  {t("federation.adjustment.importJson")}
                </label>
                <Textarea
                  id={`${id}-json`}
                  rows={7}
                  maxLength={524288}
                  value={json}
                  disabled={blocked}
                  onChange={(e) => setJson(e.target.value)}
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  disabled={blocked || !json.trim()}
                  onClick={() => {
                    try {
                      setDraft(checkAdjustment(CommercialAdjustmentSchema.parse(JSON.parse(json))));
                      setMessage(null);
                    } catch {
                      setMessage(t("federation.adjustment.invalidAdjustment"));
                    }
                  }}
                >
                  {t("federation.billing.readBill")}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : current ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="ghost"
              disabled={mutation.isPending}
              onClick={() => {
                setSelected(null);
                setFilter(undefined);
                setSignature("");
              }}
            >
              {t("federation.adjustment.back")}
            </Button>
            <Button variant="outline" onClick={() => exportAdjustment(current.adjustment.payload)}>
              {t("federation.adjustment.exportAdjustment")}
            </Button>
          </div>
          <dl className="grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-muted-foreground">
                {t("federation.adjustment.confirmation")}
              </dt>
              <dd className="mt-1 text-sm font-medium">
                {t(
                  current.adjustment.arbitrationDecisionId
                    ? "federation.settlement.arbitrated"
                    : current.adjustment.counterpartyJws
                      ? "federation.billing.bothSigned"
                      : "federation.billing.localSigned",
                )}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t("federation.commercial.ledger")}</dt>
              <dd className="mt-1 text-sm font-medium">{ledgerLabel(current)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">
                {t("federation.settlement.accounting")}
              </dt>
              <dd className="mt-1 text-sm font-medium">
                {t(
                  current.adjustment.appliedAt
                    ? "federation.settlement.applied"
                    : "federation.settlement.notApplied",
                )}
                {current.adjustment.appliedAt ? (
                  <time
                    dateTime={current.adjustment.appliedAt}
                    className="mt-1 block text-muted-foreground"
                  >
                    {new Date(current.adjustment.appliedAt).toLocaleString(i18n.language)}
                  </time>
                ) : null}
              </dd>
            </div>
          </dl>
          {current.ledger?.lastError ? (
            <p role="status" className="break-words text-sm">
              {t("federation.commercial.checkConfiguration")}{" "}
              <code>{current.ledger.lastError}</code>
            </p>
          ) : null}
          {writable && current.ledger?.state === "needs_review" ? (
            <Button
              variant="outline"
              disabled={blocked}
              onClick={() => {
                if (current.ledger) review({ kind: "retry", submissionId: current.ledger.id });
              }}
            >
              {t("federation.commercial.actions.retry")}
            </Button>
          ) : null}
          {onOpenDispute ? (
            <Button
              variant="outline"
              disabled={blocked}
              onClick={() =>
                onOpenDispute({
                  recordType: "adjustment",
                  recordId: current.adjustment.adjustmentId,
                  recordDigest: current.adjustment.digest,
                })
              }
            >
              {t("federation.dispute.openCase")}
            </Button>
          ) : null}
          <CommercialAdjustmentTerms adjustment={current.adjustment.payload} />
          <dl className="text-sm">
            <dt className="text-muted-foreground">{t("federation.adjustment.heldAmount")}</dt>
            <dd className="mt-1 break-all tabular-nums">
              {current.adjustment.heldAmount} {current.adjustment.payload.unit}
            </dd>
          </dl>
          {!settlementId ? (
            <Button
              variant="outline"
              onClick={() => onOpenSettlement(current.adjustment.settlementId)}
            >
              {t("federation.adjustment.openSettlement")}
            </Button>
          ) : null}
          {!current.adjustment.arbitrationDecisionId && (
            <details className="space-y-3 border-t border-border pt-4 text-sm">
              <summary className="cursor-pointer">{t("federation.billing.signatures")}</summary>
              <Button
                variant="outline"
                onClick={() => {
                  if (current.adjustment.approvalJws) void copy(current.adjustment.approvalJws);
                }}
              >
                {t("federation.agreements.copySignature")}
              </Button>
              {current.adjustment.counterpartyJws ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (current.adjustment.counterpartyJws)
                      void copy(current.adjustment.counterpartyJws);
                  }}
                >
                  {t("federation.billing.copyCounterparty")}
                </Button>
              ) : writable ? (
                <div className="space-y-3">
                  <label htmlFor={`${id}-signature`} className="block">
                    {t("federation.agreements.counterpartySignature")}
                  </label>
                  <Textarea
                    id={`${id}-signature`}
                    value={signature}
                    maxLength={524288}
                    rows={4}
                    disabled={blocked}
                    onChange={(e) => setSignature(e.target.value)}
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    disabled={blocked || !signature.trim()}
                    onClick={() =>
                      review({
                        kind: "attach",
                        adjustmentId: current.adjustment.adjustmentId,
                        approvalJws: signature.trim(),
                      })
                    }
                  >
                    {t("federation.commercial.actions.attach")}
                  </Button>
                </div>
              ) : null}
            </details>
          )}
        </div>
      ) : list.isPending ? (
        <p role="status">{t("federation.loading")}</p>
      ) : !list.isError ? (
        <>
          {list.data?.data.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {list.data.data.map((row) => (
                <li key={row.adjustment.adjustmentId}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-2 p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:flex-row sm:justify-between"
                    onClick={() => {
                      setSelected(row.adjustment.adjustmentId);
                      setSignature("");
                      setMessage(null);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block break-all font-medium tabular-nums">
                        {row.adjustment.payload.previousChargedAmount} →{" "}
                        {row.adjustment.payload.chargedAmount} {row.adjustment.payload.unit}
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">
                        {row.adjustment.adjustmentId}
                      </span>
                      <span className="block break-words text-sm">
                        {row.adjustment.payload.reason}
                      </span>
                    </span>
                    <span className="text-sm">
                      <span className="block">
                        {t(
                          row.adjustment.arbitrationDecisionId
                            ? "federation.settlement.arbitrated"
                            : row.adjustment.counterpartyJws
                              ? "federation.billing.bothSigned"
                              : "federation.billing.localSigned",
                        )}
                      </span>
                      <time dateTime={row.adjustment.createdAt} className="text-muted-foreground">
                        {new Date(row.adjustment.createdAt).toLocaleString(i18n.language)}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-sm text-muted-foreground">{t("federation.adjustment.empty")}</p>
          )}
          {page > 0 || list.data?.hasMore ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={page === 0 || list.isFetching}
                onClick={() => setPage(page - 1)}
              >
                {t("federation.previous")}
              </Button>
              <Button
                variant="outline"
                disabled={!list.data?.hasMore || list.isFetching}
                onClick={() => setPage(page + 1)}
              >
                {t("federation.next")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      <Dialog
        open={!!intent}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) {
            setIntent(null);
            mutation.reset();
          }
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus.current;
            if (target?.isConnected && !target.matches(":disabled")) target.focus();
            else panel.current?.focus();
          }}
          dismissible={!mutation.isPending}
          outsideDismissPolicy="never"
          className="sm:max-w-3xl"
        >
          <DialogHeader>
            <DialogTitle>
              {t(`federation.adjustment.actions.${intent?.kind ?? "approve"}`)}
            </DialogTitle>
            <DialogDescription>
              {t(
                approval.terms.agreement.mode === "ledger_coordinated"
                  ? "federation.adjustment.coordinatedBoundary"
                  : "federation.adjustment.approvalBoundary",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {intent?.kind === "approve" ? (
              <CommercialAdjustmentTerms adjustment={intent.adjustment} />
            ) : null}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {t("federation.adjustment.actionFailed")}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={mutation.isPending} onClick={() => setIntent(null)}>
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={blocked || !writable}
              onClick={() => {
                if (intent) mutation.mutate(intent);
              }}
            >
              {t("federation.billing.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

import {
  type CommercialAgreementApproval,
  type CommercialSettlement,
  CommercialSettlementApprovalSchema,
  CommercialSettlementListSchema,
  CommercialSettlementSchema,
} from "@kuintessence/shared/federation/commercial";
import type { CommercialDispute } from "@kuintessence/shared/federation/disputes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
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
import { CommercialSettlementTerms } from "./CommercialSettlementTerms";
import { FederationEmpty } from "./FederationLayout";

type Action =
  | { kind: "approve"; settlement: CommercialSettlement }
  | { kind: "attach"; settlementId: string; approvalJws: string }
  | { kind: "retry"; submissionId: string };

type SettlementProps = {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  writable: boolean;
  busy: boolean;
  onOpenDispute?: (subject: CommercialDispute["subject"]) => void;
  recordId?: string;
  billId?: string;
  onOpenAdjustments?: (settlementId: string) => void;
};

export function CommercialSettlementPanel(props: SettlementProps) {
  return (
    <SettlementPanel
      key={`${props.scope.organizationId}:${props.scope.authRevision}:${props.approval.revisionId}:${props.recordId ?? ""}`}
      {...props}
    />
  );
}

function SettlementPanel({
  approval,
  scope,
  writable,
  busy,
  billId,
  recordId,
  onOpenAdjustments,
  onOpenDispute,
}: SettlementProps) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const id = useId();
  const base = `/federation/commercial-agreements/${approval.revisionId}`;
  const key = [
    "federation",
    "commercial",
    scope.organizationId,
    scope.authRevision,
    "settlements",
    approval.revisionId,
  ];
  const provider = approval.localSiteId === approval.terms.agreement.targetSiteId;
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(recordId ?? null);
  const [filter, setFilter] = useState(recordId);
  const [creating, setCreating] = useState(!!billId);
  const [bill, setBill] = useState(billId ?? "");
  const [json, setJson] = useState("");
  const [signature, setSignature] = useState("");
  const [draft, setDraft] = useState<CommercialSettlement | null>(null);
  const [intent, setIntent] = useState<Action | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!writable) {
      setIntent(null);
      setDraft(null);
      setCreating(false);
      setJson("");
      setSignature("");
    }
  }, [writable]);
  const checkSettlement = (settlement: CommercialSettlement) => {
    const contract = approval.terms;
    if (
      settlement.domainId !== contract.domainId ||
      settlement.agreementRevisionId !== approval.revisionId ||
      settlement.sourceSiteId !== contract.agreement.sourceSiteId ||
      settlement.targetSiteId !== contract.agreement.targetSiteId ||
      settlement.unit !== contract.agreement.unit ||
      (settlement.reservationId !== null) !== (contract.agreement.mode === "ledger_coordinated")
    )
      throw new Error("Settlement scope mismatch");
    return settlement;
  };
  const list = useQuery({
    queryKey: [...key, page, filter],
    enabled: !!approval.counterpartyJws,
    queryFn: async () => {
      const value = CommercialSettlementListSchema.parse(
        (
          await api.get<{ data: unknown }>(
            `${base}/settlements?limit=20&offset=${page * 20}${filter ? `&recordId=${encodeURIComponent(filter)}` : ""}`,
            scope,
          )
        ).data,
      );
      for (const { settlement } of value.data) {
        if (
          (filter !== undefined && settlement.settlementId !== filter) ||
          settlement.localOrgId !== scope.organizationId ||
          settlement.localSiteId !== approval.localSiteId ||
          settlement.agreementRevisionId !== approval.revisionId ||
          settlement.settlementId !== settlement.payload.settlementId ||
          settlement.billId !== settlement.payload.billId
        )
          throw new Error("Settlement scope mismatch");
        checkSettlement(settlement.payload);
      }
      return value;
    },
    refetchInterval: intent || creating || signature ? false : 10000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
  });
  const generate = useMutation({
    mutationFn: async () => {
      if (!writable || busy) throw new Error("Settlement drafting unavailable");
      const input = { billId: z.uuid().parse(bill.trim()), settlementId: crypto.randomUUID() };
      const draft = checkSettlement(
        CommercialSettlementSchema.parse(
          (await api.post<{ data: unknown }>(`${base}/settlements/draft`, input, scope)).data,
        ),
      );
      if (draft.billId !== input.billId || draft.settlementId !== input.settlementId)
        throw new Error("Draft identity mismatch");
      return draft;
    },
    onSuccess: (settlement) => {
      setDraft(settlement);
      setMessage(null);
    },
  });
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      if (!writable || busy) throw new Error("Settlement approval unavailable");
      if (action.kind === "approve") {
        checkSettlement(action.settlement);
        const saved = CommercialSettlementApprovalSchema.parse(
          (
            await api.post<{ data: unknown }>(
              `${base}/settlements/approve`,
              action.settlement,
              scope,
            )
          ).data,
        );
        if (
          saved.settlementId !== action.settlement.settlementId ||
          saved.localOrgId !== scope.organizationId ||
          saved.localSiteId !== approval.localSiteId ||
          saved.agreementRevisionId !== approval.revisionId ||
          saved.billId !== action.settlement.billId ||
          JSON.stringify(saved.payload) !== JSON.stringify(action.settlement)
        )
          throw new Error("Settlement approval scope mismatch");
      } else if (action.kind === "attach")
        await api.post(
          `${base}/settlements/${action.settlementId}/counterparty`,
          { approvalJws: action.approvalJws },
          scope,
        );
      else await api.post(`${base}/submissions/${action.submissionId}/retry`, {}, scope);
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
    mutation.reset();
    setMessage(null);
    setIntent(action);
  };
  const exportSettlement = (settlement: CommercialSettlement) => {
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(settlement, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `settlement-${settlement.settlementId}.json`;
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
    ? list.data?.data.find((row) => row.settlement.settlementId === selected)
    : undefined;
  const ledgerLabel = (row: NonNullable<typeof current>) => {
    const mode = approval.terms.agreement.mode;
    if (mode === "bilateral_direct") return t("federation.billing.states.direct");
    if (row.ledger) return t(`federation.billing.states.${row.ledger.state}`);
    if (!provider && mode === "bilateral_attested")
      return t("federation.billing.states.remoteLedger");
    return t(
      row.settlement.arbitrationDecisionId || row.settlement.counterpartyJws
        ? "federation.settlement.notQueued"
        : "federation.billing.states.awaitingSignatures",
    );
  };
  if (!approval.counterpartyJws)
    return <p className="text-sm">{t("federation.agreements.awaitingSignature")}</p>;
  return (
    <div className="space-y-5">
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
            {t("federation.settlement.newSettlement")}
          </Button>
        ) : null}
      </div>
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
          {t("federation.settlement.back")}
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
              {t("federation.settlement.back")}
            </Button>
            {draft ? (
              <Button variant="outline" onClick={() => exportSettlement(draft)}>
                {t("federation.settlement.exportSettlement")}
              </Button>
            ) : null}
          </div>
          {draft ? (
            <>
              <CommercialSettlementTerms settlement={draft} />
              <Button
                disabled={blocked}
                onClick={() => review({ kind: "approve", settlement: draft })}
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
                <label htmlFor={`${id}-bill`} className="text-sm font-medium">
                  {t("federation.billing.billId")}
                </label>
                <Input
                  id={`${id}-bill`}
                  value={bill}
                  maxLength={36}
                  disabled={blocked}
                  onChange={(e) => setBill(e.target.value)}
                  required
                />
                {generate.isError ? (
                  <p role="alert" className="text-sm text-status-failed">
                    {t("federation.settlement.draftFailed")}
                  </p>
                ) : null}
                <Button
                  className="justify-self-start"
                  disabled={blocked || !z.uuid().safeParse(bill.trim()).success}
                >
                  {t("federation.billing.generate")}
                </Button>
              </form>
              <div className="space-y-3 border-t border-border pt-4">
                <label htmlFor={`${id}-json`} className="block text-sm font-medium">
                  {t("federation.settlement.importJson")}
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
                      setDraft(checkSettlement(CommercialSettlementSchema.parse(JSON.parse(json))));
                      setMessage(null);
                    } catch {
                      setMessage(t("federation.settlement.invalidSettlement"));
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
              {t("federation.settlement.back")}
            </Button>
            <Button variant="outline" onClick={() => exportSettlement(current.settlement.payload)}>
              {t("federation.settlement.exportSettlement")}
            </Button>
          </div>
          <dl className="grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-muted-foreground">
                {t("federation.settlement.confirmation")}
              </dt>
              <dd className="mt-1 text-sm font-medium">
                {t(
                  current.settlement.arbitrationDecisionId
                    ? "federation.settlement.arbitrated"
                    : current.settlement.counterpartyJws
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
                  current.settlement.appliedAt
                    ? "federation.settlement.applied"
                    : "federation.settlement.notApplied",
                )}
                {current.settlement.appliedAt ? (
                  <time
                    dateTime={current.settlement.appliedAt}
                    className="mt-1 block text-muted-foreground"
                  >
                    {new Date(current.settlement.appliedAt).toLocaleString(i18n.language)}
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
                  recordType: "settlement",
                  recordId: current.settlement.settlementId,
                  recordDigest: current.settlement.digest,
                })
              }
            >
              {t("federation.dispute.openCase")}
            </Button>
          ) : null}
          <CommercialSettlementTerms settlement={current.settlement.payload} />
          {onOpenAdjustments && current.settlement.appliedAt ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onOpenAdjustments(current.settlement.settlementId)}
            >
              {t("federation.adjustment.openHistory")}
            </Button>
          ) : null}
          {!current.settlement.arbitrationDecisionId && (
            <details className="space-y-3 border-t border-border pt-4 text-sm">
              <summary className="cursor-pointer">{t("federation.billing.signatures")}</summary>
              <Button
                variant="outline"
                onClick={() => {
                  if (current.settlement.approvalJws) void copy(current.settlement.approvalJws);
                }}
              >
                {t("federation.agreements.copySignature")}
              </Button>
              {current.settlement.counterpartyJws ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (current.settlement.counterpartyJws)
                      void copy(current.settlement.counterpartyJws);
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
                        settlementId: current.settlement.settlementId,
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
                <li key={row.settlement.settlementId}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-2 p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:flex-row sm:justify-between"
                    onClick={() => {
                      setSelected(row.settlement.settlementId);
                      setSignature("");
                      setMessage(null);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block break-all font-medium tabular-nums">
                        {row.settlement.payload.chargedAmount} {row.settlement.payload.unit}
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">
                        {row.settlement.settlementId}
                      </span>
                    </span>
                    <span className="text-sm">
                      <span className="block">
                        {t(
                          row.settlement.arbitrationDecisionId
                            ? "federation.settlement.arbitrated"
                            : row.settlement.counterpartyJws
                              ? "federation.billing.bothSigned"
                              : "federation.billing.localSigned",
                        )}
                      </span>
                      <time dateTime={row.settlement.createdAt} className="text-muted-foreground">
                        {new Date(row.settlement.createdAt).toLocaleString(i18n.language)}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <FederationEmpty>{t("federation.settlement.empty")}</FederationEmpty>
          )}
          {page > 0 || list.data?.hasMore ? (
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
          dismissible={!mutation.isPending}
          outsideDismissPolicy="never"
          className="sm:max-w-3xl"
        >
          <DialogHeader>
            <DialogTitle>
              {t(`federation.settlement.actions.${intent?.kind ?? "approve"}`)}
            </DialogTitle>
            <DialogDescription>{t("federation.settlement.approvalBoundary")}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {intent?.kind === "approve" ? (
              <CommercialSettlementTerms settlement={intent.settlement} />
            ) : null}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {t("federation.settlement.actionFailed")}
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
    </div>
  );
}

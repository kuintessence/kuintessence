import {
  type CommercialAgreementApproval,
  type CommercialBill,
  CommercialBillApprovalSchema,
  CommercialBillListSchema,
  CommercialBillSchema,
} from "@kuintessence/shared/federation/commercial";
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
import { CommercialBillTerms } from "./CommercialBillTerms";

type Action =
  | { kind: "approve"; bill: CommercialBill }
  | { kind: "attach"; billId: string; approvalJws: string }
  | { kind: "retry"; submissionId: string };

type BillingProps = {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  writable: boolean;
  busy: boolean;
  recordId?: string;
  reportId?: string;
  onOpenPayments?: (billId: string) => void;
  onDraftSettlement?: (billId: string) => void;
};

export function CommercialBillingPanel(props: BillingProps) {
  return (
    <BillingPanel
      key={`${props.scope.organizationId}:${props.scope.authRevision}:${props.approval.revisionId}:${props.recordId ?? ""}`}
      {...props}
    />
  );
}

function BillingPanel({
  approval,
  scope,
  writable,
  busy,
  recordId,
  reportId,
  onDraftSettlement,
  onOpenPayments,
}: BillingProps) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const id = useId();
  const base = `/federation/commercial-agreements/${approval.revisionId}`;
  const key = [
    "federation",
    "commercial",
    scope.organizationId,
    scope.authRevision,
    "bills",
    approval.revisionId,
  ];
  const provider = approval.localSiteId === approval.terms.agreement.targetSiteId;
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(recordId ?? null);
  const [filter, setFilter] = useState(recordId);
  const [creating, setCreating] = useState(!!reportId);
  const [report, setReport] = useState(reportId ?? "");
  const [json, setJson] = useState("");
  const [signature, setSignature] = useState("");
  const [draft, setDraft] = useState<CommercialBill | null>(null);
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
  const checkBill = (bill: CommercialBill) => {
    const contract = approval.terms;
    if (
      bill.domainId !== contract.domainId ||
      bill.agreementDigest !== approval.digest ||
      bill.priceVersionId !== contract.priceVersionId ||
      bill.request.agreementRevisionId !== approval.revisionId ||
      bill.request.senderSiteId !== contract.agreement.sourceSiteId ||
      bill.request.recipientSiteId !== contract.agreement.targetSiteId ||
      bill.request.budgetDomainId !== contract.agreement.budgetDomainId ||
      bill.request.epoch !== contract.agreement.epoch ||
      bill.request.mode !== contract.agreement.mode ||
      bill.request.unit !== contract.agreement.unit ||
      new Set(bill.calculation.lines.map((line) => line.metric)).size !==
        bill.calculation.lines.length
    )
      throw new Error("Bill scope mismatch");
    return bill;
  };
  const list = useQuery({
    queryKey: [...key, page, filter],
    enabled: !!approval.counterpartyJws,
    queryFn: async () => {
      const value = CommercialBillListSchema.parse(
        (
          await api.get<{ data: unknown }>(
            `${base}/bills?limit=20&offset=${page * 20}${filter ? `&recordId=${encodeURIComponent(filter)}` : ""}`,
            scope,
          )
        ).data,
      );
      for (const { bill } of value.data) {
        if (
          (filter !== undefined && bill.billId !== filter) ||
          bill.localOrgId !== scope.organizationId ||
          bill.localSiteId !== approval.localSiteId ||
          bill.agreementRevisionId !== approval.revisionId ||
          bill.billId !== bill.payload.billId
        )
          throw new Error("Bill scope mismatch");
        checkBill(bill.payload);
      }
      return value;
    },
    refetchInterval: intent || creating ? false : 10000,
    refetchIntervalInBackground: false,
  });
  const generate = useMutation({
    mutationFn: async () => {
      if (!writable || busy || !provider) throw new Error("Bill drafting unavailable");
      const input = { reportId: z.uuid().parse(report.trim()), billId: crypto.randomUUID() };
      const draft = checkBill(
        CommercialBillSchema.parse(
          (await api.post<{ data: unknown }>(`${base}/bills/draft`, input, scope)).data,
        ),
      );
      if (draft.reportId !== input.reportId || draft.billId !== input.billId)
        throw new Error("Draft identity mismatch");
      return draft;
    },
    onSuccess: (bill) => {
      setDraft(bill);
      setMessage(null);
    },
  });
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      if (!writable || busy) throw new Error("Bill approval unavailable");
      if (action.kind === "approve") {
        checkBill(action.bill);
        const saved = CommercialBillApprovalSchema.parse(
          (await api.post<{ data: unknown }>(`${base}/bills/approve`, action.bill, scope)).data,
        );
        if (
          saved.billId !== action.bill.billId ||
          saved.localOrgId !== scope.organizationId ||
          saved.localSiteId !== approval.localSiteId ||
          saved.agreementRevisionId !== approval.revisionId
        )
          throw new Error("Bill approval scope mismatch");
      } else if (action.kind === "attach")
        await api.post(
          `${base}/bills/${action.billId}/counterparty`,
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
  const exportBill = (bill: CommercialBill) => {
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bill, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `bill-${bill.billId}.json`;
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
    ? list.data?.data.find((row) => row.bill.billId === selected)
    : undefined;
  const ledgerLabel = (row: NonNullable<typeof current>) =>
    approval.terms.agreement.mode === "bilateral_direct"
      ? "direct"
      : (row.ledger?.state ?? (provider ? "awaitingSignatures" : "remoteLedger"));
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
            {t(provider ? "federation.billing.newBill" : "federation.billing.importBill")}
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
          {t("federation.billing.back")}
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
              {t("federation.billing.back")}
            </Button>
            {draft ? (
              <Button variant="outline" onClick={() => exportBill(draft)}>
                {t("federation.billing.exportBill")}
              </Button>
            ) : null}
          </div>
          {draft ? (
            <>
              <CommercialBillTerms bill={draft} />
              <Button disabled={blocked} onClick={() => review({ kind: "approve", bill: draft })}>
                {t("federation.billing.review")}
              </Button>
            </>
          ) : (
            <>
              {provider ? (
                <form
                  className="grid max-w-xl gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    generate.mutate();
                  }}
                >
                  <label htmlFor={`${id}-report`} className="text-sm font-medium">
                    {t("federation.billing.reportId")}
                  </label>
                  <Input
                    id={`${id}-report`}
                    value={report}
                    maxLength={36}
                    disabled={blocked}
                    onChange={(e) => setReport(e.target.value)}
                    required
                  />
                  {generate.isError ? (
                    <p role="alert" className="text-sm text-status-failed">
                      {t("federation.billing.draftFailed")}
                    </p>
                  ) : null}
                  <Button
                    className="justify-self-start"
                    disabled={blocked || !z.uuid().safeParse(report.trim()).success}
                  >
                    {t("federation.billing.generate")}
                  </Button>
                </form>
              ) : null}
              <div className="space-y-3 border-t border-border pt-4">
                <label htmlFor={`${id}-json`} className="block text-sm font-medium">
                  {t("federation.billing.importJson")}
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
                      setDraft(checkBill(CommercialBillSchema.parse(JSON.parse(json))));
                      setMessage(null);
                    } catch {
                      setMessage(t("federation.billing.invalidBill"));
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
              {t("federation.billing.back")}
            </Button>
            <Button variant="outline" onClick={() => exportBill(current.bill.payload)}>
              {t("federation.billing.exportBill")}
            </Button>
          </div>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted-foreground">
                {t("federation.billing.confirmation")}
              </dt>
              <dd className="mt-1 text-sm font-medium">
                {t(
                  current.bill.counterpartyJws
                    ? "federation.billing.bothSigned"
                    : "federation.billing.localSigned",
                )}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t("federation.commercial.ledger")}</dt>
              <dd className="mt-1 text-sm font-medium">
                {t(`federation.billing.states.${ledgerLabel(current)}`)}
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
          <CommercialBillTerms bill={current.bill.payload} />
          {onDraftSettlement && current.bill.counterpartyJws ? (
            <Button disabled={blocked} onClick={() => onDraftSettlement(current.bill.billId)}>
              {t("federation.settlement.newSettlement")}
            </Button>
          ) : null}
          {onOpenPayments && current.bill.counterpartyJws ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onOpenPayments(current.bill.billId)}
            >
              {t("federation.payment.openPayments")}
            </Button>
          ) : null}
          <details className="space-y-3 border-t border-border pt-4 text-sm">
            <summary className="cursor-pointer">{t("federation.billing.signatures")}</summary>
            <Button variant="outline" onClick={() => void copy(current.bill.approvalJws)}>
              {t("federation.agreements.copySignature")}
            </Button>
            {current.bill.counterpartyJws ? (
              <Button
                variant="outline"
                onClick={() => {
                  if (current.bill.counterpartyJws) void copy(current.bill.counterpartyJws);
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
                      billId: current.bill.billId,
                      approvalJws: signature.trim(),
                    })
                  }
                >
                  {t("federation.commercial.actions.attach")}
                </Button>
              </div>
            ) : null}
          </details>
        </div>
      ) : list.isPending ? (
        <p role="status">{t("federation.loading")}</p>
      ) : !list.isError ? (
        <>
          {list.data?.data.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {list.data.data.map((row) => (
                <li key={row.bill.billId}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-2 p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:flex-row sm:justify-between"
                    onClick={() => {
                      setSelected(row.bill.billId);
                      setSignature("");
                      setMessage(null);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block break-all font-medium tabular-nums">
                        {row.bill.payload.calculation.dueAmount} {row.bill.payload.request.unit}
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">
                        {row.bill.billId}
                      </span>
                    </span>
                    <span className="text-sm">
                      <span className="block">
                        {t(
                          row.bill.counterpartyJws
                            ? "federation.billing.bothSigned"
                            : "federation.billing.localSigned",
                        )}
                      </span>
                      <time dateTime={row.bill.createdAt} className="text-muted-foreground">
                        {new Date(row.bill.createdAt).toLocaleString(i18n.language)}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-sm text-muted-foreground">{t("federation.billing.empty")}</p>
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
          dismissible={!mutation.isPending}
          outsideDismissPolicy="never"
          className="sm:max-w-3xl"
        >
          <DialogHeader>
            <DialogTitle>
              {t(`federation.billing.actions.${intent?.kind ?? "approve"}`)}
            </DialogTitle>
            <DialogDescription>{t("federation.billing.approvalBoundary")}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {intent?.kind === "approve" ? <CommercialBillTerms bill={intent.bill} /> : null}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {t("federation.billing.actionFailed")}
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

import { federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  type CommercialAgreementApproval,
  type CommercialPayment,
  CommercialPaymentApprovalSchema,
  CommercialPaymentDraftInputSchema,
  CommercialPaymentListSchema,
  CommercialPaymentSchema,
} from "@kuintessence/shared/federation/commercial";
import type { CommercialDispute } from "@kuintessence/shared/federation/disputes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ApiError, type ApiOrganizationScope, api } from "../../lib/api-client";
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
import { CommercialPaymentTerms } from "./CommercialPaymentTerms";

type Action =
  | { kind: "approve"; payment: CommercialPayment }
  | { kind: "attach"; payment: CommercialPayment; approvalJws: string }
  | { kind: "retry"; submissionId: string };
type Props = {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  writable: boolean;
  busy: boolean;
  onOpenDispute?: (subject: CommercialDispute["subject"]) => void;
  billId?: string;
  onOpenBill?: (billId: string) => void;
};
export function CommercialPaymentPanel(props: Props) {
  return (
    <PaymentPanel
      key={`${props.scope.organizationId}:${props.scope.authRevision}:${props.approval.revisionId}:${props.billId ?? ""}`}
      {...props}
    />
  );
}
function PaymentPanel({
  approval,
  scope,
  writable,
  busy,
  billId,
  onOpenBill,
  onOpenDispute,
}: Props) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const id = useId();
  const canWrite = useRef(writable);
  const mounted = useRef(true);
  const draftGeneration = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  canWrite.current = writable;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const base = `/federation/commercial-agreements/${approval.revisionId}`;
  const key = [
    "federation",
    "commercial",
    scope.organizationId,
    scope.authRevision,
    "payments",
    approval.revisionId,
  ];
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [recordFilter, setRecordFilter] = useState<string>();
  const [paymentFilter, setPaymentFilter] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [bill, setBill] = useState(billId ?? "");
  const [amount, setAmount] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [correction, setCorrection] = useState<z.infer<
    typeof CommercialPaymentApprovalSchema
  > | null>(null);
  const [json, setJson] = useState("");
  const [signature, setSignature] = useState("");
  const [draft, setDraft] = useState<CommercialPayment | null>(null);
  const [intent, setIntent] = useState<Action | null>(null);
  const [uncertain, setUncertain] = useState<Exclude<Action, { kind: "retry" }> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!writable) {
      draftGeneration.current += 1;
      setIntent(null);
      setDraft(null);
      setCreating(false);
      setJson("");
      setSignature("");
      setBill(billId ?? "");
      setAmount("");
      setOccurredAt("");
      setEvidence("");
      setReason("");
      setCorrection(null);
    }
  }, [writable, billId]);
  const checkPayment = (payment: CommercialPayment) => {
    const terms = approval.terms;
    if (
      terms.consideration !== "paid" ||
      payment.domainId !== terms.domainId ||
      payment.agreementRevisionId !== approval.revisionId ||
      payment.agreementDigest !== approval.digest ||
      payment.sourceSiteId !== terms.agreement.sourceSiteId ||
      payment.targetSiteId !== terms.agreement.targetSiteId ||
      payment.unit !== terms.agreement.unit
    )
      throw new Error("Payment scope mismatch");
    return payment;
  };
  const checkSaved = (raw: unknown) => {
    const row = CommercialPaymentApprovalSchema.parse(raw);
    if (
      row.localOrgId !== scope.organizationId ||
      row.localSiteId !== approval.localSiteId ||
      row.agreementRevisionId !== approval.revisionId ||
      row.receiptId !== row.payload.receiptId ||
      row.paymentId !== row.payload.paymentId ||
      row.billId !== row.payload.billId
    )
      throw new Error("Payment response scope mismatch");
    checkPayment(row.payload);
    return row;
  };
  const read = async (query: string) => {
    const value = CommercialPaymentListSchema.parse(
      (await api.get<{ data: unknown }>(`${base}/payments?${query}`, scope)).data,
    );
    for (const row of value.data) checkSaved(row.payment);
    return value;
  };
  const list = useQuery({
    queryKey: [...key, page, billId, paymentFilter, recordFilter],
    enabled: !!approval.counterpartyJws && approval.terms.consideration === "paid",
    queryFn: async () => {
      const query = new URLSearchParams({ limit: "20", offset: String(page * 20) });
      if (recordFilter) query.set("recordId", recordFilter);
      if (billId) query.set("billId", billId);
      if (paymentFilter) query.set("paymentId", paymentFilter);
      const value = await read(query.toString());
      for (const { payment } of value.data) {
        if (
          (recordFilter && payment.receiptId !== recordFilter) ||
          (billId && payment.billId !== billId) ||
          (paymentFilter && payment.paymentId !== paymentFilter)
        )
          throw new Error("Payment filter mismatch");
      }
      return value;
    },
    refetchInterval: creating || intent || signature || uncertain ? false : 10000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
  });
  const generate = useMutation({
    mutationFn: async () => {
      if (!canWrite.current || busy || uncertain) throw new Error("Payment drafting unavailable");
      const generation = draftGeneration.current;
      const input = CommercialPaymentDraftInputSchema.parse({
        receiptId: crypto.randomUUID(),
        paymentId: correction?.paymentId ?? crypto.randomUUID(),
        billId: bill.trim(),
        amount,
        occurredAt: new Date(occurredAt).toISOString(),
        evidenceDigest: evidence.trim(),
        reason,
      });
      const value = checkPayment(
        CommercialPaymentSchema.parse(
          (await api.post<{ data: unknown }>(`${base}/payments/draft`, input, scope)).data,
        ),
      );
      for (const field of Object.keys(input) as (keyof typeof input)[]) {
        if (value[field] !== input[field]) throw new Error("Payment draft identity mismatch");
      }
      if (
        correction
          ? value.previous?.receiptId !== correction.receiptId ||
            value.previous?.digest !== correction.digest
          : value.previous !== null
      )
        throw new Error("Payment predecessor changed");
      return { value, generation };
    },
    onSuccess: ({ value, generation }) => {
      if (mounted.current && canWrite.current && generation === draftGeneration.current) {
        setDraft(value);
        setMessage(null);
      }
    },
  });
  const finish = async (receiptId: string | null) => {
    if (!mounted.current) return;
    setIntent(null);
    setUncertain(null);
    setDraft(null);
    setJson("");
    setSignature("");
    setCreating(false);
    setCorrection(null);
    setPage(0);
    setSelected(receiptId);
    setRecordFilter(receiptId ?? undefined);
    setPaymentFilter(undefined);
    await client.invalidateQueries({ queryKey: key });
  };
  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: Action) => {
      if (!canWrite.current || busy || uncertain) throw new Error("Payment approval unavailable");
      if (action.kind === "retry") {
        z.object({ success: z.literal(true) }).parse(
          await api.post(`${base}/submissions/${action.submissionId}/retry`, {}, scope),
        );
        return selected;
      }
      checkPayment(action.payment);
      const saved = checkSaved(
        (
          await api.post<{ data: unknown }>(
            action.kind === "approve"
              ? `${base}/payments/approve`
              : `${base}/payments/${action.payment.receiptId}/counterparty`,
            action.kind === "approve" ? action.payment : { approvalJws: action.approvalJws },
            scope,
          )
        ).data,
      );
      if (
        federationCanonicalJson(saved.payload) !== federationCanonicalJson(action.payment) ||
        (action.kind === "attach" && saved.counterpartyJws !== action.approvalJws)
      )
        throw new Error("Payment write outcome unconfirmed");
      return saved.receiptId;
    },
    onSuccess: finish,
    onError: (error, action) => {
      const rejected =
        error instanceof ApiError &&
        [400, 403, 409].includes(error.status) &&
        error.code !== "HTTP_ERROR";
      if (mounted.current && action.kind !== "retry" && !rejected) {
        setUncertain(action);
        setIntent(null);
      }
    },
  });
  const reconcile = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!uncertain) throw new Error("No pending write");
      const receiptId = uncertain.payment.receiptId;
      const value = await read(`limit=20&offset=0&recordId=${encodeURIComponent(receiptId)}`);
      if (value.data.length !== 1 || value.hasMore) throw new Error("Original receipt not found");
      const saved = checkSaved(value.data[0]?.payment);
      if (
        saved.receiptId !== receiptId ||
        federationCanonicalJson(saved.payload) !== federationCanonicalJson(uncertain.payment) ||
        (uncertain.kind === "attach" && saved.counterpartyJws !== uncertain.approvalJws)
      )
        throw new Error("Original write unconfirmed");
      return receiptId;
    },
    onSuccess: finish,
  });
  const blocked = busy || mutation.isPending || generate.isPending || !!uncertain || list.isError;
  const review = (action: Action) => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mutation.reset();
    setMessage(null);
    setIntent(action);
  };
  const start = (previous: typeof correction = null) => {
    setCorrection(previous);
    setBill(previous?.billId ?? billId ?? "");
    setAmount(previous?.payload.amount ?? "");
    setOccurredAt("");
    setEvidence("");
    setReason("");
    setJson("");
    setDraft(null);
    setMessage(null);
    generate.reset();
    setCreating(true);
  };
  const exportPayment = (value: CommercialPayment) => {
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `payment-${value.receiptId}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    ? list.data?.data.find((row) => row.payment.receiptId === selected)
    : undefined;
  const state = (row: z.infer<typeof CommercialPaymentApprovalSchema>) =>
    t(
      `federation.payment.states.${row.current ? "current" : row.confirmedAt ? "superseded" : "pending"}`,
    );
  const ledgerLabel = (row: NonNullable<typeof current>) => {
    if (approval.terms.agreement.mode === "bilateral_direct")
      return t("federation.billing.states.direct");
    if (row.ledger) return t(`federation.billing.states.${row.ledger.state}`);
    if (approval.localSiteId !== approval.terms.agreement.targetSiteId)
      return t("federation.billing.states.remoteLedger");
    return t(
      row.payment.counterpartyJws
        ? "federation.settlement.notQueued"
        : "federation.billing.states.awaitingSignatures",
    );
  };
  if (approval.terms.consideration !== "paid")
    return <p role="status">{t("federation.payment.paidOnly")}</p>;
  if (!approval.counterpartyJws)
    return <p role="status">{t("federation.agreements.awaitingSignature")}</p>;
  return (
    <section
      ref={panel}
      tabIndex={-1}
      aria-label={t("federation.payment.title")}
      className="space-y-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        {billId ? (
          <p className="min-w-0 break-all text-sm">
            {t("federation.billing.billId")}: {billId}
          </p>
        ) : (
          <span />
        )}
        {writable && !creating ? (
          <Button disabled={blocked} onClick={() => start()}>
            {t("federation.payment.newPayment")}
          </Button>
        ) : null}
      </div>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {uncertain ? (
        <div role="alert" className="space-y-3 text-sm">
          <p>{t("federation.payment.unknownWrite")}</p>
          <p className="break-all">{uncertain.payment.receiptId}</p>
          <Button
            variant="outline"
            disabled={busy || reconcile.isPending}
            onClick={() => reconcile.mutate()}
          >
            {t("federation.payment.checkOriginal")}
          </Button>
          {reconcile.isError ? <p>{t("federation.payment.unconfirmed")}</p> : null}
        </div>
      ) : null}
      {list.isError ? (
        <div role="alert" className="space-y-3">
          <p>{t("federation.loadFailed")}</p>
          <Button variant="outline" disabled={list.isFetching} onClick={() => void list.refetch()}>
            {t("federation.refresh")}
          </Button>
        </div>
      ) : null}
      {creating && writable ? (
        <div className="space-y-5">
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="ghost"
              disabled={mutation.isPending || generate.isPending}
              onClick={() => {
                setCreating(false);
                setDraft(null);
                setJson("");
              }}
            >
              {t("federation.payment.back")}
            </Button>
            {draft ? (
              <Button variant="outline" onClick={() => exportPayment(draft)}>
                {t("federation.payment.export")}
              </Button>
            ) : null}
          </div>
          {draft ? (
            <>
              <CommercialPaymentTerms payment={draft} />
              <Button
                disabled={blocked}
                onClick={() => review({ kind: "approve", payment: draft })}
              >
                {t("federation.billing.review")}
              </Button>
            </>
          ) : (
            <>
              <form
                className="grid max-w-xl gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  generate.mutate();
                }}
              >
                {correction ? (
                  <p className="text-sm">{t("federation.payment.correctionBoundary")}</p>
                ) : null}
                <div className="space-y-1.5">
                  <label htmlFor={`${id}-bill`} className="text-sm font-medium">
                    {t("federation.billing.billId")}
                  </label>
                  <Input
                    id={`${id}-bill`}
                    value={bill}
                    maxLength={36}
                    disabled={blocked || !!correction || !!billId}
                    onChange={(e) => setBill(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={`${id}-amount`} className="text-sm font-medium">
                    {t("federation.payment.amount")} ({approval.terms.agreement.unit})
                  </label>
                  <Input
                    id={`${id}-amount`}
                    value={amount}
                    inputMode="numeric"
                    pattern="0|[1-9][0-9]*"
                    maxLength={100}
                    disabled={blocked}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={`${id}-time`} className="text-sm font-medium">
                    {t("federation.payment.occurredAt")}
                  </label>
                  <Input
                    id={`${id}-time`}
                    type="datetime-local"
                    value={occurredAt}
                    disabled={blocked}
                    onChange={(e) => setOccurredAt(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={`${id}-evidence`} className="text-sm font-medium">
                    {t("federation.payment.evidenceDigest")}
                  </label>
                  <Input
                    id={`${id}-evidence`}
                    value={evidence}
                    maxLength={71}
                    disabled={blocked}
                    onChange={(e) => setEvidence(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={`${id}-reason`} className="text-sm font-medium">
                    {t("federation.payment.reason")}
                  </label>
                  <Textarea
                    id={`${id}-reason`}
                    value={reason}
                    maxLength={4096}
                    disabled={blocked}
                    onChange={(e) => setReason(e.target.value)}
                    required
                  />
                </div>
                {generate.isError ? (
                  <p role="alert" className="text-sm text-status-failed">
                    {t("federation.payment.draftFailed")}
                  </p>
                ) : null}
                <Button
                  className="justify-self-start"
                  disabled={
                    blocked ||
                    !z.uuid().safeParse(bill).success ||
                    !amount ||
                    !occurredAt ||
                    !evidence ||
                    !reason.trim()
                  }
                >
                  {t("federation.billing.generate")}
                </Button>
              </form>
              <details className="space-y-3 border-t border-border pt-4 text-sm">
                <summary className="cursor-pointer">{t("federation.payment.importJson")}</summary>
                <label htmlFor={`${id}-json`} className="block">
                  {t("federation.payment.json")}
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
                      const value = checkPayment(CommercialPaymentSchema.parse(JSON.parse(json)));
                      if (billId && value.billId !== billId)
                        throw new Error("Payment bill mismatch");
                      setDraft(value);
                      setMessage(null);
                    } catch {
                      setMessage(t("federation.payment.invalid"));
                    }
                  }}
                >
                  {t("federation.billing.readBill")}
                </Button>
              </details>
            </>
          )}
        </div>
      ) : current ? (
        <div className="space-y-5">
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setSelected(null);
                setRecordFilter(undefined);
                setSignature("");
              }}
            >
              {t("federation.payment.back")}
            </Button>
            <Button variant="outline" onClick={() => exportPayment(current.payment.payload)}>
              {t("federation.payment.export")}
            </Button>
          </div>
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">{t("federation.payment.confirmation")}</dt>
              <dd className="mt-1 font-medium">
                {state(current.payment)}
                {current.payment.confirmedAt ? (
                  <time
                    className="mt-1 block font-normal text-muted-foreground"
                    dateTime={current.payment.confirmedAt}
                  >
                    {new Date(current.payment.confirmedAt).toLocaleString(i18n.language)}
                  </time>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("federation.payment.signatures")}</dt>
              <dd className="mt-1 font-medium">
                {t(
                  current.payment.counterpartyJws
                    ? "federation.billing.bothSigned"
                    : "federation.billing.localSigned",
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("federation.commercial.ledger")}</dt>
              <dd className="mt-1 font-medium">{ledgerLabel(current)}</dd>
            </div>
          </dl>
          {onOpenDispute ? (
            <Button
              variant="outline"
              disabled={blocked}
              onClick={() =>
                onOpenDispute({
                  recordType: "payment",
                  recordId: current.payment.receiptId,
                  recordDigest: current.payment.digest,
                })
              }
            >
              {t("federation.dispute.openCase")}
            </Button>
          ) : null}
          <CommercialPaymentTerms payment={current.payment.payload} />
          <div className="flex flex-wrap gap-2">
            {writable && current.payment.current ? (
              <Button disabled={blocked} onClick={() => start(current.payment)}>
                {t("federation.payment.correct")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => {
                setRecordFilter(undefined);
                setPaymentFilter(current.payment.paymentId);
                setPage(0);
                setSelected(null);
                setSignature("");
              }}
            >
              {t("federation.payment.history")}
            </Button>
            {onOpenBill ? (
              <Button variant="outline" onClick={() => onOpenBill(current.payment.billId)}>
                {t("federation.payment.openBill")}
              </Button>
            ) : null}
          </div>
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
          <details className="space-y-3 border-t border-border pt-4 text-sm">
            <summary className="cursor-pointer">{t("federation.billing.signatures")}</summary>
            <Button variant="outline" onClick={() => void copy(current.payment.approvalJws)}>
              {t("federation.agreements.copySignature")}
            </Button>
            {current.payment.counterpartyJws ? (
              <Button
                variant="outline"
                onClick={() => {
                  if (current.payment.counterpartyJws) void copy(current.payment.counterpartyJws);
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
                      payment: current.payment.payload,
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
          {paymentFilter ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <p className="break-all">
                {t("federation.payment.paymentId")}: {paymentFilter}
              </p>
              <Button
                variant="ghost"
                onClick={() => {
                  setPaymentFilter(undefined);
                  setPage(0);
                }}
              >
                {t("federation.payment.clearHistory")}
              </Button>
            </div>
          ) : null}
          {list.data?.data.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {list.data.data.map((row) => (
                <li key={row.payment.receiptId}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-2 p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:flex-row sm:justify-between"
                    onClick={() => {
                      setSelected(row.payment.receiptId);
                      setSignature("");
                      setMessage(null);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block break-all font-medium tabular-nums">
                        {row.payment.payload.amount} {row.payment.payload.unit}
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">
                        {row.payment.receiptId}
                      </span>
                    </span>
                    <span className="text-sm">
                      <span className="block">{state(row.payment)}</span>
                      <time className="text-muted-foreground" dateTime={row.payment.createdAt}>
                        {new Date(row.payment.createdAt).toLocaleString(i18n.language)}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-sm text-muted-foreground">{t("federation.payment.empty")}</p>
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
          if (!open && !mutation.isPending) setIntent(null);
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
              {t(`federation.payment.actions.${intent?.kind ?? "approve"}`)}
            </DialogTitle>
            <DialogDescription>
              {t(
                intent?.kind === "retry"
                  ? "federation.payment.retryBoundary"
                  : "federation.payment.approvalBoundary",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {intent && intent.kind !== "retry" ? (
              <CommercialPaymentTerms payment={intent.payment} />
            ) : null}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {t(
                  intent?.kind === "retry"
                    ? "federation.payment.actionFailed"
                    : "federation.payment.approvalRejected",
                )}
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

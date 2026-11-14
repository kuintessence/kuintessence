import { federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  type CommercialAgreementApproval,
  type CommercialRefund,
  CommercialRefundApprovalSchema,
  CommercialRefundDraftInputSchema,
  CommercialRefundListSchema,
  CommercialRefundSchema,
} from "@kuintessence/shared/federation/commercial";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
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
import { CommercialRefundTerms } from "./CommercialRefundTerms";
import { FederationEmpty } from "./FederationLayout";

type Action =
  | { kind: "approve"; refund: CommercialRefund }
  | { kind: "attach"; refundId: string; approvalJws: string }
  | { kind: "retry"; submissionId: string };

type RefundProps = {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  writable: boolean;
  busy: boolean;
  recordId?: string;
};

export function CommercialRefundPanel(props: RefundProps) {
  return (
    <RefundPanel
      key={`${props.scope.organizationId}:${props.scope.authRevision}:${props.approval.revisionId}:${props.recordId ?? ""}`}
      {...props}
    />
  );
}

function RefundPanel({ approval, scope, writable, busy, recordId }: RefundProps) {
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
    "refunds",
    approval.revisionId,
  ];
  const provider = approval.localSiteId === approval.terms.agreement.targetSiteId;
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(recordId ?? null);
  const [filter, setFilter] = useState(recordId);
  const [creating, setCreating] = useState(false);
  const [operation, setOperation] = useState("");
  const [reason, setReason] = useState("");
  const [json, setJson] = useState("");
  const [signature, setSignature] = useState("");
  const [draft, setDraft] = useState<CommercialRefund | null>(null);
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
  const checkRefund = (refund: CommercialRefund) => {
    const contract = approval.terms;
    if (
      refund.domainId !== contract.domainId ||
      refund.request.agreementRevisionId !== approval.revisionId ||
      refund.request.senderSiteId !== contract.agreement.sourceSiteId ||
      refund.request.recipientSiteId !== contract.agreement.targetSiteId ||
      refund.request.unit !== contract.agreement.unit ||
      refund.request.mode !== contract.agreement.mode ||
      refund.agreementDigest !== approval.digest ||
      refund.request.budgetDomainId !== contract.agreement.budgetDomainId ||
      refund.request.epoch !== contract.agreement.epoch
    )
      throw new Error("Refund scope mismatch");
    return refund;
  };
  const checkSaved = (raw: unknown) => {
    const saved = CommercialRefundApprovalSchema.parse(raw);
    if (
      saved.localOrgId !== scope.organizationId ||
      saved.localSiteId !== approval.localSiteId ||
      saved.agreementRevisionId !== approval.revisionId ||
      saved.refundId !== saved.payload.refundId ||
      saved.operationId !== saved.payload.request.operationId ||
      (saved.appliedAt && !saved.counterpartyJws)
    )
      throw new Error("Refund response scope mismatch");
    checkRefund(saved.payload);
    return saved;
  };
  const list = useQuery({
    queryKey: [...key, page, filter],
    enabled: !!approval.counterpartyJws && approval.terms.agreement.mode !== "ledger_coordinated",
    queryFn: async () => {
      const value = CommercialRefundListSchema.parse(
        (
          await api.get<{ data: unknown }>(
            `${base}/refunds?limit=20&offset=${page * 20}${filter ? `&recordId=${encodeURIComponent(filter)}` : ""}`,
            scope,
          )
        ).data,
      );
      for (const refund of value.data) {
        checkSaved(refund);
        if (filter && refund.refundId !== filter) throw new Error("Refund filter mismatch");
      }
      return value;
    },
    refetchInterval: intent || creating || signature ? false : 10000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
  });
  const generate = useMutation({
    mutationFn: async () => {
      if (!canWrite.current || busy) throw new Error("Refund drafting unavailable");
      const input = CommercialRefundDraftInputSchema.parse({
        operationId: operation.trim(),
        refundId: crypto.randomUUID(),
        reason,
      });
      const draft = checkRefund(
        CommercialRefundSchema.parse(
          (await api.post<{ data: unknown }>(`${base}/refunds/draft`, input, scope)).data,
        ),
      );
      if (
        draft.request.operationId !== input.operationId ||
        draft.refundId !== input.refundId ||
        draft.reason !== input.reason
      )
        throw new Error("Draft identity mismatch");
      return draft;
    },
    onSuccess: (refund) => {
      if (!canWrite.current) return;
      setDraft(refund);
      setMessage(null);
    },
  });
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      if (!canWrite.current || busy) throw new Error("Refund approval unavailable");
      if (action.kind === "approve") {
        checkRefund(action.refund);
        const saved = checkSaved(
          (await api.post<{ data: unknown }>(`${base}/refunds/approve`, action.refund, scope)).data,
        );
        if (federationCanonicalJson(saved.payload) !== federationCanonicalJson(action.refund))
          throw new Error("Refund approval mismatch");
        return saved.refundId;
      } else if (action.kind === "attach") {
        const original = list.data?.data.find((row) => row.refundId === action.refundId);
        if (!original) throw new Error("Refund unavailable");
        const saved = checkSaved(
          (
            await api.post<{ data: unknown }>(
              `${base}/refunds/${action.refundId}/counterparty`,
              { approvalJws: action.approvalJws },
              scope,
            )
          ).data,
        );
        if (
          saved.refundId !== action.refundId ||
          saved.counterpartyJws !== action.approvalJws ||
          federationCanonicalJson(saved.payload) !== federationCanonicalJson(original.payload)
        )
          throw new Error("Refund attachment mismatch");
        return saved.refundId;
      }
      z.object({ success: z.literal(true) }).parse(
        await api.post(`${base}/submissions/${action.submissionId}/retry`, {}, scope),
      );
      return selected;
    },
    onSuccess: async (refundId) => {
      setIntent(null);
      setDraft(null);
      setJson("");
      setSignature("");
      setCreating(false);
      setPage(0);
      setSelected(refundId);
      setFilter(refundId ?? undefined);
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
  const exportRefund = (refund: CommercialRefund) => {
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(refund, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `refund-${refund.refundId}.json`;
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
    ? list.data?.data.find((row) => row.refundId === selected)
    : undefined;
  const ledgerLabel = (row: NonNullable<typeof current>) => {
    const mode = approval.terms.agreement.mode;
    if (mode === "bilateral_direct") return t("federation.billing.states.direct");
    if (row.ledger) return t(`federation.billing.states.${row.ledger.state}`);
    if (!provider && mode === "bilateral_attested")
      return t("federation.billing.states.remoteLedger");
    return t(
      row.counterpartyJws
        ? "federation.refund.notQueued"
        : "federation.billing.states.awaitingSignatures",
    );
  };
  if (approval.terms.agreement.mode === "ledger_coordinated")
    return <p className="text-sm">{t("federation.refund.coordinated")}</p>;
  if (!approval.counterpartyJws)
    return <p className="text-sm">{t("federation.agreements.awaitingSignature")}</p>;
  return (
    <section
      ref={panel}
      tabIndex={-1}
      aria-label={t("federation.refund.title")}
      className="space-y-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
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
            {t("federation.refund.newRefund")}
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
          {t("federation.refund.back")}
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
              {t("federation.refund.back")}
            </Button>
            {draft ? (
              <Button variant="outline" onClick={() => exportRefund(draft)}>
                {t("federation.refund.exportRefund")}
              </Button>
            ) : null}
          </div>
          {draft ? (
            <>
              <CommercialRefundTerms refund={draft} />
              <Button disabled={blocked} onClick={() => review({ kind: "approve", refund: draft })}>
                {t("federation.billing.review")}
              </Button>
            </>
          ) : (
            <>
              {!provider ? (
                <form
                  className="grid max-w-xl gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    generate.mutate();
                  }}
                >
                  <label htmlFor={`${id}-operation`} className="text-sm font-medium">
                    {t("federation.refund.operationId")}
                  </label>
                  <Input
                    id={`${id}-operation`}
                    value={operation}
                    maxLength={36}
                    disabled={blocked}
                    onChange={(e) => setOperation(e.target.value)}
                    required
                  />
                  <label htmlFor={`${id}-reason`} className="text-sm font-medium">
                    {t("federation.refund.reason")}
                  </label>
                  <Textarea
                    id={`${id}-reason`}
                    value={reason}
                    maxLength={4096}
                    rows={3}
                    disabled={blocked}
                    onChange={(event) => setReason(event.target.value)}
                    required
                  />
                  {generate.isError ? (
                    <p role="alert" className="text-sm text-status-failed">
                      {t("federation.refund.draftFailed")}
                    </p>
                  ) : null}
                  <Button
                    className="justify-self-start"
                    disabled={
                      blocked || !z.uuid().safeParse(operation.trim()).success || !reason.trim()
                    }
                  >
                    {t("federation.billing.generate")}
                  </Button>
                </form>
              ) : null}
              <div className="space-y-3 border-t border-border pt-4">
                <label htmlFor={`${id}-json`} className="block text-sm font-medium">
                  {t("federation.refund.importJson")}
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
                      setDraft(checkRefund(CommercialRefundSchema.parse(JSON.parse(json))));
                      setMessage(null);
                    } catch {
                      setMessage(t("federation.refund.invalidRefund"));
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
              {t("federation.refund.back")}
            </Button>
            <Button variant="outline" onClick={() => exportRefund(current.payload)}>
              {t("federation.refund.exportRefund")}
            </Button>
          </div>
          <dl className="grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-muted-foreground">
                {t("federation.refund.confirmation")}
              </dt>
              <dd className="mt-1 text-sm font-medium">
                {t(
                  current.counterpartyJws
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
              <dt className="text-sm text-muted-foreground">{t("federation.refund.accounting")}</dt>
              <dd className="mt-1 text-sm font-medium">
                {t(
                  current.appliedAt ? "federation.refund.applied" : "federation.refund.notApplied",
                )}
                {current.appliedAt ? (
                  <time dateTime={current.appliedAt} className="mt-1 block text-muted-foreground">
                    {new Date(current.appliedAt).toLocaleString(i18n.language)}
                  </time>
                ) : null}
              </dd>
            </div>
          </dl>
          {current.authorizationPolicyId ? (
            <dl className="text-sm">
              <dt className="text-muted-foreground">{t("federation.closing.reference")}</dt>
              <dd className="mt-1 break-all font-mono">{current.authorizationPolicyId}</dd>
            </dl>
          ) : null}
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
          <CommercialRefundTerms refund={current.payload} />
          <details className="space-y-3 border-t border-border pt-4 text-sm">
            <summary className="cursor-pointer">{t("federation.billing.signatures")}</summary>
            <Button variant="outline" onClick={() => void copy(current.approvalJws)}>
              {t("federation.agreements.copySignature")}
            </Button>
            {current.counterpartyJws ? (
              <Button
                variant="outline"
                onClick={() => {
                  if (current.counterpartyJws) void copy(current.counterpartyJws);
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
                      refundId: current.refundId,
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
                <li key={row.refundId}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-2 p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:flex-row sm:justify-between"
                    onClick={() => {
                      setSelected(row.refundId);
                      setSignature("");
                      setMessage(null);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block break-all font-medium tabular-nums">
                        {row.payload.releasedAmount} {row.payload.request.unit}
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">
                        {row.refundId}
                      </span>
                    </span>
                    <span className="text-sm">
                      <span className="block">
                        {t(
                          row.counterpartyJws
                            ? "federation.billing.bothSigned"
                            : "federation.billing.localSigned",
                        )}
                      </span>
                      <time dateTime={row.createdAt} className="text-muted-foreground">
                        {new Date(row.createdAt).toLocaleString(i18n.language)}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <FederationEmpty>{t("federation.refund.empty")}</FederationEmpty>
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
            <DialogTitle>{t(`federation.refund.actions.${intent?.kind ?? "approve"}`)}</DialogTitle>
            <DialogDescription>
              {t(
                intent?.kind === "retry"
                  ? "federation.refund.retryBoundary"
                  : "federation.refund.approvalBoundary",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {intent?.kind === "approve" ? <CommercialRefundTerms refund={intent.refund} /> : null}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {t("federation.refund.actionFailed")}
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

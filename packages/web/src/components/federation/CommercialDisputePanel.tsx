import {
  type FederationCapability,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { ArbitrationResolutionViewSchema } from "@kuintessence/shared/federation/arbitration-resolution";
import {
  CommercialAdjustmentSchema,
  type CommercialAgreementApproval,
  CommercialSettlementSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  type CommercialDisputeResolution,
  CommercialDisputeResolutionContextSchema,
  CommercialDisputeResolutionSchema,
  CommercialDisputeResolutionViewSchema,
} from "@kuintessence/shared/federation/dispute-resolution";
import {
  type CommercialDispute,
  CommercialDisputeFinancialViewSchema,
  CommercialDisputeListSchema,
} from "@kuintessence/shared/federation/disputes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { AgreementFact } from "./AgreementTerms";
import { CommercialAdjustmentTerms } from "./CommercialAdjustmentTerms";
import { CommercialArbitrationPanel } from "./CommercialArbitrationPanel";
import { CommercialDisputeCreate } from "./CommercialDisputeCreate";
import { CommercialDisputeProgress } from "./CommercialDisputeProgress";
import { CommercialSettlementTerms } from "./CommercialSettlementTerms";

type Props = {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  grants: readonly FederationCapability[];
  readOnly: boolean;
  busy: boolean;
  subject?: CommercialDispute["subject"] | null;
  onClearSubject?: () => void;
};
type Intent =
  | { kind: "approve"; value: CommercialDisputeResolution }
  | { kind: "financial"; value: CommercialDisputeResolution }
  | { kind: "withdraw" | "exchange" | "ledger" | "authorization" };
const prefix = "federation.dispute";

export function CommercialDisputePanel(props: Props) {
  return (
    <Disputes
      key={`${props.scope.organizationId}:${props.scope.authRevision}:${props.approval.revisionId}`}
      {...props}
    />
  );
}
function Disputes(props: Props) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const client = useQueryClient();
  const key = [
    "federation",
    "commercial",
    props.scope.organizationId,
    props.scope.authRevision,
    "disputes",
    props.approval.revisionId,
  ];
  const list = useQuery({
    queryKey: [...key, "list", page, filter],
    queryFn: async () => {
      const list = CommercialDisputeListSchema.parse(
        (
          await api.get<{ data: unknown }>(
            `/federation/commercial-agreements/${props.approval.revisionId}/disputes?limit=20&offset=${page * 20}${filter ? `&caseId=${filter}` : ""}`,
            props.scope,
          )
        ).data,
      );
      for (const row of list.data)
        if (
          row.localOrgId !== props.scope.organizationId ||
          row.localSiteId !== props.approval.localSiteId ||
          row.agreementRevisionId !== props.approval.revisionId ||
          (filter !== null && row.caseId !== filter) ||
          row.payload.sourceSiteId !== props.approval.terms.agreement.sourceSiteId ||
          row.payload.targetSiteId !== props.approval.terms.agreement.targetSiteId
        )
          throw new Error("Dispute scope mismatch");
      return list;
    },
    refetchOnWindowFocus: false,
  });
  const current = !list.isError
    ? list.data?.data.find((row) => row.caseId === selected)
    : undefined;
  if (props.subject && props.grants.includes("dispute.open") && !props.readOnly)
    return (
      <CommercialDisputeCreate
        key={`${props.subject.recordType}:${props.subject.recordId}:${props.subject.recordDigest}`}
        subject={props.subject}
        approval={props.approval}
        scope={props.scope}
        writable={props.grants.includes("dispute.open") && !props.readOnly}
        busy={props.busy}
        onCancel={() => props.onClearSubject?.()}
        onOpened={(caseId) => {
          setPage(0);
          setFilter(caseId);
          setSelected(caseId);
          props.onClearSubject?.();
          void client.invalidateQueries({ queryKey: key });
        }}
      />
    );
  if (current)
    return (
      <DisputeDetail
        key={current.caseId}
        {...props}
        dispute={current.payload}
        caseDigest={current.digest}
        resolved={current.state === "RESOLVED"}
        queryKey={key}
        onBack={() => {
          setSelected(null);
          setFilter(null);
        }}
      />
    );
  return (
    <section className="space-y-4">
      <div className="flex justify-end">
        <Button
          variant="outline"
          disabled={list.isFetching || props.busy}
          onClick={() => void list.refetch()}
        >
          {t("federation.refresh")}
        </Button>
      </div>
      {list.isError ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : list.isPending ? (
        <p role="status">{t("federation.loading")}</p>
      ) : (
        <>
          {list.data.data.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {list.data.data.map((row) => (
                <li key={row.caseId}>
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-start justify-between gap-3 p-4 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => setSelected(row.caseId)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-medium">{row.payload.reason}</span>
                    </span>
                    <span className="text-sm">{t(`${prefix}.states.${row.state}`)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-8 text-sm text-muted-foreground">{t(`${prefix}.empty`)}</p>
          )}
          {page > 0 || list.data.hasMore ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
                {t("federation.previous")}
              </Button>
              <Button
                variant="outline"
                disabled={!list.data.hasMore}
                onClick={() => setPage(page + 1)}
              >
                {t("federation.next")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
function DisputeDetail({
  approval,
  scope,
  grants,
  readOnly,
  busy,
  dispute,
  caseDigest,
  resolved,
  queryKey,
  onBack,
}: Props & {
  dispute: CommercialDispute;
  caseDigest: string;
  resolved: boolean;
  queryKey: (string | null)[];
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const id = useId();
  const base = `/federation/commercial-agreements/${approval.revisionId}`;
  const path = `${base}/disputes/${dispute.caseId}`;
  const canResolve = grants.includes("dispute.resolve") && !readOnly;
  const canExecute =
    approval.terms.agreement.mode !== "ledger_coordinated" &&
    grants.includes("arbitration.execute") &&
    !readOnly;
  const allowed = useRef({ resolve: canResolve, execute: canExecute, grants, readOnly, busy });
  allowed.current = { resolve: canResolve, execute: canExecute, grants, readOnly, busy };
  const focus = useRef<HTMLElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState("keep");
  const [recordId, setRecordId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<CommercialDisputeResolution | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const review = (action: Intent) => {
    focus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mutation.reset();
    setIntent(action);
  };
  const check = (value: CommercialDisputeResolution) => {
    if (
      value.caseId !== dispute.caseId ||
      value.caseDigest !== caseDigest ||
      value.domainId !== approval.terms.domainId ||
      value.agreementRevisionId !== approval.revisionId ||
      value.sourceSiteId !== dispute.sourceSiteId ||
      value.targetSiteId !== dispute.targetSiteId ||
      value.taskId !== dispute.taskId ||
      value.attempt !== dispute.attempt ||
      value.mode !== approval.terms.agreement.mode ||
      (value.financial && value.financial.unit !== approval.terms.agreement.unit)
    )
      throw new Error("Resolution scope mismatch");
    return value;
  };
  const resolution = useQuery({
    queryKey: [...queryKey, dispute.caseId, "resolution"],
    queryFn: async () => {
      const value = CommercialDisputeResolutionViewSchema.nullable().parse(
        (await api.get<{ data: unknown }>(`${path}/resolution`, scope)).data,
      );
      if (value) check(value.payload);
      return value;
    },
    refetchInterval: intent || creating ? false : 10000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
  });
  const context = useQuery({
    queryKey: [...queryKey, dispute.caseId, "resolution-context"],
    queryFn: async () =>
      CommercialDisputeResolutionContextSchema.parse(
        (await api.get<{ data: unknown }>(`${path}/resolution/context`, scope)).data,
      ),
    refetchInterval: intent || creating || resolved ? false : 10000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
  });
  const execution = useQuery({
    queryKey: [...queryKey, dispute.caseId, "execution"],
    queryFn: async () => {
      const value = ArbitrationResolutionViewSchema.nullable().parse(
        (await api.get<{ data: unknown }>(`${path}/arbitration-resolution`, scope)).data,
      );
      if (
        value &&
        (value.payload.caseId !== dispute.caseId ||
          value.payload.agreementRevisionId !== approval.revisionId ||
          value.payload.caseDigest !== caseDigest ||
          value.payload.domainId !== approval.terms.domainId ||
          value.payload.sourceSiteId !== dispute.sourceSiteId ||
          value.payload.targetSiteId !== dispute.targetSiteId ||
          value.payload.taskId !== dispute.taskId ||
          value.payload.attempt !== dispute.attempt ||
          value.payload.mode !== approval.terms.agreement.mode)
      )
        throw new Error("Execution scope mismatch");
      return value;
    },
    refetchInterval: (query) =>
      intent || creating
        ? false
        : query.state.data?.ledger?.state === "pending" ||
            (!resolved && !resolution.data?.appliedAt)
          ? 10000
          : false,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
  });
  const financial = useQuery({
    queryKey: [...queryKey, dispute.caseId, "financial-view"],
    enabled: creating,
    queryFn: async () => {
      const value = CommercialDisputeFinancialViewSchema.parse(
        (await api.get<{ data: unknown }>(`${path}/financial-view`, scope)).data,
      );
      if (
        value.caseId !== dispute.caseId ||
        value.caseDigest !== caseDigest ||
        value.agreementRevisionId !== approval.revisionId ||
        value.taskId !== dispute.taskId ||
        value.attempt !== dispute.attempt
      )
        throw new Error("Financial scope mismatch");
      return value;
    },
    refetchOnWindowFocus: false,
  });
  const refresh = () => client.invalidateQueries({ queryKey });
  const generate = useMutation({
    mutationFn: async () => {
      if (
        !allowed.current.resolve ||
        allowed.current.busy ||
        !context.data?.canDraft ||
        context.isError ||
        !financial.data?.localReady
      )
        throw new Error("Resolution drafting unavailable");
      let value: CommercialDisputeResolution["financial"] = null;
      if (mode === "settle")
        value = CommercialSettlementSchema.parse(
          (
            await api.post<{ data: unknown }>(
              `${base}/settlements/draft`,
              { billId: recordId, settlementId: crypto.randomUUID() },
              scope,
            )
          ).data,
        );
      else if (mode === "adjust")
        value = CommercialAdjustmentSchema.parse(
          (
            await api.post<{ data: unknown }>(
              `${base}/adjustments/draft`,
              {
                settlementId: recordId,
                adjustmentId: crypto.randomUUID(),
                chargedAmount: amount,
                reason,
                supportingEvidenceDigest: caseDigest,
              },
              scope,
            )
          ).data,
        );
      return check(
        CommercialDisputeResolutionSchema.parse(
          (
            await api.post<{ data: unknown }>(
              `${path}/resolution/draft`,
              { resolutionId: crypto.randomUUID(), reason, financial: value },
              scope,
            )
          ).data,
        ),
      );
    },
    onSuccess: (value) => {
      if (allowed.current.resolve) {
        setDraft(value);
        setCreating(false);
        setMessage(null);
      }
    },
  });
  const mutation = useMutation({
    mutationFn: async (action: Intent) => {
      if (allowed.current.busy || allowed.current.readOnly)
        throw new Error("Resolution action unavailable");
      if (action.kind === "withdraw") {
        if (!allowed.current.execute) throw new Error("Withdrawal unavailable");
        await api.post(`${path}/arbitration-resolution/withdraw`, {}, scope);
      } else if (action.kind === "approve") {
        if (!allowed.current.resolve) throw new Error("Resolution approval unavailable");
        const value = check(action.value);
        const saved = CommercialDisputeResolutionViewSchema.parse(
          (await api.post<{ data: unknown }>(`${path}/resolution`, value, scope)).data,
        );
        check(saved.payload);
        if (federationCanonicalJson(saved.payload) !== federationCanonicalJson(value))
          throw new Error("Approved resolution mismatch");
      } else if (action.kind === "financial") {
        const value = check(action.value),
          f = value.financial;
        if (
          !f ||
          !resolution.data?.counterpartyApproved ||
          (value.mode === "ledger_coordinated" &&
            resolution.data.authorizationLedger?.state !== "committed") ||
          federationCanonicalJson(value) !== federationCanonicalJson(resolution.data.payload) ||
          !allowed.current.grants.includes(
            f.kind === "commercial-settlement" ? "settlement.approve" : "adjustment.approve",
          )
        )
          throw new Error("Financial approval unavailable");
        await api.post(
          `${base}/${f.kind === "commercial-settlement" ? "settlements" : "adjustments"}/approve`,
          f,
          scope,
        );
      } else {
        if (!allowed.current.resolve) throw new Error("Resolution retry unavailable");
        if (action.kind === "exchange" && resolution.data)
          await api.post(
            `${base}/approval-exchange/dispute-resolution/${resolution.data.payload.resolutionId}/retry`,
            {},
            scope,
          );
        else if (action.kind === "ledger" || action.kind === "authorization") {
          const ledger =
            action.kind === "authorization"
              ? resolution.data?.authorizationLedger
              : resolution.data?.ledger;
          if (!ledger) throw new Error("Retry unavailable");
          await api.post(`${base}/submissions/${ledger.id}/retry`, {}, scope);
        } else throw new Error("Retry unavailable");
      }
    },
    onSuccess: async () => {
      setIntent(null);
      setDraft(null);
      setCreating(false);
      await refresh();
    },
  });
  useEffect(() => {
    if (!canResolve) {
      setDraft(null);
      setCreating(false);
    }
    if (
      readOnly ||
      !grants.includes(
        intent?.kind === "withdraw"
          ? "arbitration.execute"
          : intent?.kind === "financial"
            ? intent.value.financial?.kind === "commercial-settlement"
              ? "settlement.approve"
              : "adjustment.approve"
            : "dispute.resolve",
      )
    )
      setIntent(null);
  }, [canResolve, readOnly, grants, intent]);
  const blocked =
    busy ||
    mutation.isPending ||
    generate.isPending ||
    resolution.isError ||
    execution.isError ||
    context.isError ||
    context.isPending;
  const value = resolution.data?.payload ?? draft;
  const f = value?.financial;
  const chainWaiting =
    resolution.data?.counterpartyApproved &&
    value?.mode === "ledger_coordinated" &&
    (!f ||
      resolution.data.authorizationLedger?.state !== "committed" ||
      !!resolution.data.financialAppliedAt);
  const canFinancial =
    !!f &&
    !readOnly &&
    grants.includes(
      f.kind === "commercial-settlement" ? "settlement.approve" : "adjustment.approve",
    );
  const error = (cause: unknown) =>
    cause instanceof ApiError
      ? t(`${prefix}.errors.${cause.code}`, { defaultValue: t(`${prefix}.failed`) })
      : t(`${prefix}.failed`);
  const exportValue = () => {
    if (!value) return;
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `resolution-${value.resolutionId}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setMessage(t("federation.commercial.exportFailed"));
    }
  };
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap justify-between gap-3">
        <Button variant="ghost" disabled={mutation.isPending} onClick={onBack}>
          {t(`${prefix}.back`)}
        </Button>
        <Button
          variant="outline"
          disabled={mutation.isPending || resolution.isFetching || execution.isFetching}
          onClick={() => void refresh()}
        >
          {t("federation.refresh")}
        </Button>
      </div>
      <div className="space-y-2">
        <h3 className="break-words text-base font-semibold">{dispute.reason}</h3>
        <p className="break-words text-sm">{dispute.requestedResolution}</p>
        <details className="text-sm">
          <summary className="cursor-pointer">{t("federation.billing.references")}</summary>
          <dl className="mt-3 grid gap-4 sm:grid-cols-2">
            <AgreementFact label={t(`${prefix}.caseId`)}>{dispute.caseId}</AgreementFact>
            <AgreementFact label={t(`${prefix}.taskId`)}>{dispute.taskId}</AgreementFact>
            <AgreementFact label={t(`${prefix}.caseDigest`)}>{caseDigest}</AgreementFact>
          </dl>
        </details>
      </div>
      <CommercialDisputeProgress
        approval={approval}
        dispute={dispute}
        scope={scope}
        writable={!readOnly && grants.includes("dispute.open")}
        busy={busy}
        resolved={resolved}
      />
      <CommercialArbitrationPanel
        approval={approval}
        dispute={dispute}
        caseDigest={caseDigest}
        scope={scope}
        grants={grants}
        readOnly={readOnly}
        busy={busy}
        resolved={resolved}
        execution={execution.isError ? undefined : execution.data}
        onChanged={refresh}
      />
      {message ? (
        <p role="alert" className="text-sm text-status-failed">
          {message}
        </p>
      ) : null}
      {resolution.isError || execution.isError || context.isError ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : resolution.isPending || execution.isPending || context.isPending ? (
        <p role="status">{t("federation.loading")}</p>
      ) : (
        <>
          <ol
            className={`grid gap-4 border-y border-border py-4 text-sm ${execution.data ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
          >
            {execution.data ? (
              <li>
                <span className="block font-medium">{t(`${prefix}.withdrawal`)}</span>
                <span>
                  {t(
                    `${prefix}.${execution.data?.withdrawnAt ? "withdrawn" : execution.data?.withdrawalRequestedAt ? "withdrawing" : "notWithdrawn"}`,
                  )}
                </span>
                {execution.data?.withdrawnAt ? (
                  <time
                    className="block text-xs text-muted-foreground"
                    dateTime={execution.data.withdrawnAt}
                  >
                    {new Date(execution.data.withdrawnAt).toLocaleString(i18n.language)}
                  </time>
                ) : null}
              </li>
            ) : null}
            <li>
              <span className="block font-medium">{t(`${prefix}.agreement`)}</span>
              <span>
                {t(
                  `${prefix}.${resolution.data?.counterpartyApproved ? "bothApproved" : resolution.data ? "awaitingPeer" : "notApproved"}`,
                )}
              </span>
            </li>
            <li>
              <span className="block font-medium">{t(`${prefix}.closure`)}</span>
              <span>
                {t(
                  `${prefix}.${resolution.data?.appliedAt ? "closed" : execution.data?.appliedAt ? "arbitrated" : chainWaiting ? "chainWaiting" : resolution.data?.counterpartyApproved && f ? "financialWaiting" : resolved ? "alreadyResolved" : "open"}`,
                )}
              </span>
              {resolution.data?.appliedAt ? (
                <time
                  className="block text-xs text-muted-foreground"
                  dateTime={resolution.data.appliedAt}
                >
                  {new Date(resolution.data.appliedAt).toLocaleString(i18n.language)}
                </time>
              ) : null}
            </li>
          </ol>
          {!resolution.data && !resolved && !context.data.canDraft ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {execution.data && !execution.data.withdrawnAt
                  ? t(`${prefix}.withdrawalRequired`)
                  : t(`${prefix}.errors.${context.data.blockedReason}`, {
                      defaultValue: t(`${prefix}.notReady`),
                    })}
              </p>
              {canExecute &&
              execution.data &&
              !execution.data.appliedAt &&
              !execution.data.withdrawalRequestedAt ? (
                <Button
                  variant="outline"
                  disabled={blocked}
                  onClick={() => review({ kind: "withdraw" })}
                >
                  {t(`${prefix}.withdraw`)}
                </Button>
              ) : null}
            </div>
          ) : null}
          {!resolution.data &&
          !resolved &&
          context.data.canDraft &&
          canResolve &&
          !creating &&
          !draft ? (
            <div className="flex flex-wrap items-end gap-4">
              <Button
                disabled={blocked}
                onClick={() => {
                  setCreating(true);
                  generate.reset();
                }}
              >
                {t(`${prefix}.create`)}
              </Button>
              <div className="min-w-0">
                <label htmlFor={`${id}-file`} className="mb-1 block text-sm">
                  {t(`${prefix}.import`)}
                </label>
                <Input
                  id={`${id}-file`}
                  type="file"
                  accept="application/json,.json"
                  disabled={blocked}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    try {
                      if (file.size > 1048576) throw new Error("File too large");
                      const value = check(
                        CommercialDisputeResolutionSchema.parse(JSON.parse(await file.text())),
                      );
                      if (!allowed.current.resolve || allowed.current.busy) return;
                      setDraft(value);
                      setMessage(null);
                    } catch {
                      setMessage(t(`${prefix}.invalidImport`));
                    }
                  }}
                />
              </div>
            </div>
          ) : null}
          {creating ? (
            <form
              className="max-w-2xl space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                generate.mutate();
              }}
            >
              <div>
                <label htmlFor={`${id}-mode`} className="mb-1 block text-sm">
                  {t(`${prefix}.financial`)}
                </label>
                <select
                  id={`${id}-mode`}
                  className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                  value={mode}
                  disabled={blocked}
                  onChange={(event) => {
                    setMode(event.target.value);
                    setRecordId("");
                  }}
                >
                  {["keep", "settle", "adjust"].map((v) => (
                    <option key={v} value={v}>
                      {t(`${prefix}.modes.${v}`)}
                    </option>
                  ))}
                </select>
              </div>
              {mode !== "keep" ? (
                <div>
                  <label htmlFor={`${id}-record`} className="mb-1 block text-sm">
                    {t(
                      mode === "settle"
                        ? "federation.billing.billId"
                        : "federation.settlement.settlementId",
                    )}
                  </label>
                  <select
                    id={`${id}-record`}
                    required
                    className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                    value={recordId}
                    disabled={blocked || financial.isPending}
                    onChange={(event) => setRecordId(event.target.value)}
                  >
                    <option value="">{t(`${prefix}.selectRecord`)}</option>
                    {financial.data?.records
                      .filter((r) => r.recordType === (mode === "settle" ? "bill" : "settlement"))
                      .map((r) => (
                        <option key={r.recordId} value={r.recordId}>
                          {r.recordId}
                        </option>
                      ))}
                  </select>
                </div>
              ) : null}
              {mode === "adjust" ? (
                <div>
                  <label htmlFor={`${id}-amount`} className="mb-1 block text-sm">
                    {t("federation.adjustment.chargedAmount")} ({approval.terms.agreement.unit})
                  </label>
                  <Input
                    id={`${id}-amount`}
                    value={amount}
                    pattern="0|[1-9][0-9]*"
                    inputMode="numeric"
                    required
                    disabled={blocked}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
              ) : null}
              <div>
                <label htmlFor={`${id}-reason`} className="mb-1 block text-sm">
                  {t(`${prefix}.reason`)}
                </label>
                <Textarea
                  id={`${id}-reason`}
                  value={reason}
                  maxLength={4096}
                  required
                  disabled={blocked}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              {financial.isError ? (
                <p role="alert">{t("federation.loadFailed")}</p>
              ) : financial.data && !financial.data.localReady ? (
                <p role="status">{t(`${prefix}.financialNotReady`)}</p>
              ) : null}
              {generate.isError ? <p role="alert">{error(generate.error)}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={blocked || !financial.data?.localReady}>
                  {t(`${prefix}.review`)}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={generate.isPending}
                  onClick={() => setCreating(false)}
                >
                  {t("federation.cancel")}
                </Button>
              </div>
            </form>
          ) : null}
          {value ? (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 className="font-semibold">{t(`${prefix}.agreement`)}</h4>
                <Button variant="outline" onClick={exportValue}>
                  {t(`${prefix}.export`)}
                </Button>
              </div>
              <p className="break-words text-sm">{value.reason}</p>
              {f?.kind === "commercial-adjustment" ? (
                <CommercialAdjustmentTerms adjustment={f} />
              ) : f ? (
                <CommercialSettlementTerms settlement={f} />
              ) : (
                <p className="text-sm">{t(`${prefix}.modes.keep`)}</p>
              )}
              <details className="text-sm">
                <summary className="cursor-pointer">{t(`${prefix}.proofs`)}</summary>
                <dl className="mt-3 grid gap-4 sm:grid-cols-2">
                  <AgreementFact label={t(`${prefix}.resolutionId`)}>
                    {value.resolutionId}
                  </AgreementFact>
                  {value.decisionId ? (
                    <AgreementFact label={t(`${prefix}.decisionId`)}>
                      {value.decisionId}
                    </AgreementFact>
                  ) : null}
                  {value.withdrawalDigest ? (
                    <AgreementFact label={t(`${prefix}.withdrawalDigest`)}>
                      {value.withdrawalDigest}
                    </AgreementFact>
                  ) : null}
                  {value.protocolVersion === 2 && value.freezeDigest ? (
                    <AgreementFact label={t(`${prefix}.freezeDigest`)}>
                      {value.freezeDigest}
                    </AgreementFact>
                  ) : null}
                  <AgreementFact label={t(`${prefix}.headDigest`)}>
                    {value.headDigest}
                  </AgreementFact>
                </dl>
              </details>
              {!resolution.data && canResolve ? (
                <div className="flex flex-wrap gap-2">
                  <Button disabled={blocked} onClick={() => review({ kind: "approve", value })}>
                    {t(`${prefix}.approve`)}
                  </Button>
                  <Button variant="outline" disabled={blocked} onClick={() => setDraft(null)}>
                    {t("federation.cancel")}
                  </Button>
                </div>
              ) : null}
              {resolution.data?.counterpartyApproved &&
              f &&
              (value.mode !== "ledger_coordinated" ||
                resolution.data.authorizationLedger?.state === "committed") &&
              !resolution.data.financialApproved &&
              canFinancial ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {t(`${prefix}.separateFinancialApproval`)}
                  </p>
                  <Button disabled={blocked} onClick={() => review({ kind: "financial", value })}>
                    {t(`${prefix}.approveFinancial`)}
                  </Button>
                </div>
              ) : null}
              {resolution.data?.financialApproved && !resolution.data.financialAppliedAt ? (
                <p role="status" className="text-sm">
                  {t(`${prefix}.financialApproved`)}
                </p>
              ) : null}
              {resolution.data?.exchange?.state === "needs_review" ? (
                <div role="alert" className="space-y-2 text-sm">
                  <p>
                    {t(`${prefix}.exchangeFailed`)} ({resolution.data.exchange.lastError})
                  </p>
                  {canResolve ? (
                    <Button
                      variant="outline"
                      disabled={blocked}
                      onClick={() => review({ kind: "exchange" })}
                    >
                      {t(`${prefix}.retryExchange`)}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {resolution.data && value.mode !== "bilateral_direct"
                ? (["authorization", "ledger"] as const).map((stage) => {
                    const ledger =
                      stage === "authorization"
                        ? resolution.data?.authorizationLedger
                        : resolution.data?.ledger;
                    if (
                      stage === "authorization" &&
                      (!ledger || value.mode !== "ledger_coordinated")
                    )
                      return null;
                    if (
                      stage === "ledger" &&
                      value.mode === "bilateral_attested" &&
                      !resolution.data?.appliedAt
                    )
                      return null;
                    return (
                      <section key={stage} className="space-y-3 border-t border-border pt-4">
                        <h4 className="font-semibold">
                          {t(
                            value.mode === "ledger_coordinated"
                              ? `${prefix}.${stage === "authorization" ? "chainAuthorization" : "chainClosure"}`
                              : "federation.commercial.ledger",
                          )}
                        </h4>
                        <p role="status" className="text-sm">
                          {t(
                            `${prefix}.${value.mode === "ledger_coordinated" ? "chainStates" : "ledger"}.${ledger?.state ?? (approval.localSiteId === value.sourceSiteId ? "notQueued" : "remote")}`,
                          )}
                        </p>
                        {ledger?.lastError ? (
                          <p role="alert" className="break-words text-sm">
                            {ledger.lastError}
                          </p>
                        ) : null}
                        {ledger?.transactionId ? (
                          <dl className="grid gap-4 sm:grid-cols-2">
                            <AgreementFact label={t("federation.commercial.transaction")}>
                              {ledger.transactionId}
                            </AgreementFact>
                            <AgreementFact label={t("federation.commercial.block")}>
                              {ledger.blockNumber ?? t("federation.commercial.unconfirmed")}
                            </AgreementFact>
                          </dl>
                        ) : null}
                        {ledger?.state === "needs_review" && canResolve ? (
                          <Button
                            variant="outline"
                            disabled={blocked}
                            onClick={() => review({ kind: stage })}
                          >
                            {t(
                              value.mode === "ledger_coordinated"
                                ? "federation.commercial.actions.retry"
                                : `${prefix}.retryLedger`,
                            )}
                          </Button>
                        ) : null}
                      </section>
                    );
                  })
                : null}
            </div>
          ) : null}
        </>
      )}
      <Dialog
        open={intent !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setIntent(null);
        }}
      >
        <DialogContent
          dismissible={!mutation.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focus.current?.isConnected && focus.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t(
                `${prefix}.${intent?.kind === "financial" ? "approveFinancial" : intent?.kind === "withdraw" ? "withdraw" : "confirm"}`,
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                `${prefix}.${intent?.kind === "financial" ? "financialConfirmation" : intent?.kind === "withdraw" ? "withdrawConfirmation" : "confirmation"}`,
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {intent?.kind === "approve" || intent?.kind === "financial" ? (
              <div className="space-y-4">
                <p className="break-words text-sm">{intent.value.reason}</p>
                {intent.value.financial?.kind === "commercial-adjustment" ? (
                  <CommercialAdjustmentTerms adjustment={intent.value.financial} />
                ) : intent.value.financial ? (
                  <CommercialSettlementTerms settlement={intent.value.financial} />
                ) : (
                  <p className="text-sm">{t(`${prefix}.modes.keep`)}</p>
                )}
              </div>
            ) : null}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {error(mutation.error)}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={mutation.isPending} onClick={() => setIntent(null)}>
              {t("federation.cancel")}
            </Button>
            <Button disabled={blocked || !intent} onClick={() => intent && mutation.mutate(intent)}>
              {t("federation.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

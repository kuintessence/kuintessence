import {
  type CommercialAgreementApproval,
  type CommercialUsageCorrectionInput,
  CommercialUsageCorrectionInputSchema,
  CommercialUsageProviderViewSchema,
  CommercialUsageReceivedViewSchema,
  type CommercialUsageRecordView,
  CommercialUsageSyncViewSchema,
  CommercialUsageTaskViewSchema,
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
import { AgreementFact } from "./AgreementTerms";
import { commercialMetric, commercialUnit } from "./commercial-format";

type Action =
  | { kind: "retry" | "refresh"; id: string }
  | { kind: "ledger"; id: string; submissionId: string }
  | { kind: "correct"; id: string; input: CommercialUsageCorrectionInput };

export function CommercialUsagePanel({
  approval,
  scope,
  writable,
  busy,
}: {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  writable: boolean;
  busy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const id = useId();
  const provider = approval.localSiteId === approval.terms.agreement.targetSiteId;
  const base = `/federation/commercial-agreements/${approval.revisionId}`;
  const path = `${base}/${provider ? "usage" : "received-usage"}`;
  const key = [
    "federation",
    "commercial",
    scope.organizationId,
    scope.authRevision,
    "usage",
    approval.revisionId,
  ];
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [draft, setDraft] = useState<CommercialUsageCorrectionInput | null>(null);
  const [intent, setIntent] = useState<Action | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!writable) {
      setDraft(null);
      setIntent(null);
    }
  }, [writable]);
  const list = useQuery({
    queryKey: [...key, "list", page],
    enabled: !!approval.counterpartyJws,
    queryFn: async () => {
      const raw = (await api.get<{ data: unknown }>(`${path}?limit=20&offset=${page * 20}`, scope))
        .data;
      if (provider)
        return z
          .array(CommercialUsageTaskViewSchema)
          .parse(raw)
          .map((row) => {
            if (
              row.localOrgId !== scope.organizationId ||
              row.localSiteId !== approval.localSiteId ||
              row.agreementRevisionId !== approval.revisionId
            )
              throw new Error("Usage scope mismatch");
            return { id: row.reservationId, state: row.state, updatedAt: row.updatedAt };
          });
      return z
        .array(CommercialUsageSyncViewSchema)
        .parse(raw)
        .map((row) => ({
          id: row.operationId,
          state:
            row.state === "needs_review"
              ? "needs_review"
              : row.lastError
                ? "retrying"
                : (row.providerState ?? "waiting"),
          updatedAt: row.verifiedAt,
        }));
    },
    refetchInterval: selected ? false : 10000,
    refetchIntervalInBackground: false,
  });
  const detail = useQuery({
    queryKey: [...key, "detail", selected, historyPage],
    enabled: !!approval.counterpartyJws && !!selected,
    queryFn: async () => {
      const raw = (
        await api.get<{ data: unknown }>(
          `${path}/${selected}?limit=10&offset=${historyPage * 10}`,
          scope,
        )
      ).data;
      const value = provider
        ? CommercialUsageProviderViewSchema.parse(raw)
        : CommercialUsageReceivedViewSchema.parse(raw);
      if (
        "task" in value &&
        (value.task.reservationId !== selected ||
          value.task.localOrgId !== scope.organizationId ||
          value.task.localSiteId !== approval.localSiteId ||
          value.task.agreementRevisionId !== approval.revisionId)
      )
        throw new Error("Usage scope mismatch");
      if ("sync" in value && value.sync && value.sync.operationId !== selected)
        throw new Error("Usage scope mismatch");
      for (const record of value.reports)
        if (
          record.report.agreementRevisionId !== approval.revisionId ||
          record.report.agreementDigest !== approval.digest ||
          record.report.sourceSiteId !== approval.terms.agreement.sourceSiteId ||
          record.report.targetSiteId !== approval.terms.agreement.targetSiteId
        )
          throw new Error("Usage report scope mismatch");
      return {
        ...value,
        state:
          "task" in value
            ? value.task.state
            : value.sync?.state === "needs_review"
              ? "needs_review"
              : value.sync?.lastError
                ? "retrying"
                : (value.sync?.providerState ?? "waiting"),
      };
    },
    refetchInterval: draft || intent ? false : 10000,
    refetchIntervalInBackground: false,
  });
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      if (!writable || busy) throw new Error("Usage action unavailable");
      if (action.kind === "correct")
        await api.post(`${path}/${action.id}/corrections`, action.input, scope);
      else if (action.kind === "ledger")
        await api.post(`${base}/submissions/${action.submissionId}/retry`, {}, scope);
      else await api.post(`${path}/${action.id}/${action.kind}`, {}, scope);
    },
    onSuccess: async () => {
      setIntent(null);
      setDraft(null);
      setHistoryPage(0);
      await client.invalidateQueries({ queryKey: key });
    },
  });
  const blocked = busy || mutation.isPending;
  const review = (action: Action) => {
    mutation.reset();
    setMessage(null);
    setIntent(action);
  };
  const latest = !detail.isError && historyPage === 0 ? detail.data?.reports[0] : undefined;
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString(i18n.language) : "—";
  const exportRecord = (record: CommercialUsageRecordView) => {
    try {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `usage-${record.report.reportId}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(null);
    } catch {
      setMessage(t("federation.usage.exportFailed"));
    }
  };
  const measurements = (record: CommercialUsageRecordView) => (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-80 text-left text-sm tabular-nums">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="py-2 pr-4 font-medium">{t("federation.commercial.metric")}</th>
            <th className="py-2 text-right font-medium">{t("federation.usage.quantity")}</th>
          </tr>
        </thead>
        <tbody>
          {record.report.measurements.map((m) => (
            <tr key={m.metric} className="border-b border-border">
              <td className="py-3 pr-4">{commercialMetric(t, m.metric, m.quantityUnit)}</td>
              <td className="py-3 text-right">
                {BigInt(m.quantity).toLocaleString(i18n.language)}{" "}
                {commercialUnit(t, m.metric, m.quantityUnit)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  if (!approval.counterpartyJws)
    return (
      <p className="text-sm text-muted-foreground">
        {t("federation.agreements.awaitingSignature")}
      </p>
    );
  return (
    <section className="space-y-5">
      <h3 className="text-base font-semibold">
        {selected
          ? `${t(provider ? "federation.usage.reservation" : "federation.usage.delegation")} ${selected.slice(0, 8)}`
          : t(provider ? "federation.usage.issued" : "federation.usage.received")}
      </h3>
      <p className="text-sm text-muted-foreground">{t("federation.usage.assertion")}</p>
      {message ? <p role="alert">{message}</p> : null}
      {!selected ? (
        list.isError ? (
          <div role="alert" className="space-y-3">
            <p>{t("federation.loadFailed")}</p>
            <Button
              variant="outline"
              disabled={blocked || list.isFetching}
              onClick={() => void list.refetch()}
            >
              {t("federation.refresh")}
            </Button>
          </div>
        ) : list.isPending ? (
          <p role="status">{t("federation.loading")}</p>
        ) : (
          <>
            {list.data.length ? (
              <ul className="divide-y divide-border">
                {list.data.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-center justify-between gap-3 py-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                      disabled={blocked}
                      onClick={() => {
                        setSelected(row.id);
                        setHistoryPage(0);
                        setMessage(null);
                      }}
                    >
                      <span className="min-w-0 break-all text-sm">
                        {t(
                          provider ? "federation.usage.reservation" : "federation.usage.delegation",
                        )}{" "}
                        {row.id}
                      </span>
                      <span className="text-sm">{t(`federation.usage.states.${row.state}`)}</span>
                      <time className="text-xs text-muted-foreground">{date(row.updatedAt)}</time>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-5 text-sm text-muted-foreground">{t("federation.usage.empty")}</p>
            )}
            {page > 0 || list.data.length === 20 ? (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={blocked || list.isFetching || page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  {t("federation.previous")}
                </Button>
                <Button
                  variant="outline"
                  disabled={blocked || list.isFetching || list.data.length !== 20}
                  onClick={() => setPage(page + 1)}
                >
                  {t("federation.next")}
                </Button>
              </div>
            ) : null}
          </>
        )
      ) : (
        <>
          <Button
            variant="ghost"
            disabled={mutation.isPending}
            onClick={() => {
              setSelected(null);
              setDraft(null);
              setMessage(null);
            }}
          >
            {t("federation.usage.back")}
          </Button>
          {detail.isError ? (
            <div role="alert" className="space-y-3">
              <p>{t("federation.loadFailed")}</p>
              <Button
                variant="outline"
                disabled={blocked || detail.isFetching}
                onClick={() => void detail.refetch()}
              >
                {t("federation.refresh")}
              </Button>
            </div>
          ) : detail.isPending ? (
            <p role="status">{t("federation.loading")}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-end gap-3">
                {detail.data.state !== "reported" ? (
                  <span className="mr-auto text-sm font-medium">
                    {t(`federation.usage.states.${detail.data.state}`)}
                  </span>
                ) : null}
                {writable ? (
                  <div className="flex flex-wrap gap-2">
                    {provider && ["missing_data", "needs_review"].includes(detail.data.state) ? (
                      <Button
                        variant="outline"
                        disabled={blocked || detail.isFetching}
                        onClick={() => review({ kind: "retry", id: selected })}
                      >
                        {t("federation.usage.retry")}
                      </Button>
                    ) : null}
                    {"syncEnabled" in detail.data && detail.data.syncEnabled ? (
                      <Button
                        variant="outline"
                        disabled={blocked || detail.isFetching}
                        onClick={() => review({ kind: "refresh", id: selected })}
                      >
                        {t("federation.usage.sync")}
                      </Button>
                    ) : null}
                    {provider && latest && !draft ? (
                      <Button
                        variant="outline"
                        disabled={blocked || detail.isFetching}
                        onClick={() =>
                          setDraft({
                            reportId: crypto.randomUUID(),
                            correctionOf: latest.report.reportId,
                            reason: "",
                            measurements: latest.report.measurements.map((m) => ({
                              metric: m.metric,
                              quantityUnit: m.quantityUnit,
                              quantity: m.quantity,
                              supportingEvidenceDigest: "",
                            })),
                          })
                        }
                      >
                        {t("federation.usage.correct")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {"task" in detail.data && detail.data.task.gaps.length ? (
                <ul className="space-y-2 text-sm">
                  {detail.data.task.gaps.map((g) => (
                    <li key={g.metric}>
                      <span className="font-medium">{g.metric}</span> ·{" "}
                      {t(`federation.usage.gaps.${g.reason}`)}
                      {g.missingJobs ? ` (${g.missingJobs})` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
              {(
                "task" in detail.data
                  ? detail.data.task.lastError
                  : detail.data.sync?.lastError
              ) ? (
                <p className="break-all text-sm text-status-failed">
                  {t("federation.usage.errorCode")}:{" "}
                  {"task" in detail.data ? detail.data.task.lastError : detail.data.sync?.lastError}
                </p>
              ) : null}
              {"syncEnabled" in detail.data && !detail.data.syncEnabled ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {t("federation.usage.syncDisabled")}
                </p>
              ) : null}
              {"sync" in detail.data ? (
                <p className="text-sm text-muted-foreground">
                  {t("federation.usage.lastSync")}: {date(detail.data.sync?.verifiedAt ?? null)}
                </p>
              ) : null}
              {draft && writable ? (
                <form
                  className="space-y-4 border-y border-border py-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const result = CommercialUsageCorrectionInputSchema.safeParse(draft);
                    if (!result.success) {
                      setMessage(t("federation.usage.invalidCorrection"));
                      return;
                    }
                    review({ kind: "correct", id: selected, input: result.data });
                  }}
                >
                  <h4 className="font-semibold">{t("federation.usage.correct")}</h4>
                  <fieldset disabled={blocked || !!intent} className="space-y-4">
                    {draft.measurements.map((m, index) => (
                      <fieldset key={m.metric} className="grid gap-3 sm:grid-cols-2">
                        <legend className="mb-2 text-sm font-medium">
                          {commercialMetric(t, m.metric, m.quantityUnit)}
                        </legend>
                        <label htmlFor={`${id}-${index}-quantity`} className="space-y-2 text-sm">
                          <span className="block">
                            {t("federation.usage.correctedQuantity")} (
                            {commercialUnit(t, m.metric, m.quantityUnit)})
                          </span>
                          <Input
                            required
                            type="text"
                            inputMode="numeric"
                            id={`${id}-${index}-quantity`}
                            maxLength={38}
                            value={m.quantity}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                measurements: draft.measurements.map((row, i) =>
                                  i === index ? { ...row, quantity: e.target.value } : row,
                                ),
                              })
                            }
                          />
                        </label>
                        <label htmlFor={`${id}-${index}-digest`} className="space-y-2 text-sm">
                          <span className="block">{t("federation.usage.supportingDigest")}</span>
                          <Input
                            required
                            type="text"
                            maxLength={71}
                            id={`${id}-${index}-digest`}
                            placeholder="sha256:…"
                            value={m.supportingEvidenceDigest}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                measurements: draft.measurements.map((row, i) =>
                                  i === index
                                    ? { ...row, supportingEvidenceDigest: e.target.value }
                                    : row,
                                ),
                              })
                            }
                          />
                        </label>
                      </fieldset>
                    ))}
                    <label htmlFor={`${id}-reason`} className="block space-y-2 text-sm">
                      <span className="block">{t("federation.usage.reason")}</span>
                      <Textarea
                        id={`${id}-reason`}
                        rows={3}
                        required
                        maxLength={4096}
                        value={draft.reason}
                        onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                      />
                    </label>
                  </fieldset>
                  <div className="flex gap-2">
                    <Button type="submit" disabled={blocked || !!intent}>
                      {t("federation.usage.reviewCorrection")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={blocked}
                      onClick={() => {
                        setDraft(null);
                        setMessage(null);
                      }}
                    >
                      {t("federation.cancel")}
                    </Button>
                  </div>
                </form>
              ) : null}
              {detail.data.reports.length ? (
                <div className="divide-y divide-border">
                  {detail.data.reports.map((record, index) => (
                    <details key={record.report.reportId} open={index === 0} className="py-4">
                      <summary className="cursor-pointer text-sm font-medium">
                        {t(
                          record.report.correctionOf
                            ? "federation.usage.correction"
                            : "federation.usage.original",
                        )}{" "}
                        #{record.number} · {date(record.report.reportedAt)}
                      </summary>
                      <div className="mt-4 space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <span className="text-sm">
                            {provider
                              ? t(
                                  record.ledgerState
                                    ? record.ledgerState === "pending"
                                      ? "federation.usage.ledgerPending"
                                      : `federation.commercial.states.${record.ledgerState}`
                                    : "federation.usage.localSigned",
                                )
                              : t("federation.usage.receivedStatus")}
                          </span>
                          <div className="flex flex-wrap gap-2">
                            <Button variant="outline" onClick={() => exportRecord(record)}>
                              {t("federation.usage.export")}
                            </Button>
                            {writable &&
                            provider &&
                            record.ledgerState === "needs_review" &&
                            record.submissionId ? (
                              <Button
                                variant="outline"
                                disabled={blocked}
                                onClick={() => {
                                  if (record.submissionId)
                                    review({
                                      kind: "ledger",
                                      id: selected,
                                      submissionId: record.submissionId,
                                    });
                                }}
                              >
                                {t("federation.commercial.actions.retry")}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                        {measurements(record)}
                        <dl className="grid gap-3 text-sm sm:grid-cols-2">
                          <AgreementFact label={t("federation.usage.periodStart")}>
                            {date(record.report.periodStart)}
                          </AgreementFact>
                          <AgreementFact label={t("federation.usage.periodEnd")}>
                            {date(record.report.periodEnd)}
                          </AgreementFact>
                        </dl>
                        {record.correctionEvidence ? (
                          <p className="max-w-prose whitespace-pre-wrap break-words text-sm">
                            {record.correctionEvidence.declaration.reason}
                          </p>
                        ) : null}
                        <details className="text-sm">
                          <summary className="cursor-pointer">
                            {t("federation.usage.evidence")}
                          </summary>
                          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                            <AgreementFact label={t("federation.usage.reportId")}>
                              {record.report.reportId}
                            </AgreementFact>
                            <AgreementFact label={t("federation.usage.taskId")}>
                              {record.report.taskId}
                            </AgreementFact>
                            <AgreementFact label={t("federation.agreements.signedDigest")}>
                              {record.digest}
                            </AgreementFact>
                            {record.correctionEvidence ? (
                              <AgreementFact label={t("federation.usage.previousReport")}>
                                {record.correctionEvidence.declaration.correctionOf}
                              </AgreementFact>
                            ) : null}
                            {record.report.measurements.map((m) => (
                              <AgreementFact
                                key={m.metric}
                                label={`${commercialMetric(t, m.metric, m.quantityUnit)} · SHA-256`}
                              >
                                {m.evidenceDigest}
                              </AgreementFact>
                            ))}
                          </dl>
                          <Textarea
                            className="mt-3 font-mono text-xs"
                            readOnly
                            rows={4}
                            aria-label={t("federation.usage.signature")}
                            value={record.reportJws}
                          />
                        </details>
                      </div>
                    </details>
                  ))}
                </div>
              ) : (
                <p className="py-4 text-sm text-muted-foreground">
                  {t("federation.usage.noReport")}
                </p>
              )}
              {historyPage > 0 || detail.data.hasMore ? (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={blocked || !!draft || detail.isFetching || historyPage === 0}
                    onClick={() => setHistoryPage(historyPage - 1)}
                  >
                    {t("federation.previous")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={blocked || !!draft || detail.isFetching || !detail.data.hasMore}
                    onClick={() => setHistoryPage(historyPage + 1)}
                  >
                    {t("federation.next")}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
      <Dialog
        open={!!intent && writable}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setIntent(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(
                intent?.kind === "correct"
                  ? "federation.usage.reviewCorrection"
                  : intent?.kind === "refresh"
                    ? "federation.usage.sync"
                    : intent?.kind === "ledger"
                      ? "federation.commercial.actions.retry"
                      : "federation.usage.retry",
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                intent?.kind === "correct"
                  ? "federation.usage.correctionNotice"
                  : "federation.usage.retryNotice",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {intent?.kind === "correct" ? (
              <div className="space-y-3">
                <p className="whitespace-pre-wrap break-words text-sm">{intent.input.reason}</p>
                <dl className="space-y-3 text-sm">
                  {intent.input.measurements.map((m) => (
                    <AgreementFact
                      key={m.metric}
                      label={commercialMetric(t, m.metric, m.quantityUnit)}
                    >
                      {BigInt(m.quantity).toLocaleString(i18n.language)}{" "}
                      {commercialUnit(t, m.metric, m.quantityUnit)}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {m.supportingEvidenceDigest}
                      </span>
                    </AgreementFact>
                  ))}
                </dl>
              </div>
            ) : null}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {t("federation.usage.actionFailed")}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => setIntent(null)}
              >
                {t("federation.cancel")}
              </Button>
              <Button
                disabled={blocked}
                onClick={() => {
                  if (intent) mutation.mutate(intent);
                }}
              >
                {mutation.isPending ? t("federation.loading") : t("federation.confirm")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

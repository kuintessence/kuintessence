import {
  type FederationCapability,
  FederationResultReportSchema,
} from "@kuintessence/shared/federation";
import {
  FederationOutboundViewSchema,
  FederationResultImportViewSchema,
} from "@kuintessence/shared/federation/outbound-views";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
import { AgreementFact } from "./AgreementTerms";

type Action =
  | { kind: "retry" | "cancel" | "cancel-retry" }
  | { kind: "import" | "import-cancel" | "receipt-retry"; id: string };
const required = (action: Action) =>
  action.kind === "retry"
    ? "delegation.submit"
    : action.kind === "cancel" || action.kind === "cancel-retry"
      ? "delegation.cancel"
      : "result.read";

export function FederationTaskDetail({
  scope,
  operationId,
  grants,
  readOnly,
  busy,
  onBack,
}: {
  scope: ApiOrganizationScope;
  operationId: string;
  grants: readonly FederationCapability[];
  readOnly: boolean;
  busy: boolean;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const key = ["federation", "tasks", scope.organizationId, scope.authRevision];
  const base = `/federation/outbound/${operationId}`;
  const [intent, setIntent] = useState<Action | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [importPage, setImportPage] = useState(0);
  const [uncertain, setUncertain] = useState<Action | null>(null);
  const focus = useRef<HTMLElement | null>(null);
  const allowed = useRef({ grants, writable: !readOnly && !busy });
  allowed.current = { grants, writable: !readOnly && !busy };
  const detail = useQuery({
    queryKey: [...key, operationId],
    queryFn: async () => {
      const row = FederationOutboundViewSchema.parse(
        (await api.get<{ data: unknown }>(base, scope)).data,
      );
      if (row.operationId !== operationId || row.localOrgId !== scope.organizationId)
        throw new Error("Task detail scope mismatch");
      return row;
    },
    refetchInterval: intent ? false : 10000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  const row = !detail.isError ? detail.data : null;
  const canReadResults = grants.includes("result.read");
  const imports = useQuery({
    queryKey: [...key, operationId, "imports", importPage],
    enabled: canReadResults,
    queryFn: async () => {
      const value = z
        .object({ data: z.array(FederationResultImportViewSchema), hasMore: z.boolean() })
        .parse(
          (
            await api.get<{ data: unknown }>(
              `${base}/result-imports?limit=20&offset=${importPage * 20}`,
              scope,
            )
          ).data,
        );
      if (value.data.some((value) => value.operationId !== operationId))
        throw new Error("Result import scope mismatch");
      return value;
    },
    refetchInterval: intent ? false : 10000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  const results = useQuery({
    queryKey: [...key, operationId, "results"],
    enabled: canReadResults && showResults,
    queryFn: async () => {
      const value = z
        .object({ report: FederationResultReportSchema, verifiedAt: z.iso.datetime() })
        .parse((await api.get<{ data: unknown }>(`${base}/results`, scope)).data);
      if (
        !row ||
        value.report.operationId !== operationId ||
        value.report.agreementRevisionId !== row.agreementRevisionId ||
        value.report.taskId !== row.taskId ||
        value.report.attempt !== row.attempt ||
        value.report.senderSiteId !== row.targetSiteId ||
        value.report.recipientSiteId !== row.localSiteId
      )
        throw new Error("Result scope mismatch");
      return value;
    },
    refetchOnWindowFocus: false,
  });
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: key });
  };
  const remote = useMutation({
    mutationFn: () => api.get(`${base}/remote-status`, scope),
    onSuccess: refresh,
  });
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      if (!allowed.current.writable || !allowed.current.grants.includes(required(action)) || !row)
        throw new Error("Task operation unavailable");
      if (action.kind === "import") {
        const value = FederationResultImportViewSchema.parse(
          (
            await api.post<{ data: unknown }>(
              `${base}/result-imports`,
              { importId: action.id },
              scope,
            )
          ).data,
        );
        if (value.operationId !== operationId) throw new Error("Result import response mismatch");
      } else if (action.kind === "receipt-retry") {
        const value = z
          .object({ id: z.uuid(), state: z.enum(["pending", "recorded"]) })
          .parse(
            (
              await api.post<{ data: unknown }>(
                `${base}/result-imports/${action.id}/receipt-retry`,
                {},
                scope,
              )
            ).data,
          );
        if (value.id !== action.id) throw new Error("Result receipt scope mismatch");
      } else if (action.kind === "import-cancel") {
        const value = FederationResultImportViewSchema.parse(
          (
            await api.post<{ data: unknown }>(
              `${base}/result-imports/${action.id}/cancel`,
              {},
              scope,
            )
          ).data,
        );
        if (value.id !== action.id || value.operationId !== operationId)
          throw new Error("Result import response mismatch");
      } else await api.post(`${base}/${action.kind}`, {}, scope);
    },
    onSuccess: async () => {
      setIntent(null);
      setUncertain(null);
      await refresh();
    },
    onError: (error, action) => {
      if (!(error instanceof ApiError && [400, 403, 409].includes(error.status)))
        setUncertain(action);
    },
  });
  useEffect(() => {
    if (intent && (readOnly || !grants.includes(required(intent)))) setIntent(null);
  }, [readOnly, grants, intent]);
  const review = (action: Action) => {
    focus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mutation.reset();
    setIntent(uncertain ?? action);
  };
  const download = useMutation({
    mutationFn: async ({ id, filename }: { id: string; filename: string }) => {
      if (!allowed.current.grants.includes("result.read"))
        throw new Error("Result access unavailable");
      const value = z
        .object({ downloadUrl: z.url() })
        .parse(
          (await api.get<{ data: unknown }>(`/netdrive/files/${id}/download-url`, scope)).data,
        );
      const url = new URL(value.downloadUrl);
      if (url.protocol !== "https:" && url.origin !== location.origin)
        throw new Error("Invalid download URL");
      if (!allowed.current.grants.includes("result.read")) return;
      const link = document.createElement("a");
      link.href = url.href;
      link.download = filename;
      link.rel = "noopener";
      link.click();
    },
  });
  const pending = busy || mutation.isPending || remote.isPending || detail.isFetching;
  const state = row?.cancellation
    ? `cancel_${row.cancellation.state}`
    : row?.remoteStatus.workflow
      ? `execution_${row.remoteStatus.workflow.status}`
      : row?.state;
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" disabled={mutation.isPending || !!uncertain} onClick={onBack}>
          {t("federation.tasks.back")}
        </Button>
      </div>
      {detail.isError ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : !row ? (
        <p role="status">{t("federation.loading")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="min-w-0 break-all font-semibold">
              {t("federation.tasks.task")} · {row.taskId.slice(0, 8)}
            </h3>
            <span role="status" className="text-sm">
              {t(`federation.tasks.states.${state}`)}
            </span>
          </div>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <AgreementFact label={t("federation.tasks.target")}>{row.targetSiteId}</AgreementFact>
            <AgreementFact label={t("federation.tasks.template")}>
              {t(`federation.tasks.kinds.${row.template.kind}`)} · {row.template.id}
            </AgreementFact>
            <AgreementFact label={t("federation.tasks.preparation")}>
              {row.remoteStatus.preparation
                ? t(`federation.tasks.preparationStates.${row.remoteStatus.preparation.state}`)
                : t("federation.tasks.unavailable")}
            </AgreementFact>
            <AgreementFact label={t("federation.tasks.observedAt")}>
              {row.remoteStatus.observedAt ? (
                <time dateTime={row.remoteStatus.observedAt}>
                  {new Date(row.remoteStatus.observedAt).toLocaleString(i18n.language)}
                </time>
              ) : (
                t("federation.tasks.unavailable")
              )}
            </AgreementFact>
          </dl>
          {row.lastError || row.remoteStatus.lastError || row.cancellation?.lastError ? (
            <p role="status" className="text-sm">
              {t("federation.tasks.attention")} ·{" "}
              {row.cancellation?.lastError ?? row.remoteStatus.lastError ?? row.lastError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {row.state === "accepted" ? (
              <Button variant="outline" disabled={pending} onClick={() => remote.mutate()}>
                {t("federation.tasks.queryRemote")}
              </Button>
            ) : null}
            {!readOnly &&
            grants.includes("delegation.submit") &&
            row.state === "needs_review" &&
            !row.cancellation ? (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => review({ kind: "retry" })}
              >
                {t("federation.tasks.retryOriginal")}
              </Button>
            ) : null}
            {!readOnly &&
            grants.includes("delegation.cancel") &&
            (!!row.cancellation ||
              !["completed", "failed", "cancelled"].includes(
                row.remoteStatus.workflow?.status ?? "",
              )) &&
            row.cancellation?.state !== "stopped" &&
            row.cancellation?.state !== "sending" ? (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => review({ kind: row.cancellation ? "cancel-retry" : "cancel" })}
              >
                {t(row.cancellation ? "federation.tasks.retryCancel" : "federation.tasks.cancel")}
              </Button>
            ) : null}
            {canReadResults && row.state === "accepted" ? (
              <Button
                variant="outline"
                disabled={pending || results.isFetching}
                onClick={() => {
                  setShowResults(true);
                  if (showResults) void results.refetch();
                }}
              >
                {t("federation.tasks.viewResults")}
              </Button>
            ) : null}
          </div>
          {remote.isError || results.isError || download.isError ? (
            <p role="alert" className="text-sm text-status-failed">
              {t("federation.tasks.failed")}
            </p>
          ) : null}
          {showResults && canReadResults && !results.isError && results.data ? (
            <section className="space-y-3 border-t border-border pt-5">
              <h4 className="font-semibold">{t("federation.tasks.results")}</h4>
              <p className="text-xs text-muted-foreground">
                {t("federation.tasks.observedAt")} ·{" "}
                {new Date(results.data.verifiedAt).toLocaleString(i18n.language)}
              </p>
              <ul className="divide-y divide-border text-sm">
                {results.data.report.manifest.outputs.flatMap((output) =>
                  output.files.map((file) => (
                    <li
                      key={`${output.outputId}:${file.path}`}
                      className="flex flex-wrap justify-between gap-2 py-3"
                    >
                      <span className="min-w-0 break-all">{file.path}</span>
                      <span className="text-muted-foreground">
                        {file.sizeBytes.toLocaleString(i18n.language)} B
                      </span>
                    </li>
                  )),
                )}
              </ul>
              {!readOnly ? (
                <Button
                  disabled={
                    pending ||
                    imports.isFetching ||
                    imports.isError ||
                    imports.data?.data.some(
                      (value) =>
                        value.state !== "cancelled" &&
                        value.manifestDigest === results.data?.report.manifestDigest,
                    )
                  }
                  onClick={() => review({ kind: "import", id: crypto.randomUUID() })}
                >
                  {t("federation.tasks.importResults")}
                </Button>
              ) : null}
            </section>
          ) : null}
          {canReadResults ? (
            <section className="space-y-3 border-t border-border pt-5">
              <h4 className="font-semibold">{t("federation.tasks.transfers")}</h4>
              {imports.isError ? (
                <p role="alert">{t("federation.loadFailed")}</p>
              ) : imports.isPending ? (
                <p role="status">{t("federation.loading")}</p>
              ) : (
                <>
                  {!imports.data.data.length ? (
                    <p className="text-sm text-muted-foreground">
                      {t("federation.tasks.noTransfers")}
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {imports.data.data.map((value) => (
                        <li key={value.id} className="space-y-3 py-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <span className="text-sm">
                              {t(`federation.tasks.importStates.${value.state}`)} ·{" "}
                              {value.id.slice(0, 8)}
                            </span>
                            {!readOnly &&
                            value.state !== "available" &&
                            value.state !== "cancelled" ? (
                              <Button
                                variant="ghost"
                                disabled={pending}
                                onClick={() => review({ kind: "import-cancel", id: value.id })}
                              >
                                {t("federation.tasks.cancelTransfer")}
                              </Button>
                            ) : null}
                          </div>
                          {value.receipt ? (
                            <div className="flex flex-wrap items-center gap-3 text-sm">
                              <span>{t(`federation.tasks.receipts.${value.receipt.state}`)}</span>
                              {!readOnly && value.receipt.state === "pending" ? (
                                <Button
                                  variant="ghost"
                                  disabled={pending}
                                  onClick={() => review({ kind: "receipt-retry", id: value.id })}
                                >
                                  {t("federation.tasks.retryReceipt")}
                                </Button>
                              ) : null}
                            </div>
                          ) : null}
                          {value.lastError ? (
                            <p role="status" className="text-sm">
                              {value.lastError}
                            </p>
                          ) : null}
                          <ul className="space-y-2 text-sm">
                            {value.members.map((file) => (
                              <li
                                key={file.id}
                                className="flex flex-wrap items-center justify-between gap-2"
                              >
                                <span className="min-w-0 break-all">{file.path}</span>
                                {value.state === "available" && file.fileId ? (
                                  <Button
                                    variant="ghost"
                                    disabled={download.isPending}
                                    onClick={() =>
                                      file.fileId &&
                                      download.mutate({
                                        id: file.fileId,
                                        filename: file.path.split("/").pop() ?? file.path,
                                      })
                                    }
                                  >
                                    {t("federation.tasks.download")}
                                  </Button>
                                ) : (
                                  <span className="text-muted-foreground">
                                    {t("federation.tasks.verifying")}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  )}
                  {importPage > 0 || imports.data.hasMore ? (
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        disabled={!importPage || imports.isFetching}
                        onClick={() => setImportPage((v) => v - 1)}
                      >
                        {t("federation.previous")}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!imports.data.hasMore || imports.isFetching}
                        onClick={() => setImportPage((v) => v + 1)}
                      >
                        {t("federation.next")}
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
            </section>
          ) : null}
          <details className="text-sm">
            <summary>{t("federation.billing.references")}</summary>
            <dl className="mt-3 grid gap-4 sm:grid-cols-2">
              <AgreementFact label={t("federation.tasks.task")}>{row.taskId}</AgreementFact>
              <AgreementFact label={t("federation.tasks.operation")}>
                {row.operationId}
              </AgreementFact>
              <AgreementFact label={t("federation.tasks.agreement")}>
                {row.agreementRevisionId}
              </AgreementFact>
              <AgreementFact label={t("federation.tasks.maxAmount")}>
                {row.maxAmount} {row.unit}
              </AgreementFact>
            </dl>
          </details>
        </>
      )}
      <Dialog
        open={!!intent}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setIntent(null);
        }}
      >
        <DialogContent
          dismissible={!mutation.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (focus.current?.isConnected) focus.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(`federation.tasks.actions.${intent?.kind ?? "cancel"}`)}</DialogTitle>
            <DialogDescription>
              {t(
                intent?.kind === "cancel" || intent?.kind === "cancel-retry"
                  ? "federation.tasks.cancelConfirmation"
                  : "federation.tasks.actionConfirmation",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="break-all text-sm">{row?.taskId}</p>
            {mutation.isError ? (
              <p role="alert" className="mt-3 text-sm">
                {t(uncertain ? "federation.tasks.unknown" : "federation.tasks.failed")}
                {mutation.error instanceof ApiError ? ` (${mutation.error.code})` : ""}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={mutation.isPending} onClick={() => setIntent(null)}>
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={
                pending ||
                !intent ||
                !allowed.current.writable ||
                !allowed.current.grants.includes(required(intent))
              }
              onClick={() => intent && mutation.mutate(intent)}
            >
              {t("federation.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {uncertain && !intent ? (
        <Button
          variant="outline"
          disabled={busy || readOnly || !grants.includes(required(uncertain))}
          onClick={() => review(uncertain)}
        >
          {t("federation.tasks.retryOriginal")}
        </Button>
      ) : null}
    </section>
  );
}

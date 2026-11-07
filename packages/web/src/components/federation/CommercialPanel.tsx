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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ApiError, type ApiOrganizationScope, api } from "../../lib/api-client";
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
import { CommercialDetail } from "./CommercialDetail";
import { CommercialEditor } from "./CommercialEditor";
import { CommercialTerms } from "./CommercialTerms";

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
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
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
  const canApprove = grants.includes("agreement.approve") && !readOnly;
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
      if (action.kind === "sign") setSelected(action.terms.agreement.agreementRevisionId);
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
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={switching || mutation.isPending || capabilities.isFetching || list.isFetching}
            onClick={refresh}
          >
            {t("federation.refresh")}
          </Button>
          {canApprove && !creating ? (
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
        </div>
      </div>
      {readOnly ? (
        <p className="text-sm text-muted-foreground">{t("federation.agreements.desktopOnly")}</p>
      ) : null}
      {context.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          {t(
            context.error instanceof ApiError && context.error.status === 404
              ? "federation.agreements.notConfigured"
              : "federation.loadFailed",
          )}
        </p>
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
          <Button variant="ghost" disabled={mutation.isPending} onClick={() => setSelected(null)}>
            {t("federation.commercial.back")}
          </Button>
          {detail.isError ? (
            <p role="alert">{t("federation.loadFailed")}</p>
          ) : detail.isPending ? (
            <p role="status">{t("federation.loading")}</p>
          ) : (
            <CommercialDetail
              key={detail.data.revisionId}
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
            />
          )}
        </>
      ) : list.isError ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : list.isPending ? (
        <p role="status">{t("federation.loading")}</p>
      ) : (
        <>
          {list.data.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {list.data.map((row) => (
                <li key={row.revisionId}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-3 p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:flex-row sm:justify-between"
                    onClick={() => setSelected(row.revisionId)}
                  >
                    <span className="min-w-0 space-y-1">
                      <span className="block break-words font-medium">
                        {row.sourceName || row.sourceSiteId} → {row.targetName || row.targetSiteId}
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">
                        {row.revisionId}
                      </span>
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
            <p className="py-8 text-sm text-muted-foreground">{t("federation.commercial.empty")}</p>
          )}
          {page > 0 || list.data.length === 20 ? (
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
            <div className="flex justify-end gap-2">
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

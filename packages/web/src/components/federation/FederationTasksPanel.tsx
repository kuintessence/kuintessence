import {
  FederationAgreementContextSchema,
  FederationCurrentCapabilitiesSchema,
  type FederationDelegation,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { FederationOutboundViewSchema } from "@kuintessence/shared/federation/outbound-views";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ApiError, type ApiOrganizationScope, api } from "../../lib/api-client";
import { federationReadFailed } from "../../lib/federation-query-state";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { Badge } from "../ui/badge";
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
import {
  FederationEmpty,
  FederationLoadError,
  FederationPanelHeader,
  FederationRefreshNotice,
} from "./FederationLayout";
import { FederationTaskCreate } from "./FederationTaskCreate";
import { FederationTaskDetail } from "./FederationTaskDetail";

export function FederationTasksPanel(props: { scope: ApiOrganizationScope; switching: boolean }) {
  return (
    <TasksPanel key={`${props.scope.organizationId}:${props.scope.authRevision}`} {...props} />
  );
}
function TasksPanel({ scope, switching }: { scope: ApiOrganizationScope; switching: boolean }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<FederationDelegation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const focus = useRef<HTMLElement | null>(null);
  const readOnly = useMobileMutationBlocked("/federation/outbound");
  const key = ["federation", "tasks", scope.organizationId, scope.authRevision];
  const capabilities = useQuery({
    queryKey: ["federation", "current-capabilities", scope.organizationId, scope.authRevision],
    queryFn: async () =>
      FederationCurrentCapabilitiesSchema.parse(
        (await api.get<{ data: unknown }>("/federation/capabilities", scope)).data,
      ),
  });
  const grants =
    !federationReadFailed(capabilities) && capabilities.data?.orgId === scope.organizationId
      ? capabilities.data.effectiveCapabilities
      : [];
  const canRead = grants.includes("delegation.read");
  const canSubmit = grants.includes("delegation.submit") && !readOnly && !capabilities.isError;
  const canPrepare =
    canSubmit && grants.includes("agreement.read") && grants.includes("asset.read");
  const allowed = useRef(false);
  allowed.current = canSubmit && !switching && !capabilities.isFetching;
  useEffect(() => {
    if (!canSubmit) {
      setConfirming(false);
      setCreating(false);
      setDraft(null);
    }
  }, [canSubmit]);
  const context = useQuery({
    queryKey: [...key, "context"],
    enabled: canPrepare,
    queryFn: async () =>
      FederationAgreementContextSchema.parse(
        (await api.get<{ data: unknown }>("/federation/agreements/context", scope)).data,
      ),
  });
  const list = useQuery({
    queryKey: [...key, "list", page],
    enabled: canRead && !creating && !selected,
    queryFn: async () => {
      const rows = z
        .array(FederationOutboundViewSchema)
        .parse(
          (
            await api.get<{ data: unknown }>(
              `/federation/outbound?limit=20&offset=${page * 20}`,
              scope,
            )
          ).data,
        );
      if (rows.some((row) => row.localOrgId !== scope.organizationId))
        throw new Error("Task scope mismatch");
      return rows;
    },
    refetchInterval: creating || confirming ? false : 10000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
  });
  const submit = useMutation({
    mutationFn: async (request: FederationDelegation) => {
      if (!allowed.current) throw new Error("Delegation unavailable");
      const row = FederationOutboundViewSchema.parse(
        (await api.post<{ data: unknown }>("/federation/outbound", request, scope)).data,
      );
      if (
        row.localOrgId !== scope.organizationId ||
        row.localSiteId !== request.senderSiteId ||
        row.targetSiteId !== request.recipientSiteId ||
        row.operationId !== request.operationId ||
        row.taskId !== request.taskId ||
        row.agreementRevisionId !== request.agreementRevisionId ||
        federationCanonicalJson(row.template) !== federationCanonicalJson(request.template)
      )
        throw new Error("Delegation response mismatch");
      return row.operationId;
    },
    onSuccess: async (operationId) => {
      setConfirming(false);
      setCreating(false);
      setDraft(null);
      if (allowed.current) setSelected(operationId);
      await client.invalidateQueries({ queryKey: key });
    },
  });
  const uncertain =
    submit.isError &&
    !(submit.error instanceof ApiError && [400, 403, 409].includes(submit.error.status));
  const busy =
    switching ||
    capabilities.isFetching ||
    submit.isPending ||
    capabilities.isError ||
    context.isError ||
    list.isError;
  allowed.current = allowed.current && !busy;
  if (capabilities.isPending) return <p role="status">{t("federation.loading")}</p>;
  if (federationReadFailed(capabilities) || (canRead && federationReadFailed(context)))
    return (
      <FederationLoadError
        onRetry={() => {
          void capabilities.refetch();
          void client.invalidateQueries({ queryKey: key });
        }}
      />
    );
  if (!canRead) return <p role="status">{t("federation.tasks.noPermission")}</p>;
  return (
    <div className="space-y-5">
      <FederationRefreshNotice query={capabilities} onRetry={() => void capabilities.refetch()} />
      <FederationRefreshNotice query={context} onRetry={() => void context.refetch()} />
      <FederationRefreshNotice query={list} onRetry={() => void list.refetch()} />
      <FederationPanelHeader title={t("federation.tasks.title")}>
        {canPrepare && !creating && !selected ? (
          <Button
            disabled={busy || !context.data || context.isError}
            onClick={() => {
              submit.reset();
              setCreating(true);
            }}
          >
            {t("federation.tasks.new")}
          </Button>
        ) : null}
      </FederationPanelHeader>
      {readOnly ? (
        <p className="text-sm text-muted-foreground">{t("federation.agreements.desktopOnly")}</p>
      ) : null}
      {canSubmit && !canPrepare ? (
        <p role="status" className="text-sm">
          {t("federation.tasks.preparePermission")}
        </p>
      ) : null}
      {context.isError ? <p role="alert">{t("federation.agreements.notConfigured")}</p> : null}
      {creating && context.data ? (
        draft ? (
          <div className="max-w-3xl space-y-4">
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <AgreementFact label={t("federation.tasks.task")}>{draft.taskId}</AgreementFact>
              <AgreementFact label={t("federation.tasks.agreement")}>
                {draft.agreementRevisionId}
              </AgreementFact>
            </dl>
            {submit.isError && !confirming ? (
              <p role="alert">
                {t(uncertain ? "federation.tasks.unknown" : "federation.tasks.failed")}
                {submit.error instanceof ApiError ? ` (${submit.error.code})` : ""}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy || !canSubmit} onClick={() => setConfirming(true)}>
                {t(uncertain ? "federation.tasks.retryOriginal" : "federation.tasks.review")}
              </Button>
              <Button
                variant="ghost"
                disabled={busy || uncertain}
                onClick={() => {
                  setDraft(null);
                  submit.reset();
                }}
              >
                {t("federation.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <FederationTaskCreate
            scope={scope}
            localSiteId={context.data.localSiteId}
            supportedModes={context.data.supportedModes}
            disabled={busy}
            onCancel={() => setCreating(false)}
            onReview={(value) => {
              focus.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
              setDraft(value);
              setConfirming(true);
            }}
          />
        )
      ) : selected ? (
        <FederationTaskDetail
          key={selected}
          scope={scope}
          operationId={selected}
          grants={grants}
          readOnly={readOnly}
          busy={busy}
          onBack={() => setSelected(null)}
        />
      ) : federationReadFailed(list) ? (
        <FederationLoadError onRetry={() => void list.refetch()} />
      ) : list.isPending || !list.data ? (
        <p role="status">{t("federation.loading")}</p>
      ) : (
        <>
          {!list.data.length ? (
            <FederationEmpty>{t("federation.tasks.empty")}</FederationEmpty>
          ) : (
            <ul className="federation-list divide-y divide-border">
              {list.data.map((row) => (
                <li key={row.operationId}>
                  <button
                    type="button"
                    className="federation-list-row flex w-full flex-wrap items-center justify-between gap-3 rounded-md px-3 py-4 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setSelected(row.operationId)}
                  >
                    <span className="min-w-0">
                      <span className="block break-all text-sm font-medium">
                        {t(`federation.tasks.kinds.${row.template.kind}`)} ·{" "}
                        {row.taskId.slice(0, 8)}
                      </span>
                      <time className="text-xs text-muted-foreground" dateTime={row.createdAt}>
                        {new Date(row.createdAt).toLocaleString(i18n.language)}
                      </time>
                    </span>
                    <Badge variant="outline" className="max-w-full whitespace-normal">
                      {t(
                        `federation.tasks.states.${row.cancellation ? `cancel_${row.cancellation.state}` : row.remoteStatus.workflow ? `execution_${row.remoteStatus.workflow.status}` : row.state}`,
                      )}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!page || list.isFetching}
              onClick={() => setPage((v) => v - 1)}
            >
              {t("federation.previous")}
            </Button>
            <Button
              variant="outline"
              disabled={list.isFetching || list.data.length !== 20}
              onClick={() => setPage((v) => v + 1)}
            >
              {t("federation.next")}
            </Button>
          </div>
        </>
      )}
      <Dialog
        open={confirming && canSubmit}
        onOpenChange={(value) => {
          if (!submit.isPending) setConfirming(value);
        }}
      >
        <DialogContent
          dismissible={!submit.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (focus.current?.isConnected) focus.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("federation.tasks.review")}</DialogTitle>
            <DialogDescription>{t("federation.tasks.confirmation")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {draft ? (
              <>
                <dl className="grid gap-4 text-sm sm:grid-cols-2">
                  <AgreementFact label={t("federation.tasks.target")}>
                    {draft.recipientSiteId}
                  </AgreementFact>
                  <AgreementFact label={t("federation.tasks.maxAmount")}>
                    {draft.maxAmount} {draft.unit}
                  </AgreementFact>
                  <AgreementFact label={t("federation.tasks.arbitration")}>
                    {t("federation.tasks.noArbitration")}
                  </AgreementFact>
                  <AgreementFact label={t("federation.tasks.cpus")}>
                    {draft.resources.cpus}
                  </AgreementFact>
                  <AgreementFact label={t("federation.tasks.memoryMb")}>
                    {draft.resources.memoryMb}
                  </AgreementFact>
                  <AgreementFact label={t("federation.tasks.gpus")}>
                    {draft.resources.gpus}
                  </AgreementFact>
                  <AgreementFact label={t("federation.tasks.wallTimeSec")}>
                    {draft.resources.wallTimeSec}
                  </AgreementFact>
                </dl>
                <details className="text-sm">
                  <summary>{t("federation.billing.references")}</summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(draft, null, 2)}
                  </pre>
                </details>
              </>
            ) : null}
            {submit.isError ? (
              <p role="alert">
                {t(uncertain ? "federation.tasks.unknown" : "federation.tasks.failed")}
                {submit.error instanceof ApiError ? ` (${submit.error.code})` : ""}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={submit.isPending}
              onClick={() => setConfirming(false)}
            >
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={busy || !draft || !canSubmit}
              onClick={() => draft && submit.mutate(draft)}
            >
              {t("federation.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

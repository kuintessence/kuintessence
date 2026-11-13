import {
  type FederationCapability,
  FederationDigestSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { ArbitrationDecisionSchema } from "@kuintessence/shared/federation/arbitration-decision";
import {
  type ArbitrationResolutionView,
  ArbitrationResolutionViewSchema,
} from "@kuintessence/shared/federation/arbitration-resolution";
import type { CommercialAgreementApproval } from "@kuintessence/shared/federation/commercial";
import type { CommercialDispute } from "@kuintessence/shared/federation/disputes";
import { useMutation, useQuery } from "@tanstack/react-query";
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

const receivedSchema = z.object({
  payload: ArbitrationDecisionSchema,
  digest: FederationDigestSchema,
  receivedAt: z.iso.datetime(),
});
export function CommercialArbitrationPanel({
  approval,
  dispute,
  caseDigest,
  scope,
  grants,
  readOnly,
  busy,
  execution,
  resolved,
  onChanged,
}: {
  approval: CommercialAgreementApproval;
  dispute: CommercialDispute;
  caseDigest: string;
  scope: ApiOrganizationScope;
  grants: readonly FederationCapability[];
  readOnly: boolean;
  busy: boolean;
  resolved: boolean;
  execution: ArbitrationResolutionView | null | undefined;
  onChanged: () => Promise<unknown>;
}) {
  const { t, i18n } = useTranslation();
  const [intent, setIntent] = useState<"execute" | "ledger" | null>(null);
  const focus = useRef<HTMLElement | null>(null);
  const canRead = grants.includes("arbitration.approve") || grants.includes("arbitration.execute");
  const canExecute = canRead && grants.includes("arbitration.execute") && !readOnly;
  const allowed = useRef(false);
  allowed.current = canExecute && !busy;
  const path = `/federation/commercial-agreements/${approval.revisionId}/disputes/${dispute.caseId}`;
  const decision = useQuery({
    queryKey: [
      "federation",
      "commercial",
      scope.organizationId,
      scope.authRevision,
      "disputes",
      approval.revisionId,
      dispute.caseId,
      "decision",
    ],
    enabled: canRead,
    queryFn: async () => {
      const value = receivedSchema
        .nullable()
        .parse((await api.get<{ data: unknown }>(`${path}/arbitration-decision`, scope)).data);
      if (value) {
        const b = value.payload.intent.binding;
        if (
          b.caseId !== dispute.caseId ||
          b.caseDigest !== caseDigest ||
          b.agreementRevisionId !== approval.revisionId ||
          b.agreementDigest !== approval.digest ||
          b.domainId !== approval.terms.domainId ||
          b.sourceSiteId !== dispute.sourceSiteId ||
          b.targetSiteId !== dispute.targetSiteId ||
          b.taskId !== dispute.taskId ||
          b.attempt !== dispute.attempt ||
          b.mode !== approval.terms.agreement.mode ||
          b.unit !== approval.terms.agreement.unit
        )
          throw new Error("Arbitration decision scope mismatch");
      }
      return value;
    },
    refetchInterval: intent || resolved ? false : 10000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
  });
  const mutation = useMutation({
    mutationFn: async (action: "execute" | "ledger") => {
      if (!allowed.current || decision.isError || !decision.data)
        throw new Error("Arbitration execution unavailable");
      if (action === "ledger") {
        if (execution?.ledger?.state !== "needs_review")
          throw new Error("Ledger retry unavailable");
        await api.post(
          `/federation/commercial-agreements/${approval.revisionId}/submissions/${execution.ledger.id}/retry`,
          {},
          scope,
        );
      } else {
        if (
          execution?.withdrawnAt ||
          execution?.withdrawalRequestedAt ||
          execution?.appliedAt ||
          resolved
        )
          throw new Error("Arbitration execution closed");
        const value = ArbitrationResolutionViewSchema.parse(
          (await api.post<{ data: unknown }>(`${path}/arbitration-resolution`, {}, scope)).data,
        );
        if (
          value.payload.decisionId !== decision.data.payload.intent.decisionId ||
          value.payload.decisionDigest !== decision.data.digest ||
          value.payload.caseId !== dispute.caseId ||
          value.payload.caseDigest !== caseDigest ||
          federationCanonicalJson(value.payload.outcome) !==
            federationCanonicalJson(decision.data.payload.intent.outcome)
        )
          throw new Error("Arbitration execution response mismatch");
      }
    },
    onSuccess: async () => {
      setIntent(null);
      await onChanged();
    },
  });
  useEffect(() => {
    if (!canExecute) setIntent(null);
  }, [canExecute]);
  const review = (value: "execute" | "ledger") => {
    focus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mutation.reset();
    setIntent(value);
  };
  const original = canRead && !decision.isError ? decision.data : null;
  const outcome = original?.payload.intent.outcome;
  const status = execution?.withdrawnAt
    ? "withdrawn"
    : execution?.withdrawalRequestedAt
      ? "withdrawing"
      : execution?.appliedAt
        ? "applied"
        : execution
          ? "approved"
          : "notApproved";
  const blocked = busy || mutation.isPending || decision.isFetching || execution === undefined;
  return (
    <section className="space-y-4 border-b border-border pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="font-semibold">{t("federation.arbitration.title")}</h4>
        {canRead ? (
          <Button
            variant="ghost"
            disabled={blocked}
            onClick={() => {
              void decision.refetch();
              void onChanged();
            }}
          >
            {t("federation.refresh")}
          </Button>
        ) : null}
      </div>
      {!canRead ? (
        <p className="text-sm text-muted-foreground">
          {t("federation.arbitration.readPermission")}
        </p>
      ) : decision.isError ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : decision.isPending ? (
        <p role="status">{t("federation.loading")}</p>
      ) : original && outcome ? (
        <>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <AgreementFact label={t("federation.arbitration.outcome")}>
              {t(`federation.arbitration.actions.${outcome.action}`)}
            </AgreementFact>
            <AgreementFact label={t("federation.arbitration.execution")}>
              {t(`federation.arbitration.states.${status}`)}
            </AgreementFact>
            {outcome.action !== "resolve-without-financial-change" ? (
              <AgreementFact label={t("federation.arbitration.charge")}>
                {outcome.chargedAmount} {approval.terms.agreement.unit}
              </AgreementFact>
            ) : null}
            {execution ? (
              <AgreementFact label={t("federation.arbitration.approvedHold")}>
                {execution.approvedHeldAmount} {approval.terms.agreement.unit}
              </AgreementFact>
            ) : null}
            <AgreementFact label={t("federation.arbitration.receivedAt")}>
              <time dateTime={original.receivedAt}>
                {new Date(original.receivedAt).toLocaleString(i18n.language)}
              </time>
            </AgreementFact>
            {execution?.appliedAt ? (
              <AgreementFact label={t("federation.arbitration.appliedAt")}>
                <time dateTime={execution.appliedAt}>
                  {new Date(execution.appliedAt).toLocaleString(i18n.language)}
                </time>
              </AgreementFact>
            ) : null}
          </dl>
          <p className="max-w-prose break-words text-sm">{original.payload.intent.reason}</p>
          {execution?.lastError ? (
            <p role="status" className="text-sm">
              {t(`federation.dispute.errors.${execution.lastError}`, {
                defaultValue: t("federation.arbitration.retrying"),
              })}
            </p>
          ) : null}
          {execution?.nextAttemptAt ? (
            <p className="text-xs text-muted-foreground">
              {t("federation.arbitration.nextAttempt")}:{" "}
              <time dateTime={execution.nextAttemptAt}>
                {new Date(execution.nextAttemptAt).toLocaleString(i18n.language)}
              </time>
            </p>
          ) : null}
          {canExecute && !execution && !resolved ? (
            <Button disabled={blocked} onClick={() => review("execute")}>
              {t("federation.arbitration.execute")}
            </Button>
          ) : null}
          {approval.terms.agreement.mode !== "bilateral_direct" && execution ? (
            <div className="space-y-2 text-sm">
              <p>
                {t("federation.commercial.ledger")}:{" "}
                {t(`federation.arbitration.ledger.${execution.ledger?.state ?? "notQueued"}`)}
              </p>
              {execution.ledger?.lastError ? (
                <p className="text-status-failed">
                  {t(`federation.dispute.errors.${execution.ledger.lastError}`, {
                    defaultValue: t("federation.commercial.checkConfiguration"),
                  })}
                </p>
              ) : null}
              {canExecute && execution.ledger?.state === "needs_review" ? (
                <Button variant="outline" disabled={blocked} onClick={() => review("ledger")}>
                  {t("federation.dispute.retryLedger")}
                </Button>
              ) : null}
            </div>
          ) : null}
          <details className="text-sm">
            <summary className="cursor-pointer">{t("federation.billing.references")}</summary>
            <dl className="mt-3 grid gap-4 sm:grid-cols-2">
              <AgreementFact label={t("federation.arbitration.decisionId")}>
                {original.payload.intent.decisionId}
              </AgreementFact>
              <AgreementFact label={t("federation.arbitration.digest")}>
                {original.digest}
              </AgreementFact>
              <AgreementFact label={t("federation.arbitration.arbitrator")}>
                {original.payload.intent.binding.arbitratorSiteId}
              </AgreementFact>
              {outcome.action !== "resolve-without-financial-change" ? (
                <AgreementFact label={t("federation.arbitration.bill")}>
                  {outcome.bill.recordId}
                </AgreementFact>
              ) : null}
            </dl>
          </details>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t("federation.arbitration.waiting")}</p>
      )}
      <Dialog
        open={intent !== null}
        onOpenChange={(value) => {
          if (!mutation.isPending && !value) setIntent(null);
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
                intent === "ledger"
                  ? "federation.dispute.retryLedger"
                  : "federation.arbitration.execute",
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                intent === "ledger"
                  ? "federation.arbitration.retryConfirmation"
                  : approval.terms.agreement.mode === "ledger_coordinated"
                    ? "federation.arbitration.coordinatedConfirmation"
                    : "federation.arbitration.executionConfirmation",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {outcome ? (
              <p className="break-words text-sm">
                {t(`federation.arbitration.actions.${outcome.action}`)}
                {outcome.action !== "resolve-without-financial-change"
                  ? ` · ${outcome.chargedAmount} ${approval.terms.agreement.unit}`
                  : ""}
              </p>
            ) : null}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {mutation.error instanceof ApiError
                  ? t(`federation.dispute.errors.${mutation.error.code}`, {
                      defaultValue: t("federation.dispute.failed"),
                    })
                  : t("federation.dispute.failed")}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={mutation.isPending} onClick={() => setIntent(null)}>
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={blocked || !canExecute || !intent || !original}
              onClick={() => intent && mutation.mutate(intent)}
            >
              {t("federation.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

import { AgreementApprovalExchangeViewSchema } from "@kuintessence/shared/federation/agreement-exchange";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, type ApiOrganizationScope, api } from "../../lib/api-client";
import { Button } from "../ui/button";

export function AgreementExchangeStatus({
  scope,
  revisionId,
  writable,
  busy,
  onRetry,
}: {
  scope: ApiOrganizationScope;
  revisionId: string;
  writable: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const status = useQuery({
    queryKey: [
      "federation",
      "agreements",
      scope.organizationId,
      scope.authRevision,
      "exchange",
      revisionId,
    ],
    queryFn: async () =>
      AgreementApprovalExchangeViewSchema.parse(
        (await api.get<{ data: unknown }>(`/federation/agreements/${revisionId}/exchange`, scope))
          .data,
      ),
  });
  const sync = status.data?.sync;
  const unsupported = status.error instanceof ApiError && status.error.status === 404;
  const error = sync?.lastError;
  const reason =
    error === "UNTRUSTED_IDENTITY"
      ? "trust"
      : error === "AGREEMENT_UNAVAILABLE"
        ? "agreement"
        : error === "POLICY_DENIED"
          ? "permission"
          : error === "OPERATION_CONFLICT"
            ? "conflict"
            : error === "INVALID_MESSAGE" || error === "INVALID_RECEIPT_RESPONSE"
              ? "invalid"
              : "connection";
  return (
    <section aria-labelledby={id} className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={id} className="text-sm font-semibold">
          {t("federation.agreements.exchange.title")}
        </h3>
        {!status.isError && status.data?.enabled && sync?.state === "needs_review" && writable ? (
          <Button variant="outline" disabled={busy || status.isFetching} onClick={onRetry}>
            {t("federation.agreements.actions.exchange")}
          </Button>
        ) : null}
      </div>
      {status.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          {t(unsupported ? "federation.agreements.exchange.unavailable" : "federation.loadFailed")}
        </p>
      ) : status.isPending ? (
        <p role="status" className="text-sm">
          {t("federation.loading")}
        </p>
      ) : (
        <>
          <p role="status" className="text-sm">
            {t(`federation.agreements.exchange.states.${sync?.state ?? "absent"}`)}
          </p>
          {!status.data.enabled ? (
            <p className="text-sm text-muted-foreground">
              {t("federation.agreements.exchange.disabled")}
            </p>
          ) : null}
          {error ? (
            <div role="alert" className="space-y-1 text-sm text-status-failed">
              <p>{t(`federation.agreements.exchange.errors.${reason}`)}</p>
              <code className="block break-all text-xs">{error}</code>
            </div>
          ) : null}
          {sync?.verifiedAt ? (
            <p className="text-sm text-muted-foreground">
              {t("federation.agreements.exchange.verifiedAt")}{" "}
              {new Date(sync.verifiedAt).toLocaleString(i18n.language)}
            </p>
          ) : status.data.enabled && sync?.state === "pending" ? (
            <p className="text-sm text-muted-foreground">
              {t("federation.agreements.exchange.nextAttemptAt")}{" "}
              {new Date(sync.nextAttemptAt).toLocaleString(i18n.language)}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

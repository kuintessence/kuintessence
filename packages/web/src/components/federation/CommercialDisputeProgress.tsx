import type { CommercialAgreementApproval } from "@kuintessence/shared/federation/commercial";
import type { CommercialDispute } from "@kuintessence/shared/federation/disputes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ApiError, type ApiOrganizationScope, api } from "../../lib/api-client";
import { Button } from "../ui/button";

const sync = z.object({
  state: z.enum(["pending", "received", "needs_review", "confirmed", "ledger_pending"]),
  lastError: z.string().nullable(),
  nextAttemptAt: z.iso.datetime().nullable(),
});
const deliverySchema = z.object({ enabled: z.boolean(), sync: sync.nullable() });
const freezeSchema = deliverySchema.extend({
  sync: sync
    .extend({ confirmedAt: z.iso.datetime().nullable(), headDigest: z.string().nullable() })
    .nullable(),
  attestation: z
    .object({
      state: z.enum(["pending", "committed", "needs_review"]),
      lastError: z.string().nullable(),
    })
    .nullable(),
});

export function CommercialDisputeProgress({
  approval,
  dispute,
  scope,
  writable,
  busy,
  resolved,
}: {
  approval: CommercialAgreementApproval;
  dispute: CommercialDispute;
  scope: ApiOrganizationScope;
  writable: boolean;
  busy: boolean;
  resolved: boolean;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const key = [
    "federation",
    "commercial",
    scope.organizationId,
    scope.authRevision,
    "disputes",
    approval.revisionId,
    dispute.caseId,
    "progress",
  ];
  const path = `/federation/commercial-agreements/${approval.revisionId}/disputes/${dispute.caseId}`;
  const origin = dispute.openingSiteId === approval.localSiteId;
  const allowed = useRef(false);
  allowed.current = writable && !busy && !resolved;
  const progress = useQuery({
    queryKey: key,
    queryFn: async () => {
      const [delivery, freeze] = await Promise.all([
        api.get<{ data: unknown }>(`${path}/delivery`, scope),
        api.get<{ data: unknown }>(`${path}/freeze`, scope),
      ]);
      return {
        delivery: deliverySchema.parse(delivery.data),
        freeze: freezeSchema.parse(freeze.data),
      };
    },
    refetchOnWindowFocus: false,
    refetchInterval: resolved ? false : 10000,
    refetchIntervalInBackground: false,
  });
  const retry = useMutation({
    mutationFn: async (kind: "delivery" | "freeze") => {
      if (!allowed.current || (kind === "delivery" && !origin))
        throw new Error("Dispute retry unavailable");
      await api.post(`${path}/${kind}/retry`, {}, scope);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: key.slice(0, -1) }),
  });
  return (
    <section className="space-y-3 border-y border-border py-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-semibold">{t("federation.dispute.progress.title")}</h4>
        <Button
          variant="ghost"
          disabled={busy || progress.isFetching || retry.isPending}
          onClick={() => void progress.refetch()}
        >
          {t("federation.refresh")}
        </Button>
      </div>
      {progress.isError ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : progress.isPending ? (
        <p role="status">{t("federation.loading")}</p>
      ) : (
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          {(["delivery", "freeze"] as const).map((kind) => {
            const item = progress.data[kind];
            const state =
              item.sync?.state ??
              (!origin && kind === "delivery" ? "received" : item.enabled ? "waiting" : "disabled");
            const canRetry =
              writable &&
              !resolved &&
              item.enabled &&
              item.sync &&
              ["pending", "needs_review", "ledger_pending"].includes(state) &&
              (origin ||
                (kind === "freeze" &&
                  approval.terms.agreement.mode === "ledger_coordinated" &&
                  progress.data.freeze.sync?.headDigest));
            return (
              <div key={kind} className="space-y-2">
                <dt className="font-medium">{t(`federation.dispute.progress.${kind}`)}</dt>
                <dd className="space-y-2">
                  <p>{t(`federation.dispute.progress.states.${state}`)}</p>
                  {item.sync?.lastError ? (
                    <p className="break-words text-status-failed">
                      {t(`federation.dispute.errors.${item.sync.lastError}`, {
                        defaultValue: t("federation.dispute.failed"),
                      })}
                    </p>
                  ) : null}
                  {kind === "freeze" && progress.data.freeze.sync?.confirmedAt ? (
                    <time
                      className="block text-xs text-muted-foreground"
                      dateTime={progress.data.freeze.sync.confirmedAt}
                    >
                      {new Date(progress.data.freeze.sync.confirmedAt).toLocaleString(
                        i18n.language,
                      )}
                    </time>
                  ) : null}
                  {kind === "freeze" && progress.data.freeze.attestation ? (
                    <p>
                      {t("federation.commercial.ledger")}:{" "}
                      {t(`federation.dispute.ledger.${progress.data.freeze.attestation.state}`)}
                    </p>
                  ) : null}
                  {canRetry ? (
                    <Button
                      variant="outline"
                      disabled={busy || retry.isPending}
                      onClick={() => retry.mutate(kind)}
                    >
                      {t(
                        `federation.dispute.progress.retry${kind === "delivery" ? "Delivery" : "Freeze"}`,
                      )}
                    </Button>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {retry.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          {retry.error instanceof ApiError
            ? t(`federation.dispute.errors.${retry.error.code}`, {
                defaultValue: t("federation.dispute.failed"),
              })
            : t("federation.dispute.failed")}
        </p>
      ) : null}
    </section>
  );
}

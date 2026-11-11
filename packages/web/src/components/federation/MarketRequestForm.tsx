import {
  type CommercialAgreementApproval,
  type ReservationPolicy,
  ReservationPolicySchema,
} from "@kuintessence/shared/federation/commercial";
import type { MarketRequest } from "@kuintessence/shared/federation/market-request";
import { FederationMaterialOptionSchema } from "@kuintessence/shared/federation/outbound-views";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { buildMarketRequest, policyUsable } from "./market-request-view";

export function MarketRequestForm({
  approval,
  scope,
  disabled,
  onReview,
  onCancel,
}: {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  disabled: boolean;
  onReview: (request: MarketRequest, policyId: string) => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [policyPage, setPolicyPage] = useState(0);
  const [materialPage, setMaterialPage] = useState(0);
  const [policy, setPolicy] = useState<ReservationPolicy | null>(null);
  const [snapshots, setSnapshots] = useState({ inputs: "", "environment-lock": "" });
  const [invalid, setInvalid] = useState(false);
  const terms = approval.terms.agreement;
  const key = [
    "federation",
    "market-request-options",
    scope.organizationId,
    scope.authRevision,
    approval.revisionId,
  ];
  const policies = useQuery({
    queryKey: [...key, "policies", policyPage],
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const rows = z
        .array(ReservationPolicySchema)
        .max(20)
        .parse(
          (
            await api.get<{ data: unknown }>(
              `/federation/commercial-agreements/${approval.revisionId}/reservation-policies?limit=20&offset=${policyPage * 20}`,
              scope,
            )
          ).data,
        );
      if (
        rows.some(
          (row) =>
            row.localOrgId !== scope.organizationId ||
            row.localSiteId !== approval.localSiteId ||
            row.agreementRevisionId !== approval.revisionId ||
            row.agreementDigest !== approval.digest,
        )
      )
        throw new Error("Policy scope mismatch");
      return rows;
    },
  });
  const materials = useQuery({
    queryKey: [...key, "materials", materialPage],
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const result = z
        .object({ data: z.array(FederationMaterialOptionSchema).max(20), hasMore: z.boolean() })
        .parse(
          (
            await api.get<{ data: unknown }>(
              `/federation/assets/materials?limit=20&offset=${materialPage * 20}`,
              scope,
            )
          ).data,
        );
      if (result.data.some((row) => row.localOrgId !== scope.organizationId))
        throw new Error("Material scope mismatch");
      return result;
    },
  });
  const choices = policies.data?.filter((row) => policyUsable(row, approval)) ?? [];
  const busy = disabled || policies.isFetching || materials.isFetching;
  const selectClass =
    "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm";
  return (
    <form
      className="max-w-3xl space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !policy || policies.isError || materials.isError) return;
        try {
          const request = buildMarketRequest(approval, policy, new FormData(event.currentTarget));
          setInvalid(false);
          onReview(request, policy.id);
        } catch {
          setInvalid(true);
        }
      }}
    >
      <h3 className="font-semibold">{t("federation.marketRequest.create")}</h3>
      <p className="max-w-prose text-sm text-muted-foreground">
        {t("federation.market.publicWarning")}
      </p>
      {policies.isError || materials.isError ? (
        <div role="alert" className="space-y-2">
          <p>{t("federation.tasks.optionsFailed")}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void policies.refetch();
              void materials.refetch();
            }}
          >
            {t("federation.refresh")}
          </Button>
        </div>
      ) : null}
      <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="space-y-1 text-sm sm:col-span-2">
          <label htmlFor={`${id}-policy`}>{t("federation.marketRequest.policy")}</label>
          <select
            id={`${id}-policy`}
            required
            className={selectClass}
            value={policy?.id ?? ""}
            onChange={(event) =>
              setPolicy(choices.find((row) => row.id === event.target.value) ?? null)
            }
          >
            <option value="">{t("federation.marketRequest.choosePolicy")}</option>
            {policy && !choices.some((row) => row.id === policy.id) ? (
              <option value={policy.id}>{policy.id}</option>
            ) : null}
            {choices.map((row) => (
              <option key={row.id} value={row.id}>
                {row.id} · {row.maxTaskAmount} {terms.unit}
              </option>
            ))}
          </select>
        </div>
        {policies.data && !choices.length ? (
          <p className="text-sm sm:col-span-2">{t("federation.marketRequest.noPolicy")}</p>
        ) : null}
        {policyPage > 0 || policies.data?.length === 20 ? (
          <div className="flex gap-2 sm:col-span-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy || policyPage === 0}
              onClick={() => setPolicyPage(policyPage - 1)}
            >
              {t("federation.previous")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || policies.data?.length !== 20}
              onClick={() => setPolicyPage(policyPage + 1)}
            >
              {t("federation.next")}
            </Button>
          </div>
        ) : null}
        {["title", "platform", "architecture", "expiresAt"].map((field) => (
          <div
            key={field}
            className={`min-w-0 space-y-1 text-sm ${field === "title" ? "sm:col-span-2" : ""}`}
          >
            <label htmlFor={`${id}-${field}`}>
              {t(
                field === "expiresAt"
                  ? "federation.marketRequest.expiresAt"
                  : `federation.market.fields.${field}`,
              )}
            </label>
            <Input
              id={`${id}-${field}`}
              name={field}
              required
              type={field === "expiresAt" ? "datetime-local" : "text"}
              maxLength={field === "title" ? 160 : 64}
              defaultValue={
                field === "expiresAt"
                  ? new Date(Date.now() + 900000 - new Date().getTimezoneOffset() * 60000)
                      .toISOString()
                      .slice(0, 16)
                  : undefined
              }
            />
          </div>
        ))}
        <div className="space-y-1 text-sm sm:col-span-2">
          <label htmlFor={`${id}-description`}>{t("federation.market.fields.description")}</label>
          <textarea
            id={`${id}-description`}
            name="description"
            maxLength={4096}
            rows={3}
            className="w-full rounded-md border border-input bg-background p-3"
          />
        </div>
        <div className="min-w-0 space-y-1 text-sm sm:col-span-2">
          <label htmlFor={`${id}-template`}>{t("federation.tasks.template")}</label>
          <select id={`${id}-template`} name="template" className={selectClass} required>
            {terms.templates.map((ref, index) => (
              <option key={`${ref.id}:${ref.revision}`} value={index}>
                {t(`federation.tasks.kinds.${ref.kind}`)} · {ref.id} · {ref.revision}
              </option>
            ))}
          </select>
        </div>
        {(["inputs", "environment-lock"] as const).map((kind) => {
          const rows =
            materials.data?.data.filter(
              (row) => row.kind === kind && row.originSiteId === approval.localSiteId,
            ) ?? [];
          return (
            <div key={kind} className="min-w-0 space-y-1 text-sm">
              <label htmlFor={`${id}-${kind}`}>
                {t(kind === "inputs" ? "federation.tasks.inputs" : "federation.tasks.environment")}
              </label>
              <select
                id={`${id}-${kind}`}
                name={kind}
                className={selectClass}
                required
                value={snapshots[kind]}
                onChange={(event) => setSnapshots({ ...snapshots, [kind]: event.target.value })}
              >
                <option value="">{t("federation.tasks.chooseSnapshot")}</option>
                {snapshots[kind] && !rows.some((row) => row.digest === snapshots[kind]) ? (
                  <option value={snapshots[kind]}>{snapshots[kind].slice(7, 19)}</option>
                ) : null}
                {rows.map((row) => (
                  <option key={row.digest} value={row.digest}>
                    {new Date(row.createdAt).toLocaleString(i18n.language)} ·{" "}
                    {row.digest.slice(7, 19)}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
        {materialPage > 0 || materials.data?.hasMore ? (
          <div className="flex gap-2 sm:col-span-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy || materialPage === 0}
              onClick={() => setMaterialPage(materialPage - 1)}
            >
              {t("federation.previous")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !materials.data?.hasMore}
              onClick={() => setMaterialPage(materialPage + 1)}
            >
              {t("federation.next")}
            </Button>
          </div>
        ) : null}
        {(["cpus", "memoryMb", "gpus", "wallTimeSec"] as const).map((field) => (
          <div key={field} className="space-y-1 text-sm">
            <label htmlFor={`${id}-${field}`}>{t(`federation.tasks.${field}`)}</label>
            <Input
              id={`${id}-${field}`}
              name={field}
              type="number"
              min={field === "gpus" ? 0 : 1}
              max={terms.resourceLimit[field]}
              step={1}
              required
              defaultValue={Math.min(
                { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 60 }[field],
                terms.resourceLimit[field],
              )}
            />
          </div>
        ))}
        <div className="space-y-1 text-sm">
          <label htmlFor={`${id}-amount`}>
            {t("federation.tasks.maxAmount")} · {terms.unit}
          </label>
          <Input
            id={`${id}-amount`}
            name="maxAmount"
            inputMode="numeric"
            pattern="(0|[1-9][0-9]{0,37})"
            defaultValue="0"
            required
          />
        </div>
      </fieldset>
      {invalid ? <p role="alert">{t("federation.marketRequest.invalid")}</p> : null}
      <div className="flex gap-2">
        <Button
          disabled={
            busy ||
            policies.isError ||
            materials.isError ||
            !policy ||
            !snapshots.inputs ||
            !snapshots["environment-lock"]
          }
        >
          {t("federation.market.review")}
        </Button>
        <Button type="button" variant="ghost" disabled={disabled} onClick={onCancel}>
          {t("federation.cancel")}
        </Button>
      </div>
    </form>
  );
}

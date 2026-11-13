import {
  type FederationAgreementApproval,
  FederationAgreementApprovalSchema,
  type FederationDelegation,
  FederationDelegationSchema,
  type FederationMode,
} from "@kuintessence/shared/federation";
import { FederationMaterialOptionSchema } from "@kuintessence/shared/federation/outbound-views";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function FederationTaskCreate({
  scope,
  localSiteId,
  supportedModes,
  disabled,
  onReview,
  onCancel,
}: {
  scope: ApiOrganizationScope;
  localSiteId: string;
  supportedModes: readonly FederationMode[];
  disabled: boolean;
  onReview: (request: FederationDelegation) => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [agreementPage, setAgreementPage] = useState(0);
  const [materialPage, setMaterialPage] = useState(0);
  const [selected, setSelected] = useState<FederationAgreementApproval | null>(null);
  const [template, setTemplate] = useState(0);
  const [inputs, setInputs] = useState("");
  const [environment, setEnvironment] = useState("");
  const [resources, setResources] = useState({ cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 60 });
  const [amount, setAmount] = useState("0");
  const [error, setError] = useState(false);
  const key = ["federation", "task-options", scope.organizationId, scope.authRevision];
  const agreements = useQuery({
    queryKey: [...key, "agreements", agreementPage],
    queryFn: async () => {
      const rows = z
        .array(FederationAgreementApprovalSchema)
        .parse(
          (
            await api.get<{ data: unknown }>(
              `/federation/agreements?limit=20&offset=${agreementPage * 20}`,
              scope,
            )
          ).data,
        );
      if (
        rows.some(
          (row) => row.localOrgId !== scope.organizationId || row.localSiteId !== localSiteId,
        )
      )
        throw new Error("Agreement scope mismatch");
      return rows;
    },
  });
  const materials = useQuery({
    queryKey: [...key, "materials", materialPage],
    queryFn: async () => {
      const value = z
        .object({ data: z.array(FederationMaterialOptionSchema), hasMore: z.boolean() })
        .parse(
          (
            await api.get<{ data: unknown }>(
              `/federation/assets/materials?limit=20&offset=${materialPage * 20}`,
              scope,
            )
          ).data,
        );
      if (value.data.some((row) => row.localOrgId !== scope.organizationId))
        throw new Error("Material scope mismatch");
      return value;
    },
  });
  const available =
    agreements.data?.filter(
      (row) =>
        supportedModes.includes(row.terms.mode) &&
        row.state === "active" &&
        row.counterpartyApprovalJws &&
        row.terms.sourceSiteId === localSiteId &&
        Date.parse(row.terms.validFrom) <= Date.now() &&
        Date.parse(row.terms.validUntil) > Date.now(),
    ) ?? [];
  const options = materials.data?.data.filter((row) => row.originSiteId === localSiteId) ?? [];
  const terms = selected?.terms;
  const busy = disabled || agreements.isFetching || materials.isFetching;
  const selectClass =
    "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm";
  return (
    <form
      className="max-w-3xl space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        setError(false);
        if (busy || agreements.isError || materials.isError || !terms) return;
        const now = Date.now();
        const request = FederationDelegationSchema.safeParse({
          protocolVersion: 1,
          kind: "delegation",
          operationId: crypto.randomUUID(),
          taskId: crypto.randomUUID(),
          attempt: 1,
          senderSiteId: localSiteId,
          recipientSiteId: terms.targetSiteId,
          agreementRevisionId: terms.agreementRevisionId,
          mode: terms.mode,
          budgetDomainId: terms.budgetDomainId,
          epoch: terms.epoch,
          issuedAt: new Date(now).toISOString(),
          expiresAt: new Date(Math.min(now + 900000, Date.parse(terms.validUntil))).toISOString(),
          executionExpiresAt: new Date(
            Math.min(now + (resources.wallTimeSec + 3600) * 1000, Date.parse(terms.validUntil)),
          ).toISOString(),
          template: terms.templates[template],
          inputManifestDigest: inputs,
          environmentLockDigest: environment,
          resources,
          maxAmount: amount,
          unit: terms.unit,
        });
        if (
          !request.success ||
          BigInt(request.data.maxAmount) > BigInt(terms.maxTaskAmount) ||
          Object.entries(resources).some(
            ([field, value]) => value > terms.resourceLimit[field as keyof typeof resources],
          )
        ) {
          setError(true);
          return;
        }
        onReview(request.data);
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">{t("federation.tasks.new")}</h3>
        <Button type="button" variant="ghost" disabled={disabled} onClick={onCancel}>
          {t("federation.cancel")}
        </Button>
      </div>
      {agreements.isError || materials.isError ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>{t("federation.tasks.optionsFailed")}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void agreements.refetch();
              void materials.refetch();
            }}
          >
            {t("federation.refresh")}
          </Button>
        </div>
      ) : null}
      <fieldset disabled={busy} className="space-y-5">
        <label className="block space-y-1 text-sm" htmlFor={`${id}-agreement`}>
          <span>{t("federation.tasks.agreement")}</span>
          <select
            id={`${id}-agreement`}
            className={selectClass}
            required
            value={selected?.revisionId ?? ""}
            onChange={(event) => {
              const row = available.find((value) => value.revisionId === event.target.value);
              if (!row) return;
              setSelected(row);
              setTemplate(0);
              setAmount("0");
              setResources({
                cpus: 1,
                memoryMb: Math.min(128, row.terms.resourceLimit.memoryMb),
                gpus: 0,
                wallTimeSec: Math.min(60, row.terms.resourceLimit.wallTimeSec),
              });
            }}
          >
            <option value="" disabled>
              {t("federation.tasks.chooseAgreement")}
            </option>
            {selected && !available.some((row) => row.revisionId === selected.revisionId) ? (
              <option value={selected.revisionId}>
                {selected.terms.sourceSiteId.slice(0, 8)} →{" "}
                {selected.terms.targetSiteId.slice(0, 8)}
              </option>
            ) : null}
            {available.map((row) => (
              <option key={row.revisionId} value={row.revisionId}>
                {row.terms.sourceSiteId.slice(0, 8)} → {row.terms.targetSiteId.slice(0, 8)} ·{" "}
                {row.revisionId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {agreementPage > 0 || agreements.data?.length === 20 ? (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={agreementPage === 0 || busy}
              onClick={() => setAgreementPage((v) => v - 1)}
            >
              {t("federation.previous")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy || agreements.isError || agreements.data?.length !== 20}
              onClick={() => setAgreementPage((v) => v + 1)}
            >
              {t("federation.next")}
            </Button>
          </div>
        ) : null}
        {terms ? (
          <>
            <label className="block space-y-1 text-sm" htmlFor={`${id}-template`}>
              <span>{t("federation.tasks.template")}</span>
              <select
                id={`${id}-template`}
                className={selectClass}
                value={template}
                onChange={(event) => setTemplate(Number(event.target.value))}
              >
                {terms.templates.map((ref, index) => (
                  <option key={`${ref.kind}:${ref.id}:${ref.revision}`} value={index}>
                    {t(`federation.tasks.kinds.${ref.kind}`)} · {ref.id} · {ref.revision}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              {(["inputs", "environment-lock"] as const).map((kind) => {
                const value = kind === "inputs" ? inputs : environment;
                const list = options.filter((row) => row.kind === kind);
                return (
                  <label
                    key={kind}
                    className="block min-w-0 space-y-1 text-sm"
                    htmlFor={`${id}-${kind}`}
                  >
                    <span>
                      {t(
                        kind === "inputs"
                          ? "federation.tasks.inputs"
                          : "federation.tasks.environment",
                      )}
                    </span>
                    <select
                      id={`${id}-${kind}`}
                      className={selectClass}
                      value={value}
                      required
                      onChange={(event) =>
                        (kind === "inputs" ? setInputs : setEnvironment)(event.target.value)
                      }
                    >
                      <option value="" disabled>
                        {t("federation.tasks.chooseSnapshot")}
                      </option>
                      {value && !list.some((row) => row.digest === value) ? (
                        <option value={value}>{value.slice(7, 19)}</option>
                      ) : null}
                      {list.map((row) => (
                        <option key={row.digest} value={row.digest}>
                          {new Date(row.createdAt).toLocaleString(i18n.language)} ·{" "}
                          {row.digest.slice(7, 19)}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
            {materialPage > 0 || materials.data?.hasMore ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={materialPage === 0 || busy}
                  onClick={() => setMaterialPage((v) => v - 1)}
                >
                  {t("federation.previous")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || materials.isError || !materials.data?.hasMore}
                  onClick={() => setMaterialPage((v) => v + 1)}
                >
                  {t("federation.next")}
                </Button>
              </div>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              {(["cpus", "memoryMb", "gpus", "wallTimeSec"] as const).map((field) => (
                <label key={field} className="block space-y-1 text-sm" htmlFor={`${id}-${field}`}>
                  <span>{t(`federation.tasks.${field}`)}</span>
                  <Input
                    id={`${id}-${field}`}
                    type="number"
                    min={field === "gpus" ? 0 : 1}
                    max={terms.resourceLimit[field]}
                    step={1}
                    required
                    value={Number.isFinite(resources[field]) ? resources[field] : ""}
                    onChange={(event) =>
                      setResources((value) => ({ ...value, [field]: event.target.valueAsNumber }))
                    }
                  />
                </label>
              ))}
            </div>
            <label className="block space-y-1 text-sm" htmlFor={`${id}-amount`}>
              <span>
                {t("federation.tasks.maxAmount")} · {terms.unit}
              </span>
              <Input
                id={`${id}-amount`}
                inputMode="numeric"
                pattern="(0|[1-9][0-9]{0,37})"
                required
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-status-failed">
            {t("federation.tasks.invalid")}
          </p>
        ) : null}
        <Button
          disabled={
            busy || agreements.isError || materials.isError || !selected || !inputs || !environment
          }
        >
          {t("federation.tasks.review")}
        </Button>
      </fieldset>
    </form>
  );
}

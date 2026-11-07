import {
  type FederationAgreementApproval,
  FederationAgreementApprovalSchema,
} from "@kuintessence/shared/federation";
import {
  type CommercialAgreement,
  CommercialAgreementSchema,
} from "@kuintessence/shared/federation/commercial";
import { useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";

export function CommercialEditor({
  scope,
  localSiteId,
  disabled,
  onReview,
  onCancel,
}: {
  scope: ApiOrganizationScope;
  localSiteId: string;
  disabled: boolean;
  onReview: (terms: CommercialAgreement) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const fileSequence = useRef(0);
  const [source, setSource] = useState<"existing" | "import">("existing");
  const [page, setPage] = useState(0);
  const [json, setJson] = useState("");
  const [priceIds, setPriceIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<CommercialAgreement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agreements = useQuery({
    queryKey: [
      "federation",
      "commercial-base-agreements",
      scope.organizationId,
      scope.authRevision,
      page,
    ],
    enabled: source === "existing" && !draft,
    queryFn: async () =>
      z
        .array(FederationAgreementApprovalSchema)
        .parse(
          (
            await api.get<{ data: unknown }>(
              `/federation/agreements?limit=20&offset=${page * 20}`,
              scope,
            )
          ).data,
        )
        .filter(
          (row) => row.localOrgId === scope.organizationId && row.localSiteId === localSiteId,
        ),
  });
  const choose = (approval: FederationAgreementApproval) => {
    setError(null);
    setPriceIds([crypto.randomUUID()]);
    setDraft({
      protocolVersion: 1,
      kind: "commercial-agreement",
      domainId: "",
      salt: Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
      createdAt: new Date().toISOString(),
      agreement: approval.terms,
      consideration: "charity",
      priceVersionId: crypto.randomUUID(),
      prices: [{ metric: "cpu", quantityUnit: "core-second", perQuantity: "3600", amount: "0" }],
      termsText: "",
    });
  };
  const validate = (value: unknown) => {
    const parsed = CommercialAgreementSchema.safeParse(value);
    if (!parsed.success) {
      setError(
        t("federation.agreements.invalidTerms", {
          fields: parsed.error.issues
            .slice(0, 3)
            .map((issue) => issue.path.join(".") || issue.message)
            .join(", "),
        }),
      );
      return null;
    }
    if (
      ![parsed.data.agreement.sourceSiteId, parsed.data.agreement.targetSiteId].includes(
        localSiteId,
      )
    ) {
      setError(t("federation.agreements.wrongSite"));
      return null;
    }
    if (Date.parse(parsed.data.agreement.validUntil) <= Date.now()) {
      setError(t("federation.agreements.expired"));
      return null;
    }
    if (Date.parse(parsed.data.createdAt) > Date.now() + 60000) {
      setError(t("federation.commercial.futureDate"));
      return null;
    }
    setError(null);
    return parsed.data;
  };
  const importTerms = () => {
    try {
      if (new TextEncoder().encode(json).length > 550000) {
        setError(t("federation.agreements.tooLarge"));
        return;
      }
      const value = validate(JSON.parse(json));
      if (value) {
        setPriceIds(value.prices.map(() => crypto.randomUUID()));
        setDraft(value);
      }
    } catch {
      setError(t("federation.agreements.invalidJson"));
    }
  };
  const changePrice = (
    index: number,
    field: keyof CommercialAgreement["prices"][number],
    value: string,
  ) => {
    if (draft)
      setDraft({
        ...draft,
        prices: draft.prices.map((price, item) =>
          item === index ? { ...price, [field]: value } : price,
        ),
      });
  };
  return (
    <section className="space-y-5">
      <h2 className="text-lg font-semibold">{t("federation.commercial.newContract")}</h2>
      {!draft ? (
        <>
          <fieldset disabled={disabled} className="flex flex-wrap gap-5 text-sm">
            <legend className="sr-only">{t("federation.commercial.source")}</legend>
            {(["existing", "import"] as const).map((value) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-source`}
                  checked={source === value}
                  onChange={() => {
                    fileSequence.current++;
                    setSource(value);
                    setError(null);
                  }}
                />
                {t(`federation.commercial.sources.${value}`)}
              </label>
            ))}
          </fieldset>
          {source === "existing" ? (
            <>
              {agreements.isError ? (
                <p role="alert">{t("federation.loadFailed")}</p>
              ) : agreements.isPending ? (
                <p role="status">{t("federation.loading")}</p>
              ) : agreements.data.length ? (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {agreements.data.map((row) => (
                    <li key={row.revisionId}>
                      <button
                        type="button"
                        disabled={
                          disabled ||
                          row.state !== "active" ||
                          Date.parse(row.terms.validUntil) <= Date.now()
                        }
                        className="w-full space-y-1 p-4 text-left text-sm hover:bg-muted/50 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => choose(row)}
                      >
                        <span className="block break-all">
                          {row.terms.sourceSiteId} → {row.terms.targetSiteId}
                        </span>
                        <span className="block break-all text-xs text-muted-foreground">
                          {row.revisionId} · {t(`federation.agreements.localStates.${row.state}`)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-sm text-muted-foreground">
                  {t("federation.commercial.noBaseAgreement")}
                </p>
              )}
              {page > 0 || agreements.data?.length === 20 ? (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={disabled || page === 0 || agreements.isFetching}
                    onClick={() => setPage(page - 1)}
                  >
                    {t("federation.previous")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={disabled || agreements.data?.length !== 20 || agreements.isFetching}
                    onClick={() => setPage(page + 1)}
                  >
                    {t("federation.next")}
                  </Button>
                </div>
              ) : null}
              {agreements.isError ? (
                <Button
                  variant="outline"
                  disabled={disabled || agreements.isFetching}
                  onClick={() => void agreements.refetch()}
                >
                  {t("federation.refresh")}
                </Button>
              ) : null}
            </>
          ) : (
            <div className="space-y-3">
              <label className="block text-sm" htmlFor={`${id}-file`}>
                {t("federation.agreements.termsFile")}
              </label>
              <Input
                type="file"
                id={`${id}-file`}
                accept=".json,application/json"
                disabled={disabled}
                onChange={async (event) => {
                  const sequence = ++fileSequence.current;
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > 550000) {
                    setError(t("federation.agreements.tooLarge"));
                    return;
                  }
                  try {
                    const value = await file.text();
                    if (sequence === fileSequence.current) {
                      setJson(value);
                      setError(null);
                    }
                  } catch {
                    if (sequence === fileSequence.current)
                      setError(t("federation.agreements.readFailed"));
                  }
                }}
              />
              <label className="block text-sm" htmlFor={`${id}-json`}>
                {t("federation.agreements.termsJson")}
              </label>
              <Textarea
                id={`${id}-json`}
                rows={10}
                className="font-mono text-xs"
                value={json}
                maxLength={550000}
                disabled={disabled}
                onChange={(event) => {
                  fileSequence.current++;
                  setJson(event.target.value);
                }}
              />
              <Button disabled={disabled || !json.trim()} onClick={importTerms}>
                {t("federation.commercial.loadTerms")}
              </Button>
            </div>
          )}
          <Button variant="outline" disabled={disabled} onClick={onCancel}>
            {t("federation.cancel")}
          </Button>
        </>
      ) : (
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = validate(draft);
            if (!disabled && parsed) onReview(parsed);
          }}
        >
          <p className="break-all text-sm text-muted-foreground">
            {draft.agreement.sourceSiteId} → {draft.agreement.targetSiteId}
          </p>
          <fieldset disabled={disabled} className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span className="block">{t("federation.commercial.consideration")}</span>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={draft.consideration}
                  onChange={(event) => {
                    const consideration = CommercialAgreementSchema.shape.consideration.parse(
                      event.target.value,
                    );
                    setDraft({
                      ...draft,
                      consideration,
                      prices: draft.prices.map((price) =>
                        consideration === "charity" ? { ...price, amount: "0" } : price,
                      ),
                    });
                  }}
                >
                  {(["charity", "exchange", "paid"] as const).map((value) => (
                    <option key={value} value={value}>
                      {t(`federation.commercial.considerations.${value}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor={`${id}-domain`} className="space-y-2 text-sm">
                <span className="block">{t("federation.commercial.domain")}</span>
                <Input
                  required
                  id={`${id}-domain`}
                  value={draft.domainId}
                  onChange={(event) => setDraft({ ...draft, domainId: event.target.value })}
                />
              </label>
            </div>
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">
                {t("federation.commercial.prices")} · {draft.agreement.unit}
              </h3>
              {draft.prices.map((price, index) => (
                <fieldset
                  key={priceIds[index]}
                  className="grid items-end gap-3 border-b border-border pb-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]"
                >
                  <legend className="sr-only">
                    {t("federation.commercial.priceRow", { number: index + 1 })}
                  </legend>
                  {(["metric", "quantityUnit", "perQuantity", "amount"] as const).map((field) => (
                    <label
                      key={field}
                      htmlFor={`${id}-${priceIds[index]}-${field}`}
                      className="min-w-0 space-y-2 text-sm"
                    >
                      <span className="block">{t(`federation.commercial.${field}`)}</span>
                      <Input
                        required
                        id={`${id}-${priceIds[index]}-${field}`}
                        type="text"
                        inputMode={
                          field === "perQuantity" || field === "amount" ? "numeric" : "text"
                        }
                        value={price[field]}
                        readOnly={field === "amount" && draft.consideration === "charity"}
                        maxLength={field === "perQuantity" || field === "amount" ? 38 : 64}
                        onChange={(event) => changePrice(index, field, event.target.value)}
                      />
                    </label>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={draft.prices.length === 1}
                    onClick={() => {
                      setPriceIds(priceIds.filter((_, item) => item !== index));
                      setDraft({
                        ...draft,
                        prices: draft.prices.filter((_, item) => item !== index),
                      });
                    }}
                  >
                    {t("federation.commercial.removePrice")}
                  </Button>
                </fieldset>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={draft.prices.length >= 64}
                onClick={() =>
                  setDraft({
                    ...draft,
                    prices: [
                      ...draft.prices,
                      { metric: "", quantityUnit: "", perQuantity: "1", amount: "0" },
                    ],
                  })
                }
              >
                {t("federation.commercial.addPrice")}
              </Button>
            </section>
            <label htmlFor={`${id}-text`} className="block space-y-2 text-sm">
              <span className="block">{t("federation.commercial.terms")}</span>
              <Textarea
                required
                rows={7}
                id={`${id}-text`}
                value={draft.termsText}
                maxLength={65536}
                onChange={(event) => setDraft({ ...draft, termsText: event.target.value })}
              />
            </label>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={disabled}>
              {t("federation.agreements.review")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              {t("federation.agreements.replaceTerms")}
            </Button>
            <Button type="button" variant="ghost" disabled={disabled} onClick={onCancel}>
              {t("federation.cancel")}
            </Button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      ) : null}
    </section>
  );
}

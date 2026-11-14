import {
  type FederationAgreement,
  FederationAgreementSchema,
  FederationExecutionAccountsSchema,
} from "@kuintessence/shared/federation";
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { AgreementTerms } from "./AgreementTerms";

export function AgreementImport({
  scope,
  localSiteId,
  supportedModes,
  disabled,
  onReview,
  onCancel,
}: {
  scope: ApiOrganizationScope;
  localSiteId: string;
  supportedModes: readonly string[];
  disabled: boolean;
  onReview: (terms: FederationAgreement, executionUserId?: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const fileSequence = useRef(0);
  const [json, setJson] = useState("");
  const [terms, setTerms] = useState<FederationAgreement | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [executionUserId, setExecutionUserId] = useState("");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(0);
  const recipient = terms?.targetSiteId === localSiteId;
  const accounts = useQuery({
    queryKey: [
      "federation",
      "execution-accounts",
      scope.organizationId,
      scope.authRevision,
      deferredSearch,
      page,
    ],
    enabled: recipient && !disabled,
    queryFn: async () =>
      FederationExecutionAccountsSchema.parse(
        await api.get<unknown>(
          `/federation/agreements/execution-accounts?${new URLSearchParams({ search: deferredSearch, limit: "20", offset: String(page * 20) })}`,
          scope,
        ),
      ),
  });
  const validate = () => {
    try {
      if (new TextEncoder().encode(json).length > 550000) {
        setInvalid(t("federation.agreements.tooLarge"));
        return;
      }
      const parsed = FederationAgreementSchema.safeParse(JSON.parse(json));
      if (!parsed.success) {
        setInvalid(
          t("federation.agreements.invalidTerms", {
            fields: parsed.error.issues
              .slice(0, 3)
              .map((issue) => issue.path.join(".") || issue.message)
              .join(", "),
          }),
        );
        return;
      }
      if (parsed.data.sourceSiteId !== localSiteId && parsed.data.targetSiteId !== localSiteId) {
        setInvalid(t("federation.agreements.wrongSite"));
        return;
      }
      setTerms(parsed.data);
      setInvalid(null);
      setExecutionUserId("");
    } catch {
      setInvalid(t("federation.agreements.invalidJson"));
    }
  };
  const supported = terms && supportedModes.includes(terms.mode);
  const expired = terms && Date.parse(terms.validUntil) <= Date.now();
  return (
    <section className="space-y-5">
      <h3 className="text-base font-semibold">{t("federation.agreements.importTerms")}</h3>
      {!terms ? (
        <div className="space-y-4">
          <label htmlFor={`${fieldId}-file`} className="block text-sm">
            {t("federation.agreements.termsFile")}
          </label>
          <Input
            id={`${fieldId}-file`}
            type="file"
            accept="application/json,.json"
            disabled={disabled}
            onChange={async (event) => {
              const sequence = ++fileSequence.current;
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > 550000) {
                setInvalid(t("federation.agreements.tooLarge"));
                return;
              }
              try {
                const value = await file.text();
                if (sequence === fileSequence.current) {
                  setJson(value);
                  setInvalid(null);
                }
              } catch {
                if (sequence === fileSequence.current)
                  setInvalid(t("federation.agreements.readFailed"));
              }
            }}
          />
          <label htmlFor={`${fieldId}-json`} className="block text-sm">
            {t("federation.agreements.termsJson")}
          </label>
          <Textarea
            id={`${fieldId}-json`}
            value={json}
            maxLength={550000}
            rows={12}
            disabled={disabled}
            className="font-mono text-xs"
            onChange={(event) => {
              fileSequence.current++;
              setJson(event.target.value);
            }}
          />
          {invalid ? (
            <p role="alert" className="text-sm text-status-failed">
              {invalid}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={disabled || !json.trim()} onClick={validate}>
              {t("federation.agreements.review")}
            </Button>
            <Button variant="outline" onClick={onCancel} disabled={disabled}>
              {t("federation.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <AgreementTerms terms={terms} />
          {!supported ? (
            <p role="alert" className="text-sm text-status-failed">
              {t("federation.agreements.unsupportedMode")}
            </p>
          ) : null}
          {expired ? (
            <p role="alert" className="text-sm text-status-failed">
              {t("federation.agreements.expired")}
            </p>
          ) : null}
          {recipient ? (
            <section className="space-y-3 border-t border-border pt-4">
              <h4 className="text-sm font-semibold">
                {t("federation.agreements.executionAccount")}
              </h4>
              <Input
                aria-label={t("federation.agreements.accountSearch")}
                placeholder={t("federation.agreements.accountSearch")}
                disabled={disabled}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                  setExecutionUserId("");
                }}
              />
              {accounts.isError ? (
                <p role="alert" className="text-sm text-status-failed">
                  {t("federation.loadFailed")}
                </p>
              ) : accounts.isPending ? (
                <p role="status">{t("federation.loading")}</p>
              ) : accounts.data.data.length ? (
                <fieldset disabled={disabled || accounts.isFetching} className="space-y-2">
                  {accounts.data.data.map((account) => (
                    <label
                      key={account.userId}
                      className="flex items-start gap-2 break-all text-sm"
                    >
                      <input
                        type="radio"
                        name={`${fieldId}-account`}
                        value={account.userId}
                        checked={executionUserId === account.userId}
                        onChange={() => setExecutionUserId(account.userId)}
                      />
                      {account.displayName || account.email}
                      {account.displayName ? ` (${account.email})` : ""}
                    </label>
                  ))}
                </fieldset>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("federation.agreements.noAccounts")}
                </p>
              )}
              {accounts.data && (page > 0 || accounts.data.hasMore) ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || page === 0 || accounts.isFetching}
                    onClick={() => {
                      setPage(page - 1);
                      setExecutionUserId("");
                    }}
                  >
                    {t("federation.previous")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || !accounts.data.hasMore || accounts.isFetching}
                    onClick={() => {
                      setPage(page + 1);
                      setExecutionUserId("");
                    }}
                  >
                    {t("federation.next")}
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                disabled ||
                !supported ||
                !!expired ||
                (recipient &&
                  (!executionUserId ||
                    !accounts.data?.data.some((account) => account.userId === executionUserId) ||
                    accounts.isError ||
                    accounts.isFetching))
              }
              onClick={() => onReview(terms, recipient ? executionUserId : undefined)}
            >
              {t("federation.agreements.sign")}
            </Button>
            <Button variant="outline" disabled={disabled} onClick={() => setTerms(null)}>
              {t("federation.agreements.replaceTerms")}
            </Button>
            <Button variant="ghost" disabled={disabled} onClick={onCancel}>
              {t("federation.cancel")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

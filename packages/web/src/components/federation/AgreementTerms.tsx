import type { FederationAgreement } from "@kuintessence/shared/federation";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function AgreementFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all">{children}</dd>
    </div>
  );
}

export function AgreementTerms({
  terms,
  showModeEffect = true,
}: {
  terms: FederationAgreement;
  showModeEffect?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const date = (value: string) => new Date(value).toLocaleString(i18n.language);
  return (
    <section className="space-y-5">
      <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
        <AgreementFact label={t("federation.agreements.mode")}>
          {t(`federation.agreements.modes.${terms.mode}`)}
        </AgreementFact>
        <AgreementFact label={t("federation.agreements.revision")}>
          {terms.agreementRevisionId}
        </AgreementFact>
        <AgreementFact label={t("federation.agreements.source")}>
          {terms.sourceSiteId}
        </AgreementFact>
        <AgreementFact label={t("federation.agreements.target")}>
          {terms.targetSiteId}
        </AgreementFact>
        <AgreementFact label={t("federation.validFrom")}>{date(terms.validFrom)}</AgreementFact>
        <AgreementFact label={t("federation.validUntil")}>{date(terms.validUntil)}</AgreementFact>
        <AgreementFact label={t("federation.agreements.budget")}>
          {BigInt(terms.budgetLimit).toLocaleString(i18n.language)} {terms.unit}
        </AgreementFact>
        <AgreementFact label={t("federation.agreements.taskBudget")}>
          {BigInt(terms.maxTaskAmount).toLocaleString(i18n.language)} {terms.unit}
        </AgreementFact>
        <AgreementFact label={t("federation.agreements.reservations")}>
          {terms.maxReservations.toLocaleString(i18n.language)}
        </AgreementFact>
        {terms.mode === "bilateral_attested" ? (
          terms.attestationLimits ? (
            <>
              <AgreementFact label={t("federation.agreements.backlog.taskLimit")}>
                {terms.attestationLimits.maxOutstandingTasks.toLocaleString(i18n.language)}
              </AgreementFact>
              <AgreementFact label={t("federation.agreements.backlog.amountLimit")}>
                {BigInt(terms.attestationLimits.maxOutstandingAmount).toLocaleString(i18n.language)}{" "}
                {terms.unit}
              </AgreementFact>
              <AgreementFact label={t("federation.agreements.backlog.ageLimit")}>
                {t("federation.agreements.backlog.seconds", {
                  value: terms.attestationLimits.maxOutstandingAgeSec.toLocaleString(i18n.language),
                })}
              </AgreementFact>
            </>
          ) : (
            <AgreementFact label={t("federation.agreements.backlog.limits")}>
              {t("federation.agreements.backlog.unconfigured")}
            </AgreementFact>
          )
        ) : null}
        <AgreementFact label={t("federation.agreements.resourceLimit")}>
          {t("federation.agreements.resourceValues", terms.resourceLimit)}
        </AgreementFact>
        <AgreementFact label={t("federation.agreements.inputPolicy")}>
          {terms.inputPolicy
            ? t("federation.agreements.fileLimit", terms.inputPolicy)
            : t("federation.agreements.noFileAuthorization")}
        </AgreementFact>
        <AgreementFact label={t("federation.agreements.resultPolicy")}>
          {terms.resultPolicy ? (
            <>
              {t("federation.agreements.fileLimit", terms.resultPolicy)}
              <br />
              {t("federation.agreements.until", { value: date(terms.resultPolicy.availableUntil) })}
            </>
          ) : (
            t("federation.agreements.noFileAuthorization")
          )}
        </AgreementFact>
      </dl>
      {showModeEffect ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          {t(`federation.agreements.modeEffects.${terms.mode}`)}
        </p>
      ) : null}
      <section className="space-y-3 border-t border-border pt-4">
        <h4 className="text-sm font-semibold">{t("federation.agreements.templates")}</h4>
        <ul className="divide-y divide-border">
          {Array.from(new Map(terms.templates.map((ref) => [JSON.stringify(ref), ref]))).map(
            ([key, ref]) => (
              <li key={key} className="space-y-1 py-3 text-sm">
                <p className="break-all">
                  {ref.kind} · {ref.id} · {ref.revision}
                </p>
                <p className="break-all text-xs text-muted-foreground">{ref.originSiteId}</p>
                <code className="block break-all text-xs">{ref.digest}</code>
              </li>
            ),
          )}
        </ul>
      </section>
      <section className="space-y-3 border-t border-border pt-4">
        <h4 className="text-sm font-semibold">{t("federation.agreements.targets")}</h4>
        {terms.executionTargets?.length ? (
          <ul className="space-y-4">
            {terms.executionTargets.map((target) => (
              <li key={target.queueId}>
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  {(["providerOrgId", "clusterId", "agentId", "queueId"] as const).map((field) => (
                    <AgreementFact key={field} label={t(`federation.agreements.${field}`)}>
                      {target[field] ?? t("federation.agreements.notSpecified")}
                    </AgreementFact>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("federation.agreements.noTargets")}</p>
        )}
      </section>
      <details className="text-sm">
        <summary className="cursor-pointer">{t("federation.agreements.completeTerms")}</summary>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <AgreementFact label={t("federation.agreements.domain")}>
            {terms.budgetDomainId}
          </AgreementFact>
          <AgreementFact label={t("federation.agreements.epoch")}>{terms.epoch}</AgreementFact>
          <AgreementFact label={t("federation.agreements.contractDigest")}>
            {terms.termsDigest}
          </AgreementFact>
        </dl>
        <pre className="mt-4 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(terms, null, 2)}
        </pre>
      </details>
    </section>
  );
}

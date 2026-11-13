import type { CommercialAgreement } from "@kuintessence/shared/federation/commercial";
import { useTranslation } from "react-i18next";
import { AgreementFact, AgreementTerms } from "./AgreementTerms";
import { commercialMetric, commercialUnit } from "./commercial-format";

export function exportCommercialTerms(terms: CommercialAgreement) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(terms, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `contract-${terms.agreement.agreementRevisionId}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CommercialTerms({ terms }: { terms: CommercialAgreement }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="space-y-6">
      <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
        <AgreementFact label={t("federation.agreements.source")}>
          {terms.agreement.sourceSiteId}
        </AgreementFact>
        <AgreementFact label={t("federation.agreements.target")}>
          {terms.agreement.targetSiteId}
        </AgreementFact>
        <AgreementFact label={t("federation.commercial.consideration")}>
          {t(`federation.commercial.considerations.${terms.consideration}`)}
        </AgreementFact>
        <AgreementFact label={t("federation.agreements.mode")}>
          {t(`federation.agreements.modes.${terms.agreement.mode}`)}
        </AgreementFact>
        <AgreementFact label={t("federation.validFrom")}>
          {new Date(terms.agreement.validFrom).toLocaleString(i18n.language)}
        </AgreementFact>
        <AgreementFact label={t("federation.validUntil")}>
          {new Date(terms.agreement.validUntil).toLocaleString(i18n.language)}
        </AgreementFact>
      </dl>
      <div className="max-w-full overflow-x-auto">
        <table className="w-full min-w-96 text-left text-sm tabular-nums">
          <caption className="mb-3 text-left font-semibold">
            {t("federation.commercial.prices")}
          </caption>
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th className="py-2 pr-4 font-medium">{t("federation.commercial.metric")}</th>
              <th className="py-2 pr-4 font-medium">{t("federation.commercial.perQuantity")}</th>
              <th className="py-2 text-right font-medium">
                {t("federation.commercial.amount")} ({terms.agreement.unit})
              </th>
            </tr>
          </thead>
          <tbody>
            {terms.prices.map((price) => (
              <tr key={price.metric} className="border-b border-border">
                <td className="break-all py-3 pr-4">
                  {commercialMetric(t, price.metric, price.quantityUnit)}
                </td>
                <td className="py-3 pr-4">
                  {BigInt(price.perQuantity).toLocaleString(i18n.language)}{" "}
                  {commercialUnit(t, price.metric, price.quantityUnit)}
                </td>
                <td className="py-3 text-right">
                  {BigInt(price.amount).toLocaleString(i18n.language)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t("federation.commercial.terms")}</h3>
        <p className="max-w-prose whitespace-pre-wrap break-words text-sm">{terms.termsText}</p>
      </section>
      <details className="border-t border-border pt-4 text-sm">
        <summary className="cursor-pointer font-medium">
          {t("federation.commercial.executionScope")}
        </summary>
        <div className="mt-4">
          <AgreementTerms terms={terms.agreement} showModeEffect={false} />
        </div>
      </details>
      <details className="text-sm">
        <summary className="cursor-pointer">{t("federation.commercial.identifiers")}</summary>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <AgreementFact label={t("federation.agreements.revision")}>
            {terms.agreement.agreementRevisionId}
          </AgreementFact>
          <AgreementFact label={t("federation.commercial.domain")}>{terms.domainId}</AgreementFact>
          <AgreementFact label={t("federation.commercial.priceVersion")}>
            {terms.priceVersionId}
          </AgreementFact>
        </dl>
      </details>
    </div>
  );
}

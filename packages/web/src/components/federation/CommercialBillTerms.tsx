import type { CommercialBill } from "@kuintessence/shared/federation/commercial";
import { useTranslation } from "react-i18next";
import { AgreementFact } from "./AgreementTerms";
import { commercialMetric, commercialUnit } from "./commercial-format";

export function CommercialBillTerms({ bill }: { bill: CommercialBill }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="space-y-5">
      <dl className="grid gap-4 sm:grid-cols-2">
        <AgreementFact label={t("federation.billing.billId")}>{bill.billId}</AgreementFact>
        <AgreementFact label={t("federation.billing.reportId")}>{bill.reportId}</AgreementFact>
        <AgreementFact label={t("federation.billing.taskId")}>{bill.request.taskId}</AgreementFact>
        <AgreementFact label={t("federation.billing.issuedAt")}>
          {new Date(bill.issuedAt).toLocaleString(i18n.language)}
        </AgreementFact>
      </dl>
      <div className="max-w-full overflow-x-auto">
        <table className="w-full min-w-96 whitespace-nowrap text-left text-sm tabular-nums">
          <caption className="pb-2 text-left text-muted-foreground">
            {t("federation.billing.rounding", { unit: bill.request.unit })}
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th className="py-2 pr-4 font-medium">{t("federation.commercial.metric")}</th>
              <th className="px-2 py-2 text-right font-medium">{t("federation.usage.quantity")}</th>
              <th className="px-2 py-2 text-right font-medium">{t("federation.billing.rate")}</th>
              <th className="py-2 pl-4 text-right font-medium">{t("federation.billing.amount")}</th>
            </tr>
          </thead>
          <tbody>
            {bill.calculation.lines.map((line) => (
              <tr key={line.metric} className="border-b border-border">
                <td className="py-3 pr-4">{commercialMetric(t, line.metric, line.quantityUnit)}</td>
                <td className="px-2 py-3 text-right">
                  {line.quantity} {commercialUnit(t, line.metric, line.quantityUnit)}
                </td>
                <td className="px-2 py-3 text-right">
                  {line.rateAmount} / {line.perQuantity}
                </td>
                <td className="py-3 pl-4 text-right">{line.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="ml-auto grid max-w-sm grid-cols-2 gap-x-6 gap-y-2 text-sm tabular-nums">
        {(["grossAmount", "capReduction", "discountAmount", "dueAmount"] as const).map((key) => (
          <div key={key} className="contents">
            <dt className={key === "dueAmount" ? "border-t border-border pt-3 font-semibold" : ""}>
              {t(`federation.billing.${key}`)}
            </dt>
            <dd
              className={
                key === "dueAmount"
                  ? "break-all border-t border-border pt-3 text-right font-semibold"
                  : "break-all text-right"
              }
            >
              {bill.calculation[key]}
            </dd>
          </div>
        ))}
      </dl>
      <details className="text-sm">
        <summary className="cursor-pointer">{t("federation.billing.references")}</summary>
        <dl className="mt-3 grid gap-4 sm:grid-cols-2">
          <AgreementFact label={t("federation.commercial.priceVersion")}>
            {bill.priceVersionId}
          </AgreementFact>
          <AgreementFact label={t("federation.billing.reportDigest")}>
            {bill.reportDigest}
          </AgreementFact>
          <AgreementFact label={t("federation.billing.discountId")}>
            {bill.discount?.discountId ?? "—"}
          </AgreementFact>
          <AgreementFact label={t("federation.billing.reservationId")}>
            {bill.reservationId ?? "—"}
          </AgreementFact>
        </dl>
      </details>
    </div>
  );
}

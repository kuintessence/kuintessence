import type { CommercialPayment } from "@kuintessence/shared/federation/commercial";
import { useTranslation } from "react-i18next";
import { AgreementFact } from "./AgreementTerms";

export function CommercialPaymentTerms({ payment }: { payment: CommercialPayment }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="space-y-5">
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <AgreementFact label={t("federation.payment.amount")}>
          <span className="font-semibold tabular-nums">
            {payment.amount} {payment.unit}
          </span>
        </AgreementFact>
        <AgreementFact label={t("federation.payment.occurredAt")}>
          {new Date(payment.occurredAt).toLocaleString(i18n.language)}
        </AgreementFact>
        <AgreementFact label={t("federation.billing.billId")}>{payment.billId}</AgreementFact>
        <AgreementFact label={t("federation.payment.paymentId")}>{payment.paymentId}</AgreementFact>
      </dl>
      <dl className="text-sm">
        <dt className="text-muted-foreground">{t("federation.payment.reason")}</dt>
        <dd className="mt-1 max-w-prose whitespace-pre-wrap break-words">{payment.reason}</dd>
      </dl>
      <details className="space-y-3 text-sm">
        <summary className="cursor-pointer">{t("federation.billing.references")}</summary>
        <dl className="grid gap-4 sm:grid-cols-2">
          <AgreementFact label={t("federation.payment.receiptId")}>
            {payment.receiptId}
          </AgreementFact>
          <AgreementFact label={t("federation.payment.evidenceDigest")}>
            {payment.evidenceDigest}
          </AgreementFact>
          {payment.previous ? (
            <AgreementFact label={t("federation.payment.previous")}>
              {payment.previous.receiptId}
            </AgreementFact>
          ) : null}
          <AgreementFact label={t("federation.agreements.revision")}>
            {payment.agreementRevisionId}
          </AgreementFact>
          <AgreementFact label={t("federation.agreements.source")}>
            {payment.sourceSiteId}
          </AgreementFact>
          <AgreementFact label={t("federation.agreements.target")}>
            {payment.targetSiteId}
          </AgreementFact>
        </dl>
      </details>
    </div>
  );
}

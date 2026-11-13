import type { CommercialRefund } from "@kuintessence/shared/federation/commercial";
import { useTranslation } from "react-i18next";
import { AgreementFact } from "./AgreementTerms";

export function CommercialRefundTerms({ refund }: { refund: CommercialRefund }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="space-y-5">
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <AgreementFact label={t("federation.refund.releasedAmount")}>
          <span className="font-semibold tabular-nums">
            {refund.releasedAmount} {refund.request.unit}
          </span>
        </AgreementFact>
        <AgreementFact label={t("federation.billing.issuedAt")}>
          {new Date(refund.issuedAt).toLocaleString(i18n.language)}
        </AgreementFact>
        <AgreementFact label={t("federation.refund.operationId")}>
          {refund.request.operationId}
        </AgreementFact>
        <AgreementFact label={t("federation.refund.refundId")}>{refund.refundId}</AgreementFact>
      </dl>
      <dl className="text-sm">
        <dt className="text-muted-foreground">{t("federation.refund.reason")}</dt>
        <dd className="mt-1 max-w-prose whitespace-pre-wrap break-words">{refund.reason}</dd>
      </dl>
      <details className="space-y-3 text-sm">
        <summary className="cursor-pointer">{t("federation.billing.references")}</summary>
        <dl className="grid gap-4 sm:grid-cols-2">
          <AgreementFact label={t("federation.refund.taskId")}>
            {refund.request.taskId}
          </AgreementFact>
          <AgreementFact label={t("federation.refund.attempt")}>
            {refund.request.attempt}
          </AgreementFact>
          <AgreementFact label={t("federation.refund.requestDigest")}>
            {refund.requestDigest}
          </AgreementFact>
          <AgreementFact label={t("federation.agreements.revision")}>
            {refund.request.agreementRevisionId}
          </AgreementFact>
          <AgreementFact label={t("federation.agreements.source")}>
            {refund.request.senderSiteId}
          </AgreementFact>
          <AgreementFact label={t("federation.agreements.target")}>
            {refund.request.recipientSiteId}
          </AgreementFact>
        </dl>
      </details>
    </div>
  );
}

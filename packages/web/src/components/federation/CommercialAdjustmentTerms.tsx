import type { CommercialAdjustment } from "@kuintessence/shared/federation/commercial";
import { useTranslation } from "react-i18next";
import { AgreementFact } from "./AgreementTerms";

export function CommercialAdjustmentTerms({ adjustment }: { adjustment: CommercialAdjustment }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="space-y-5">
      <dl className="grid max-w-xl grid-cols-2 gap-x-6 gap-y-3 text-sm tabular-nums">
        {(["previousChargedAmount", "chargedAmount"] as const).map((key) => (
          <div key={key} className="contents">
            <dt className={key === "chargedAmount" ? "font-semibold" : ""}>
              {t(`federation.adjustment.${key}`)}
            </dt>
            <dd className="break-all text-right">
              {adjustment[key]} {adjustment.unit}
            </dd>
          </div>
        ))}
        <dt className="border-t border-border pt-3">{t("federation.adjustment.difference")}</dt>
        <dd className="break-all border-t border-border pt-3 text-right">
          {BigInt(adjustment.chargedAmount) > BigInt(adjustment.previousChargedAmount) ? "+" : ""}
          {(BigInt(adjustment.chargedAmount) - BigInt(adjustment.previousChargedAmount)).toString()}{" "}
          {adjustment.unit}
        </dd>
      </dl>
      <dl className="grid gap-4 sm:grid-cols-2">
        <AgreementFact label={t("federation.adjustment.reason")}>{adjustment.reason}</AgreementFact>
        <AgreementFact label={t("federation.billing.issuedAt")}>
          {new Date(adjustment.issuedAt).toLocaleString(i18n.language)}
        </AgreementFact>
        <AgreementFact label={t("federation.adjustment.adjustmentId")}>
          {adjustment.adjustmentId}
        </AgreementFact>
        <AgreementFact label={t("federation.settlement.settlementId")}>
          {adjustment.settlementId}
        </AgreementFact>
      </dl>
      <details className="space-y-3 text-sm">
        <summary className="cursor-pointer">{t("federation.billing.references")}</summary>
        <dl className="grid gap-4 sm:grid-cols-2">
          <AgreementFact label={t("federation.billing.billId")}>{adjustment.billId}</AgreementFact>
          <AgreementFact label={t("federation.settlement.billDigest")}>
            {adjustment.billDigest}
          </AgreementFact>
          <AgreementFact label={t("federation.adjustment.settlementDigest")}>
            {adjustment.settlementDigest}
          </AgreementFact>
          <AgreementFact label={t("federation.adjustment.previous")}>
            {adjustment.previous?.adjustmentId ?? t("federation.adjustment.initial")}
          </AgreementFact>
          {adjustment.previous ? (
            <AgreementFact label={t("federation.adjustment.previousDigest")}>
              {adjustment.previous.digest}
            </AgreementFact>
          ) : null}
          <AgreementFact label={t("federation.adjustment.evidence")}>
            {adjustment.supportingEvidenceDigest ?? t("federation.adjustment.noEvidence")}
          </AgreementFact>
        </dl>
      </details>
    </div>
  );
}

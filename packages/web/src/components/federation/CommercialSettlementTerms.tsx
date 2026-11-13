import type { CommercialSettlement } from "@kuintessence/shared/federation/commercial";
import { useTranslation } from "react-i18next";
import { AgreementFact } from "./AgreementTerms";

export function CommercialSettlementTerms({ settlement }: { settlement: CommercialSettlement }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="space-y-5">
      <dl className="grid gap-4 sm:grid-cols-2">
        <AgreementFact label={t("federation.settlement.settlementId")}>
          {settlement.settlementId}
        </AgreementFact>
        <AgreementFact label={t("federation.billing.billId")}>{settlement.billId}</AgreementFact>
        <AgreementFact label={t("federation.billing.issuedAt")}>
          {new Date(settlement.issuedAt).toLocaleString(i18n.language)}
        </AgreementFact>
        <AgreementFact label={t("federation.settlement.unit")}>{settlement.unit}</AgreementFact>
      </dl>
      <dl className="grid max-w-xl grid-cols-2 gap-x-6 gap-y-3 text-sm tabular-nums">
        {(["reservedAmount", "chargedAmount", "releasedAmount"] as const).map((key) => (
          <div key={key} className="contents">
            <dt
              className={
                key === "releasedAmount" ? "border-t border-border pt-3 font-semibold" : ""
              }
            >
              {t(`federation.settlement.${key}`)}
            </dt>
            <dd
              className={`break-all text-right ${key === "releasedAmount" ? "border-t border-border pt-3 font-semibold" : ""}`}
            >
              {settlement[key]}
            </dd>
          </div>
        ))}
      </dl>
      <details className="space-y-3 text-sm">
        <summary className="cursor-pointer">{t("federation.billing.references")}</summary>
        <dl className="grid gap-4 sm:grid-cols-2">
          <AgreementFact label={t("federation.settlement.billDigest")}>
            {settlement.billDigest}
          </AgreementFact>
          {settlement.reservationId ? (
            <AgreementFact label={t("federation.billing.reservationId")}>
              {settlement.reservationId}
            </AgreementFact>
          ) : null}
          {settlement.terminal ? (
            <>
              <AgreementFact label={t("federation.settlement.terminalId")}>
                {settlement.terminal.terminalId}
              </AgreementFact>
              <AgreementFact label={t("federation.settlement.terminalDigest")}>
                {settlement.terminal.digest}
              </AgreementFact>
            </>
          ) : null}
        </dl>
      </details>
    </div>
  );
}

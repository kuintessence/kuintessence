import type {
  CommercialAgreementApproval,
  CommercialSubmissionsView,
} from "@kuintessence/shared/federation/commercial";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Textarea } from "../ui/input";
import { AgreementFact } from "./AgreementTerms";
import { CommercialTerms, exportCommercialTerms } from "./CommercialTerms";

export function CommercialDetail({
  approval,
  writable,
  busy,
  submissions,
  loadingSubmissions,
  failedSubmissions,
  onAttach,
  onRetry,
}: {
  approval: CommercialAgreementApproval;
  writable: boolean;
  busy: boolean;
  submissions?: CommercialSubmissionsView;
  loadingSubmissions: boolean;
  failedSubmissions: boolean;
  onAttach: (signature: string) => void;
  onRetry: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [signature, setSignature] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium">
          {t(
            approval.counterpartyJws
              ? "federation.agreements.bothSigned"
              : "federation.agreements.awaitingSignature",
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              try {
                exportCommercialTerms(approval.terms);
                setMessage(null);
              } catch {
                setMessage(t("federation.commercial.exportFailed"));
              }
            }}
          >
            {t("federation.commercial.exportTerms")}
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(approval.approvalJws);
                setMessage(t("federation.agreements.copied"));
              } catch {
                setMessage(t("federation.agreements.copyFailed"));
              }
            }}
          >
            {t("federation.agreements.copySignature")}
          </Button>
        </div>
      </div>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      <p className="max-w-prose text-sm text-muted-foreground">
        {t("federation.commercial.noExecution")}
      </p>
      <CommercialTerms terms={approval.terms} />
      <section className="space-y-3 border-t border-border pt-4">
        <h3 className="text-base font-semibold">{t("federation.commercial.ledger")}</h3>
        {approval.terms.agreement.mode === "bilateral_direct" ? (
          <p className="text-sm">{t("federation.commercial.direct")}</p>
        ) : !approval.counterpartyJws ? (
          <p className="text-sm text-muted-foreground">
            {t("federation.agreements.awaitingSignature")}
          </p>
        ) : failedSubmissions ? (
          <p role="alert">{t("federation.loadFailed")}</p>
        ) : loadingSubmissions ? (
          <p role="status">{t("federation.loading")}</p>
        ) : (
          <>
            {!submissions?.enabled ? (
              <p className="text-sm text-muted-foreground">
                {t("federation.commercial.notConfigured")}
              </p>
            ) : null}
            {submissions?.submissions.length ? (
              <ul className="divide-y divide-border">
                {submissions.submissions.map((item) => {
                  const state =
                    item.state === "pending"
                      ? item.transaction?.stage === "transaction"
                        ? "confirming"
                        : item.transaction?.stage === "proposal"
                          ? "endorsing"
                          : "queued"
                      : item.state;
                  return (
                    <li key={item.id} className="space-y-3 py-4 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span
                          className={
                            item.state === "needs_review"
                              ? "font-medium text-status-failed"
                              : "font-medium"
                          }
                        >
                          {t(`federation.commercial.states.${state}`)}
                        </span>
                        <time className="text-muted-foreground" dateTime={item.updatedAt}>
                          {new Date(item.updatedAt).toLocaleString(i18n.language)}
                        </time>
                      </div>
                      {item.lastError ? (
                        <p>
                          {t(`federation.commercial.errors.${item.lastError}`, {
                            defaultValue: t("federation.commercial.checkConfiguration"),
                          })}{" "}
                          <code className="break-all text-xs text-muted-foreground">
                            {item.lastError}
                          </code>
                        </p>
                      ) : null}
                      {item.transaction ? (
                        <dl className="grid gap-3 sm:grid-cols-2">
                          <AgreementFact label={t("federation.commercial.transaction")}>
                            {item.transaction.transactionId}
                          </AgreementFact>
                          <AgreementFact label={t("federation.commercial.block")}>
                            {item.transaction.blockNumber ?? t("federation.commercial.unconfirmed")}
                          </AgreementFact>
                          {item.transaction.validationCode !== null ? (
                            <AgreementFact label={t("federation.commercial.validationCode")}>
                              {item.transaction.validationCode}
                            </AgreementFact>
                          ) : null}
                        </dl>
                      ) : null}
                      {writable && item.state === "needs_review" ? (
                        <Button variant="outline" disabled={busy} onClick={() => onRetry(item.id)}>
                          {t("federation.commercial.actions.retry")}
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("federation.commercial.noSubmission")}
              </p>
            )}
          </>
        )}
      </section>
      <details className="border-t border-border pt-4 text-sm">
        <summary className="cursor-pointer">{t("federation.agreements.viewSignature")}</summary>
        <dl className="my-3">
          <AgreementFact label={t("federation.agreements.signedDigest")}>
            {approval.digest}
          </AgreementFact>
        </dl>
        <Textarea
          aria-label={t("federation.agreements.localSignature")}
          className="font-mono text-xs"
          rows={5}
          readOnly
          value={approval.approvalJws}
        />
      </details>
      <section className="space-y-3 border-t border-border pt-4">
        <label htmlFor={`${id}-counterparty`} className="block text-sm font-semibold">
          {t("federation.agreements.counterpartySignature")}
        </label>
        {approval.counterpartyJws || writable ? (
          <>
            <Textarea
              id={`${id}-counterparty`}
              className="font-mono text-xs"
              rows={5}
              maxLength={524288}
              readOnly={!!approval.counterpartyJws}
              disabled={!approval.counterpartyJws && busy}
              value={approval.counterpartyJws ?? signature}
              onChange={(event) => setSignature(event.target.value)}
            />
            {!approval.counterpartyJws && writable ? (
              <Button
                disabled={busy || !signature.trim()}
                onClick={() => onAttach(signature.trim())}
              >
                {t("federation.commercial.actions.attach")}
              </Button>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("federation.agreements.awaitingSignature")}
          </p>
        )}
      </section>
    </div>
  );
}

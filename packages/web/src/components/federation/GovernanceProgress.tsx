import { CaseReceiptSchema } from "@kuintessence/shared/federation/case-ledger";
import { CommercialApprovalRecordKindSchema } from "@kuintessence/shared/federation/commercial-approval-exchange";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
import { Button } from "../ui/button";
import {
  type GovernanceKind,
  type GovernanceRow,
  governanceBase,
  governanceId,
} from "./governance-policy";

const ExchangeSchema = z.object({
  enabled: z.boolean(),
  records: z
    .object({
      recordKind: CommercialApprovalRecordKindSchema,
      recordId: z.uuid(),
      state: z.enum(["pending", "complete", "needs_review"]),
      lastError: z.string().nullable(),
      nextAttemptAt: z.iso.datetime(),
      verifiedAt: z.iso.datetime().nullable(),
    })
    .array()
    .max(20),
});
const LedgerSchema = z.object({
  enabled: z.boolean(),
  data: z
    .object({
      id: z.uuid(),
      publicationId: z.uuid(),
      operation: z.enum([
        "record-case-evidence",
        "revoke-case-publication",
        "record-arbitration-decision",
      ]),
      state: z.enum(["pending", "committed", "needs_review"]),
      lastError: z.string().nullable(),
      receipt: CaseReceiptSchema.nullable(),
      nextAttemptAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    })
    .array()
    .max(20),
  hasMore: z.boolean(),
});
const RevocationsSchema = z.object({
  enabled: z.boolean(),
  sent: z
    .object({
      receivingSiteId: z.uuid(),
      state: z.enum(["pending", "received", "needs_review"]),
      lastError: z.string().nullable(),
      acknowledgedAt: z.iso.datetime().nullable(),
    })
    .array()
    .max(2),
  received: z.object({ issuerSiteId: z.uuid(), receivedAt: z.iso.datetime() }).array().max(2),
});
export function GovernanceProgress({
  kind,
  row,
  scope,
  writable,
  busy,
  onRetry,
}: {
  kind: GovernanceKind;
  row: GovernanceRow;
  scope: ApiOrganizationScope;
  writable: boolean;
  busy: boolean;
  onRetry: (endpoint: string) => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [ledgerPage, setLedgerPage] = useState(0);
  const revision = row.agreementRevisionId;
  const recordId = governanceId(row.payload);
  const base = governanceBase(kind, revision);
  const recordKind =
    kind === "arbitration"
      ? "arbitration-policy"
      : kind === "disclosure"
        ? "disclosure-policy"
        : kind === "grant"
          ? "disclosure"
          : "case-publication";
  const prefix = `/federation/commercial-agreements/${revision}/approval-exchange`;
  const exchange = useQuery({
    queryKey: [
      "federation",
      "policy-exchange",
      scope.organizationId,
      scope.authRevision,
      revision,
      kind,
      page,
    ],
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const raw = await api.get<{ data: unknown }>(
        `${kind === "publication" ? `${base}/exchange` : prefix}?limit=20&offset=${page * 20}`,
        scope,
      );
      return ExchangeSchema.parse(kind === "publication" ? raw : raw.data);
    },
  });
  const ledger = useQuery({
    queryKey: [
      "federation",
      "publication-ledger",
      scope.organizationId,
      scope.authRevision,
      revision,
      ledgerPage,
    ],
    enabled: kind === "publication",
    refetchOnWindowFocus: false,
    queryFn: async () =>
      LedgerSchema.parse(await api.get(`${base}/ledger?limit=20&offset=${ledgerPage * 20}`, scope)),
  });
  const revocationBase = `${base}/${recordId}/${kind === "publication" ? "revocations" : "revocation-deliveries"}`;
  const revocations = useQuery({
    queryKey: [
      "federation",
      "policy-revocations",
      scope.organizationId,
      scope.authRevision,
      revision,
      kind,
      recordId,
    ],
    enabled: !!row.revokedAt && (kind === "publication" || kind === "arbitration"),
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const raw = await api.get<{ data: unknown }>(revocationBase, scope);
      return RevocationsSchema.parse(kind === "arbitration" ? raw.data : raw);
    },
  });
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-medium">{t("federation.governance.progress")}</h4>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void exchange.refetch();
            if (kind === "publication") void ledger.refetch();
            if (row.revokedAt && (kind === "publication" || kind === "arbitration"))
              void revocations.refetch();
          }}
        >
          {t("federation.refresh")}
        </Button>
      </div>
      {exchange.isError ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : exchange.data ? (
        <>
          <p className="text-sm">
            {t(
              exchange.data.enabled
                ? "federation.governance.signatureExchange"
                : "federation.governance.exchangeDisabled",
            )}
          </p>
          {exchange.data.records
            .filter((item) => item.recordKind === recordKind && item.recordId === recordId)
            .map((item) => (
              <div className="flex flex-wrap items-center gap-3 text-sm" key={item.recordId}>
                <span>{t(`federation.evidence.states.${item.state}`)}</span>
                {item.lastError ? <span>{item.lastError}</span> : null}
                {writable && exchange.data.enabled && item.state === "needs_review" ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      onRetry(
                        `${kind === "publication" ? `${base}/${recordId}/exchange` : `${prefix}/${recordKind}/${recordId}`}/retry`,
                      )
                    }
                  >
                    {t("federation.governance.recover")}
                  </Button>
                ) : null}
              </div>
            ))}
          <div className="flex gap-2">
            <Button variant="outline" disabled={!page || busy} onClick={() => setPage(page - 1)}>
              {t("federation.previous")}
            </Button>
            <Button
              variant="outline"
              disabled={busy || exchange.data.records.length < 20}
              onClick={() => setPage(page + 1)}
            >
              {t("federation.next")}
            </Button>
          </div>
        </>
      ) : (
        <p role="status">{t("federation.loading")}</p>
      )}
      {kind === "publication" ? (
        ledger.isError ? (
          <p role="alert">{t("federation.evidence.ledgerFailed")}</p>
        ) : ledger.data ? (
          <>
            <p className="text-sm">
              {t(
                ledger.data.enabled
                  ? "federation.governance.caseLedger"
                  : "federation.evidence.ledgerDisabled",
              )}
            </p>
            {ledger.data.data
              .filter((item) => item.publicationId === recordId)
              .map((item) => (
                <div className="flex flex-wrap items-center gap-3 text-sm" key={item.id}>
                  <span>{t(`federation.evidence.states.${item.state}`)}</span>
                  {item.lastError ? <span>{item.lastError}</span> : null}
                  {item.receipt ? <code className="break-all">{item.receipt.recordId}</code> : null}
                  {writable && ledger.data.enabled && item.state === "needs_review" ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => onRetry(`${base}/${recordId}/ledger/${item.id}/retry`)}
                    >
                      {t("federation.governance.recover")}
                    </Button>
                  ) : null}
                </div>
              ))}
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={!ledgerPage || busy}
                onClick={() => setLedgerPage(ledgerPage - 1)}
              >
                {t("federation.previous")}
              </Button>
              <Button
                variant="outline"
                disabled={busy || !ledger.data.hasMore}
                onClick={() => setLedgerPage(ledgerPage + 1)}
              >
                {t("federation.next")}
              </Button>
            </div>
          </>
        ) : (
          <p role="status">{t("federation.loading")}</p>
        )
      ) : null}
      {row.revokedAt && (kind === "publication" || kind === "arbitration") ? (
        revocations.isError ? (
          <p role="alert">{t("federation.loadFailed")}</p>
        ) : revocations.data ? (
          <>
            <p className="text-sm">{t("federation.governance.revocationDelivery")}</p>
            {revocations.data.sent.map((item) => (
              <div key={item.receivingSiteId} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="break-all">{item.receivingSiteId}</span>
                <span>{t(`federation.evidence.states.${item.state}`)}</span>
                {item.lastError ? <span>{item.lastError}</span> : null}
                {writable && revocations.data.enabled && item.state === "needs_review" ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => onRetry(`${revocationBase}/${item.receivingSiteId}/retry`)}
                  >
                    {t("federation.governance.recover")}
                  </Button>
                ) : null}
              </div>
            ))}
          </>
        ) : (
          <p role="status">{t("federation.loading")}</p>
        )
      ) : null}
    </section>
  );
}

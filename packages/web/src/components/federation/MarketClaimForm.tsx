import {
  CommercialAgreementApprovalSchema,
  CommercialAgreementSummarySchema,
} from "@kuintessence/shared/federation/commercial";
import type {
  MarketDemandState,
  MarketProposalInput,
} from "@kuintessence/shared/federation/market";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
import { Button } from "../ui/button";
import { materialDigest } from "./asset-material";

export async function loadMarketClaimRequests(
  scope: ApiOrganizationScope,
  revision: string,
  page: number,
) {
  const result = z
    .object({
      enabled: z.boolean(),
      records: z
        .array(
          z.object({
            reservationId: z.uuid(),
            demandId: z.uuid(),
            agreementRevisionId: z.uuid(),
            direction: z.enum(["inbound", "outbound"]),
            state: z.enum(["pending", "complete", "needs_review", "closed"]),
          }),
        )
        .max(20),
    })
    .parse(
      (
        await api.get<{ data: unknown }>(
          `/federation/commercial-agreements/${revision}/market-requests?limit=20&offset=${page * 20}`,
          scope,
        )
      ).data,
    );
  if (result.records.some((row) => row.agreementRevisionId !== revision))
    throw new Error("Market request contract mismatch");
  return result;
}

export async function loadMarketClaimContract(
  scope: ApiOrganizationScope,
  localSiteId: string,
  demand: MarketDemandState,
  revision: string,
) {
  const row = CommercialAgreementApprovalSchema.parse(
    (await api.get<{ data: unknown }>(`/federation/commercial-agreements/${revision}`, scope)).data,
  );
  const terms = row.terms.agreement;
  if (
    row.localOrgId !== scope.organizationId ||
    row.localSiteId !== localSiteId ||
    row.revisionId !== revision ||
    terms.sourceSiteId !== demand.demand.sourceSiteId ||
    terms.targetSiteId !== localSiteId ||
    terms.mode !== "ledger_coordinated" ||
    !row.counterpartyJws ||
    row.digest !== (await materialDigest(row.terms))
  )
    throw new Error("Market contract binding mismatch");
  return row;
}

export function MarketClaimForm({
  scope,
  localSiteId,
  demand,
  disabled,
  onReview,
  onCancel,
}: {
  scope: ApiOrganizationScope;
  localSiteId: string;
  demand: MarketDemandState;
  disabled: boolean;
  onReview: (input: MarketProposalInput, contractRevisionId: string, requestPage: number) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState("");
  const [requestPage, setRequestPage] = useState(0);
  const [requestId, setRequestId] = useState("");
  const key = ["federation", "market-contracts", scope.organizationId, scope.authRevision];
  const agreements = useQuery({
    queryKey: [...key, page],
    queryFn: async () =>
      z
        .array(CommercialAgreementSummarySchema)
        .max(20)
        .parse(
          (
            await api.get<{ data: unknown }>(
              `/federation/commercial-agreements?limit=20&offset=${page * 20}`,
              scope,
            )
          ).data,
        ),
    refetchOnWindowFocus: false,
  });
  const approval = useQuery({
    queryKey: [...key, "detail", selected],
    enabled: !!selected,
    queryFn: () => loadMarketClaimContract(scope, localSiteId, demand, selected),
    refetchOnWindowFocus: false,
  });
  const terms = !approval.isError ? approval.data?.terms.agreement : undefined;
  const requests = useQuery({
    queryKey: [...key, "requests", selected, requestPage],
    enabled: !!terms,
    queryFn: () => loadMarketClaimRequests(scope, selected, requestPage),
    refetchOnWindowFocus: false,
  });
  const candidates = !requests.isError
    ? (requests.data?.records.filter(
        (row) =>
          row.direction === "inbound" &&
          row.demandId === demand.demand.demandId &&
          row.state === "pending",
      ) ?? [])
    : [];
  const chosen =
    candidates.length === 1
      ? candidates[0]
      : candidates.find((row) => row.reservationId === requestId);
  const usable =
    !!terms &&
    Date.parse(terms.validFrom) <= Date.now() &&
    Date.parse(terms.validUntil) > Date.now() &&
    Date.parse(terms.validUntil) >= Date.parse(demand.demand.expiresAt) &&
    Object.entries(demand.demand.resources).every(
      ([name, value]) => value <= terms.resourceLimit[name as keyof typeof terms.resourceLimit],
    );
  const options =
    agreements.data?.filter(
      (row) =>
        row.sourceSiteId === demand.demand.sourceSiteId &&
        row.targetSiteId === localSiteId &&
        row.mode === "ledger_coordinated" &&
        row.hasCounterpartyApproval,
    ) ?? [];
  return (
    <div className="max-w-3xl space-y-4">
      <h3 className="font-semibold">{t("federation.market.claim")}</h3>
      <p className="text-sm text-muted-foreground">{t("federation.market.claimWarning")}</p>
      {agreements.isError || approval.isError || requests.isError ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : null}
      <div className="space-y-1 text-sm">
        <label htmlFor={id}>{t("federation.market.fields.contract")}</label>
        <select
          id={id}
          value={selected}
          disabled={disabled || agreements.isFetching}
          onChange={(event) => {
            setSelected(event.target.value);
            setRequestPage(0);
            setRequestId("");
          }}
          className="h-10 w-full rounded-md border border-input bg-background px-3"
        >
          <option value="">{t("federation.market.chooseContract")}</option>
          {options.map((row) => (
            <option key={row.revisionId} value={row.revisionId}>
              {row.sourceName ?? row.sourceSiteId} → {row.targetName ?? row.targetSiteId} ·{" "}
              {row.revisionId}
            </option>
          ))}
        </select>
      </div>
      {agreements.data && !options.length ? (
        <p className="text-sm">{t("federation.market.noContract")}</p>
      ) : null}
      {terms && !usable ? (
        <p role="alert" className="text-sm">
          {t("federation.market.contractUnavailable")}
        </p>
      ) : null}
      {terms && requests.data && !requests.isError ? (
        <>
          {!chosen ? <p className="text-sm">{t("federation.market.waitingRequest")}</p> : null}
          {candidates.length ? (
            <div className="space-y-1 text-sm">
              <label htmlFor={`${id}-request`}>{t("federation.market.fields.reservation")}</label>
              <select
                id={`${id}-request`}
                className="h-10 w-full rounded-md border border-input bg-background px-3"
                disabled={disabled || requests.isFetching}
                value={chosen?.reservationId ?? ""}
                onChange={(event) => setRequestId(event.target.value)}
              >
                <option value="">{t("federation.market.chooseRequest")}</option>
                {candidates.map((row) => (
                  <option key={row.reservationId} value={row.reservationId}>
                    {row.reservationId}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {requestPage > 0 || requests.data.records.length === 20 ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={disabled || requests.isFetching || requestPage === 0}
                onClick={() => {
                  setRequestPage(requestPage - 1);
                  setRequestId("");
                }}
              >
                {t("federation.previous")}
              </Button>
              <Button
                variant="outline"
                disabled={disabled || requests.isFetching || requests.data.records.length !== 20}
                onClick={() => {
                  setRequestPage(requestPage + 1);
                  setRequestId("");
                }}
              >
                {t("federation.next")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {page > 0 || agreements.data?.length === 20 ? (
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={disabled || agreements.isFetching || page === 0}
            onClick={() => {
              setSelected("");
              setPage(page - 1);
            }}
          >
            {t("federation.previous")}
          </Button>
          <Button
            variant="outline"
            disabled={disabled || agreements.isFetching || agreements.data?.length !== 20}
            onClick={() => {
              setSelected("");
              setPage(page + 1);
            }}
          >
            {t("federation.next")}
          </Button>
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button
          disabled={
            disabled ||
            !usable ||
            !chosen ||
            !requests.data?.enabled ||
            requests.isFetching ||
            requests.isError ||
            approval.isFetching ||
            Date.parse(demand.demand.expiresAt) <= Date.now()
          }
          onClick={() => {
            if (!usable || !approval.data || !terms || !chosen) return;
            onReview(
              {
                operation: "claim-demand",
                claim: {
                  demandId: demand.demand.demandId,
                  claimId: chosen.reservationId,
                  providerSiteId: localSiteId,
                  commercialDomainId: approval.data.terms.domainId,
                  expectedVersion: demand.version,
                  expiresAt: new Date(
                    Math.min(Date.parse(demand.demand.expiresAt), Date.parse(terms.validUntil)),
                  ).toISOString(),
                },
              },
              selected,
              requestPage,
            );
          }}
        >
          {t("federation.market.review")}
        </Button>
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => {
            void agreements.refetch();
            if (selected) void approval.refetch();
            if (selected) void requests.refetch();
          }}
        >
          {t("federation.refresh")}
        </Button>
        <Button variant="ghost" disabled={disabled} onClick={onCancel}>
          {t("federation.cancel")}
        </Button>
      </div>
    </div>
  );
}

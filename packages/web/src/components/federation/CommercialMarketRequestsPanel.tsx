import { federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  type CommercialAgreementApproval,
  CommercialAgreementApprovalSchema,
} from "@kuintessence/shared/federation/commercial";
import type { MarketRequest } from "@kuintessence/shared/federation/market-request";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ApiError, type ApiOrganizationScope, api } from "../../lib/api-client";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { AgreementFact } from "./AgreementTerms";
import { FederationEmpty } from "./FederationLayout";
import { MarketRequestForm } from "./MarketRequestForm";
import {
  checkRequestScope,
  MarketRequestDetailSchema,
  type MarketRequestProgress,
  MarketRequestProgressSchema,
} from "./market-request-view";

type Intent =
  | { kind: "submit"; request: MarketRequest; policyId: string }
  | { kind: "retry"; row: MarketRequestProgress };
const capability = (action: Intent) =>
  action.kind === "submit" ? "delegation.submit" : "agreement.approve";
type Props = {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  grants: readonly string[];
  readOnly: boolean;
  busy: boolean;
};
export function CommercialMarketRequestsPanel(props: Props) {
  return (
    <RequestsPanel
      key={`${props.scope.organizationId}:${props.scope.authRevision}:${props.approval.revisionId}`}
      {...props}
    />
  );
}
function RequestsPanel({ approval, scope, grants, readOnly, busy }: Props) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [confirmation, setConfirmation] = useState(false);
  const attempted = useRef(new Set<string>());
  const allowed = useRef<readonly string[]>([]);
  const terms = approval.terms.agreement;
  const base = `/federation/commercial-agreements/${approval.revisionId}/market-requests`;
  const key = [
    "federation",
    "private-market-requests",
    scope.organizationId,
    scope.authRevision,
    approval.revisionId,
  ];
  const coordinated = terms.mode === "ledger_coordinated";
  const canRead = grants.includes("agreement.read");
  allowed.current = coordinated && canRead && !readOnly && !busy ? grants : [];
  useEffect(
    () => () => {
      allowed.current = [];
    },
    [],
  );
  useEffect(() => {
    if (readOnly || !grants.includes("delegation.submit")) setCreating(false);
    if (intent && (readOnly || !grants.includes(capability(intent)))) {
      setIntent(null);
      setConfirmation(false);
    }
  }, [readOnly, grants, intent]);
  const records = useQuery({
    queryKey: [...key, "list", page],
    enabled: canRead && coordinated,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const result = z
        .object({ enabled: z.boolean(), records: z.array(MarketRequestProgressSchema).max(20) })
        .parse(
          (await api.get<{ data: unknown }>(`${base}?limit=20&offset=${page * 20}`, scope)).data,
        );
      result.records.forEach((row) => {
        checkRequestScope(row, approval);
      });
      return result;
    },
  });
  async function get(id: string) {
    const row = MarketRequestDetailSchema.parse(
      (await api.get<{ data: unknown }>(`${base}/${id}`, scope)).data,
    );
    checkRequestScope(row, approval);
    const proposal = row.request.proposal,
      request = proposal.request;
    if (
      row.reservationId !== id ||
      proposal.reservationId !== id ||
      row.demandId !== proposal.demandId ||
      request.agreementRevisionId !== approval.revisionId ||
      proposal.agreementDigest !== approval.digest ||
      proposal.domainId !== approval.terms.domainId ||
      request.senderSiteId !== terms.sourceSiteId ||
      request.recipientSiteId !== terms.targetSiteId ||
      (row.direction === "outbound" ? request.senderSiteId : request.recipientSiteId) !==
        approval.localSiteId
    )
      throw new Error("Private market request binding mismatch");
    return row;
  }
  const detail = useQuery({
    queryKey: [...key, "detail", selected],
    enabled: canRead && coordinated && !!selected,
    queryFn: () => get(selected ?? ""),
    refetchOnWindowFocus: false,
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: Intent) => {
      if (!allowed.current.includes(capability(action)) || !records.data?.enabled)
        throw new Error("Market request authority unavailable");
      const id =
        action.kind === "submit" ? action.request.proposal.reservationId : action.row.reservationId;
      const hadAttempt = attempted.current.has(id);
      if (hadAttempt || action.kind === "retry") {
        try {
          const row = await get(id);
          if (action.kind === "submit") {
            if (
              row.policyId !== action.policyId ||
              row.direction !== "outbound" ||
              federationCanonicalJson(row.request) !== federationCanonicalJson(action.request)
            )
              throw new Error("Original market request mismatch");
            return row;
          }
          if (row.state !== "needs_review") return row;
        } catch (error) {
          if (
            action.kind === "retry" ||
            !(error instanceof ApiError) ||
            !(error.status === 404 || (error.status === 409 && error.code === "ASSET_UNAVAILABLE"))
          )
            throw error;
        }
      }
      if (action.kind === "submit") {
        const current = CommercialAgreementApprovalSchema.parse(
          (
            await api.get<{ data: unknown }>(
              `/federation/commercial-agreements/${approval.revisionId}`,
              scope,
            )
          ).data,
        );
        if (
          current.localOrgId !== scope.organizationId ||
          current.localSiteId !== approval.localSiteId ||
          current.revisionId !== approval.revisionId ||
          !current.counterpartyJws ||
          current.digest !== approval.digest ||
          federationCanonicalJson(current.terms) !== federationCanonicalJson(approval.terms)
        )
          throw new Error("Commercial agreement changed");
      }
      if (!allowed.current.includes(capability(action)))
        throw new Error("Market request authority changed");
      attempted.current.add(id);
      let result: { data: unknown };
      try {
        result = await api.post<{ data: unknown }>(
          action.kind === "retry" ? `${base}/${id}/retry` : base,
          action.kind === "submit" ? { policyId: action.policyId, request: action.request } : {},
          scope,
        );
      } catch (error) {
        // A failed recovery read cannot establish whether the original POST committed.
        if (!hadAttempt && error instanceof ApiError && [400, 403, 409].includes(error.status))
          attempted.current.delete(id);
        throw error;
      }
      if (action.kind === "retry") return get(id);
      const row = checkRequestScope(MarketRequestProgressSchema.parse(result.data), approval);
      if (
        row.reservationId !== id ||
        row.policyId !== action.policyId ||
        row.demandId !== action.request.demand.demandId ||
        row.direction !== "outbound"
      )
        throw new Error("Market request acceptance mismatch");
      return row;
    },
    onSuccess: async (row) => {
      setSelected(row.reservationId);
      setIntent(null);
      setConfirmation(false);
      setCreating(false);
      await client.invalidateQueries({ queryKey: key });
    },
  });
  const blocked = busy || mutation.isPending;
  const canCreate =
    allowed.current.includes("delegation.submit") &&
    !!approval.counterpartyJws &&
    approval.localSiteId === terms.sourceSiteId &&
    records.data?.enabled &&
    Date.parse(terms.validFrom) <= Date.now() &&
    Date.parse(terms.validUntil) > Date.now();
  const uncertain =
    mutation.isError &&
    !!intent &&
    attempted.current.has(
      intent.kind === "submit" ? intent.request.proposal.reservationId : intent.row.reservationId,
    );
  const review = (action: Intent) => {
    mutation.reset();
    setIntent(action);
    setConfirmation(true);
  };
  const time = (value: string | null) =>
    value ? new Date(value).toLocaleString(i18n.language) : t("federation.marketRequest.missing");
  if (!canRead || !coordinated) return null;
  const row = !detail.isError ? detail.data : undefined;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="font-semibold">{t("federation.marketRequest.title")}</h3>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={blocked}
            onClick={() => {
              void records.refetch();
              if (selected) void detail.refetch();
            }}
          >
            {t("federation.refresh")}
          </Button>
          {canCreate && !creating && !intent ? (
            <Button
              disabled={blocked}
              onClick={() => {
                setCreating(true);
                setSelected(null);
              }}
            >
              {t("federation.marketRequest.create")}
            </Button>
          ) : null}
        </div>
      </div>
      {records.data?.enabled === false ? (
        <p role="status">{t("federation.marketRequest.disabled")}</p>
      ) : null}
      {records.isError ? <p role="alert">{t("federation.loadFailed")}</p> : null}
      {records.isPending ? <p role="status">{t("federation.loading")}</p> : null}
      {mutation.isError ? (
        <p role="alert">
          {t(uncertain ? "federation.marketRequest.unknown" : "federation.marketRequest.rejected")}
        </p>
      ) : null}
      {intent && !confirmation ? (
        <div className="space-y-2">
          <p className="break-all text-sm">
            {t("federation.market.fields.reservation")}:{" "}
            {intent.kind === "submit"
              ? intent.request.proposal.reservationId
              : intent.row.reservationId}
          </p>
          <Button disabled={blocked} onClick={() => setConfirmation(true)}>
            {t("federation.market.resume")}
          </Button>
          {!uncertain ? (
            <Button
              variant="ghost"
              disabled={blocked}
              onClick={() => {
                setIntent(null);
                mutation.reset();
              }}
            >
              {t("federation.cancel")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {creating && !intent ? (
        <MarketRequestForm
          approval={approval}
          scope={scope}
          disabled={blocked || !canCreate}
          onReview={(request, policyId) => review({ kind: "submit", request, policyId })}
          onCancel={() => setCreating(false)}
        />
      ) : null}
      {!creating ? (
        selected ? (
          <div className="space-y-4">
            <Button variant="ghost" disabled={blocked} onClick={() => setSelected(null)}>
              {t("federation.market.back")}
            </Button>
            {detail.isError ? (
              <p role="alert">{t("federation.loadFailed")}</p>
            ) : detail.isPending ? (
              <p role="status">{t("federation.loading")}</p>
            ) : row ? (
              <>
                <h4 className="font-medium">{row.request.demand.title}</h4>
                <dl className="grid gap-4 text-sm sm:grid-cols-2">
                  <AgreementFact label={t("federation.market.fields.reservation")}>
                    {row.reservationId}
                  </AgreementFact>
                  <AgreementFact label={t("federation.market.status")}>
                    {t(`federation.marketRequest.states.${row.state}`)}
                  </AgreementFact>
                  <AgreementFact label={t("federation.marketRequest.direction")}>
                    {t(`federation.marketRequest.${row.direction}`)}
                  </AgreementFact>
                  <AgreementFact label={t("federation.marketRequest.policy")}>
                    {row.policyId}
                  </AgreementFact>
                  <AgreementFact label={t("federation.marketRequest.recipient")}>
                    {row.request.proposal.request.recipientSiteId}
                  </AgreementFact>
                  <AgreementFact label={t("federation.tasks.maxAmount")}>
                    {row.request.proposal.request.maxAmount} {row.request.proposal.request.unit}
                  </AgreementFact>
                  <AgreementFact label={t("federation.market.fields.expiresAt")}>
                    {time(row.request.demand.expiresAt)}
                  </AgreementFact>
                  <AgreementFact label={t("federation.marketRequest.nextAttemptAt")}>
                    {time(row.nextAttemptAt)}
                  </AgreementFact>
                </dl>
                <p className="text-sm text-muted-foreground">
                  {t("federation.marketRequest.executionBoundary")}
                </p>
                {row.lastError ? (
                  <p role="alert" className="break-all">
                    {row.lastError}
                  </p>
                ) : null}
                {row.state === "needs_review" &&
                allowed.current.includes("agreement.approve") &&
                records.data?.enabled &&
                !intent ? (
                  <Button
                    disabled={blocked || detail.isFetching}
                    onClick={() => review({ kind: "retry", row })}
                  >
                    {t("federation.marketRequest.retry")}
                  </Button>
                ) : null}
                <details>
                  <summary className="cursor-pointer text-sm">
                    {t("federation.market.original")}
                  </summary>
                  <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-sm">
                    {JSON.stringify(row.request, null, 2)}
                  </pre>
                </details>
              </>
            ) : null}
          </div>
        ) : records.data && !records.isError ? (
          <>
            <div className="divide-y">
              {records.data.records.map((record) => (
                <button
                  key={record.reservationId}
                  type="button"
                  className="flex w-full flex-wrap justify-between gap-2 py-4 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  disabled={blocked}
                  onClick={() => setSelected(record.reservationId)}
                >
                  <span className="min-w-0 break-all text-sm">
                    {t(`federation.marketRequest.${record.direction}`)} · {record.reservationId}
                  </span>
                  <span className="text-sm">
                    {t(`federation.marketRequest.states.${record.state}`)}
                  </span>
                </button>
              ))}
            </div>
            {!records.data.records.length ? (
              <FederationEmpty>{t("federation.marketRequest.empty")}</FederationEmpty>
            ) : null}
            {page > 0 || records.data.records.length === 20 ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={blocked || page === 0 || records.isFetching}
                  onClick={() => setPage(page - 1)}
                >
                  {t("federation.previous")}
                </Button>
                <Button
                  variant="outline"
                  disabled={blocked || records.data.records.length !== 20 || records.isFetching}
                  onClick={() => setPage(page + 1)}
                >
                  {t("federation.next")}
                </Button>
              </div>
            ) : null}
          </>
        ) : null
      ) : null}
      <Dialog
        open={confirmation && !!intent && !readOnly}
        onOpenChange={(open) => {
          if (!blocked) setConfirmation(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("federation.market.review")}</DialogTitle>
            <DialogDescription>{t("federation.marketRequest.confirmWarning")}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {mutation.isError ? (
              <p role="alert" className="mb-4 text-sm">
                {t(
                  uncertain
                    ? "federation.marketRequest.unknown"
                    : "federation.marketRequest.rejected",
                )}
              </p>
            ) : null}
            {intent ? (
              <div className="space-y-4 text-sm">
                <dl className="grid gap-4 sm:grid-cols-2">
                  <AgreementFact label={t("federation.market.fields.reservation")}>
                    {intent.kind === "submit"
                      ? intent.request.proposal.reservationId
                      : intent.row.reservationId}
                  </AgreementFact>
                  {intent.kind === "submit" ? (
                    <>
                      <AgreementFact label={t("federation.marketRequest.policy")}>
                        {intent.policyId}
                      </AgreementFact>
                      <AgreementFact label={t("federation.marketRequest.recipient")}>
                        {intent.request.proposal.request.recipientSiteId}
                      </AgreementFact>
                      <AgreementFact label={t("federation.tasks.maxAmount")}>
                        {intent.request.proposal.request.maxAmount} {terms.unit}
                      </AgreementFact>
                    </>
                  ) : null}
                </dl>
                {intent.kind === "submit" ? (
                  <>
                    <p className="font-medium">{intent.request.demand.title}</p>
                    <details>
                      <summary className="cursor-pointer">
                        {t("federation.market.original")}
                      </summary>
                      <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all">
                        {JSON.stringify(intent.request, null, 2)}
                      </pre>
                    </details>
                  </>
                ) : null}
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={blocked} onClick={() => setConfirmation(false)}>
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={
                blocked ||
                !intent ||
                !allowed.current.includes(capability(intent)) ||
                !records.data?.enabled
              }
              onClick={() => {
                if (intent) mutation.mutate(intent);
              }}
            >
              {t(uncertain ? "federation.market.retrySame" : "federation.market.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

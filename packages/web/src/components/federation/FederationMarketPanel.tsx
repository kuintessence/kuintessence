import {
  FederationCurrentCapabilitiesSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import {
  type MarketDemandState,
  type MarketProposalInput,
  MarketProposalInputSchema,
  MarketQueryResultSchema,
} from "@kuintessence/shared/federation/market";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ApiError, type ApiOrganizationScope, api } from "../../lib/api-client";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { Badge } from "../ui/badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { AgreementFact } from "./AgreementTerms";
import { materialDigest } from "./asset-material";
import { FederationEmpty, FederationPanelHeader } from "./FederationLayout";
import {
  loadMarketClaimContract,
  loadMarketClaimRequests,
  MarketClaimForm,
} from "./MarketClaimForm";
import { MarketDemandForm } from "./MarketDemandForm";
import {
  MarketAcceptedSchema,
  MarketOperationDetailSchema,
  MarketOperationsSchema,
  marketCapability,
  marketIdentity,
  verifyMarketOperation,
} from "./market-view";

const path = "/federation/market";
type Intent =
  | {
      kind: "submit";
      input: MarketProposalInput;
      contractRevisionId?: string;
      requestPage?: number;
    }
  | { kind: "retry"; id: string };
export function FederationMarketPanel(props: { scope: ApiOrganizationScope; switching: boolean }) {
  return (
    <MarketPanel key={`${props.scope.organizationId}:${props.scope.authRevision}`} {...props} />
  );
}
function MarketPanel({ scope, switching }: { scope: ApiOrganizationScope; switching: boolean }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const key = ["federation", "market", scope.organizationId, scope.authRevision];
  const [tab, setTab] = useState("directory");
  const [bookmarks, setBookmarks] = useState([""]);
  const [page, setPage] = useState(0);
  const [txPage, setTxPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [confirmation, setConfirmation] = useState(false);
  const submitted = useRef(new Set<string>());
  const readOnly = useMobileMutationBlocked(path);
  const capabilities = useQuery({
    queryKey: ["federation", "current-capabilities", scope.organizationId, scope.authRevision],
    queryFn: async () =>
      FederationCurrentCapabilitiesSchema.parse(
        (await api.get<{ data: unknown }>("/federation/capabilities", scope)).data,
      ),
    refetchOnWindowFocus: false,
  });
  const grants =
    !capabilities.isError && capabilities.data?.orgId === scope.organizationId
      ? capabilities.data.effectiveCapabilities
      : [];
  const canRead = grants.includes("market.read");
  const context = useQuery({
    queryKey: [...key, "context"],
    enabled: canRead,
    queryFn: async () =>
      z
        .object({ localSiteId: z.uuid(), enabled: z.boolean() })
        .parse((await api.get<{ data: unknown }>(`${path}/context`, scope)).data),
    refetchOnWindowFocus: false,
  });
  const localSiteId = !context.isError ? context.data?.localSiteId : undefined;
  const allowed = useRef<readonly string[]>([]);
  useEffect(
    () => () => {
      allowed.current = [];
    },
    [],
  );
  allowed.current =
    canRead &&
    !readOnly &&
    !switching &&
    !capabilities.isFetching &&
    !context.isFetching &&
    localSiteId
      ? grants
      : [];
  useEffect(() => {
    if (readOnly || !grants.includes("market.publish")) setCreating(false);
    if (readOnly || !grants.includes("market.claim")) setClaiming(false);
    if (
      intent &&
      (readOnly ||
        !grants.includes(intent.kind === "submit" ? marketCapability(intent.input) : "market.read"))
    ) {
      setIntent(null);
      setConfirmation(false);
    }
  }, [grants, readOnly, intent]);
  async function getDemand(id: string) {
    const result = MarketQueryResultSchema.options[1]
      .extend({ observedAt: MarketOperationsTime })
      .parse((await api.get<{ data: unknown }>(`${path}/demands/${id}`, scope)).data);
    if (
      !result.demand ||
      result.demand.demand.demandId !== id ||
      result.demand.digest !== (await materialDigest(result.demand.demand))
    )
      throw new Error("Market demand binding mismatch");
    return result;
  }
  const operations = useQuery({
    queryKey: [...key, "operations", page],
    enabled: canRead,
    queryFn: async () => {
      const result = MarketOperationsSchema.parse(
        (await api.get<{ data: unknown }>(`${path}/operations?limit=20&offset=${page * 20}`, scope))
          .data,
      );
      if (localSiteId)
        await Promise.all(result.data.map((row) => verifyMarketOperation(row, localSiteId)));
      return result;
    },
    refetchOnWindowFocus: false,
  });
  const directory = useQuery({
    queryKey: [...key, "directory", bookmarks.at(-1)],
    enabled:
      canRead && context.data?.enabled === true && tab === "directory" && !selected && !creating,
    queryFn: async () => {
      const result = MarketQueryResultSchema.options[0]
        .extend({ observedAt: MarketOperationsTime })
        .parse(
          (
            await api.get<{ data: unknown }>(
              `${path}/demands?limit=20&bookmark=${encodeURIComponent(bookmarks.at(-1) ?? "")}`,
              scope,
            )
          ).data,
        );
      if (
        result.demands.length > 20 ||
        new Set(result.demands.map((row) => row.demand.demandId)).size !== result.demands.length ||
        (result.bookmark && bookmarks.includes(result.bookmark))
      )
        throw new Error("Invalid market page");
      await Promise.all(
        result.demands.map(async (row) => {
          if (row.digest !== (await materialDigest(row.demand)))
            throw new Error("Market demand digest mismatch");
        }),
      );
      return result;
    },
    refetchOnWindowFocus: false,
  });
  const detail = useQuery({
    queryKey: [...key, "demand", selected],
    enabled: canRead && !!selected,
    queryFn: () => getDemand(selected ?? ""),
    refetchOnWindowFocus: false,
  });
  async function getOperation(id: string) {
    const result = MarketOperationDetailSchema.parse(
      (
        await api.get<{ data: unknown }>(
          `${path}/operations/${id}?limit=20&offset=${txPage * 20}`,
          scope,
        )
      ).data,
    );
    if (result.operation.id !== id) throw new Error("Market operation mismatch");
    if (localSiteId) await verifyMarketOperation(result.operation, localSiteId);
    return result;
  }
  const transaction = useQuery({
    queryKey: [...key, "operation", operation, txPage],
    enabled: canRead && !!operation,
    queryFn: () => getOperation(operation ?? ""),
    refetchOnWindowFocus: false,
  });
  const enabled =
    !context.isError &&
    context.data?.enabled === true &&
    !operations.isError &&
    operations.data?.enabled === true;
  const mutation = useMutation({
    mutationFn: async (action: Intent) => {
      if (!localSiteId || !enabled) throw new Error("Market unavailable");
      if (action.kind === "retry") {
        const original = await getOperation(action.id);
        const input = original.operation.input;
        const grant =
          input.operation === "claim-demand"
            ? "market.claim"
            : input.operation === "publish-demand" || input.operation === "cancel-open-demand"
              ? "market.publish"
              : null;
        if (!grant || !allowed.current.includes(grant)) throw new Error("Market retry unavailable");
        if (original.operation.state !== "needs_review") return action.id;
        await api.post(`${path}/operations/${action.id}/retry`, {}, scope);
        return action.id;
      }
      const input = MarketProposalInputSchema.parse(action.input);
      if (!allowed.current.includes(marketCapability(input)))
        throw new Error("Market permission unavailable");
      const identity = marketIdentity(input);
      if (submitted.current.has(identity.id)) {
        try {
          const prior = await getOperation(identity.id);
          if (federationCanonicalJson(prior.operation.input) !== federationCanonicalJson(input))
            throw new Error("Market original mismatch");
          return identity.id;
        } catch (error) {
          if (
            !(
              error instanceof ApiError &&
              (error.status === 404 || (error.status === 409 && error.code === "ASSET_UNAVAILABLE"))
            )
          )
            throw error;
        }
      }
      if (input.operation === "publish-demand") {
        if (
          input.demand.sourceSiteId !== localSiteId ||
          Date.parse(input.demand.expiresAt) <= Date.now()
        )
          throw new Error("Market demand expired");
      } else if (input.operation === "claim-demand" || input.operation === "cancel-open-demand") {
        const value = input.operation === "claim-demand" ? input.claim : input.cancellation;
        const current = (await getDemand(value.demandId)).demand;
        if (
          !current ||
          current.status !== "OPEN" ||
          current.version !== value.expectedVersion ||
          (input.operation === "claim-demand" &&
            Date.parse(current.demand.expiresAt) <= Date.now()) ||
          (input.operation === "claim-demand"
            ? input.claim.providerSiteId !== localSiteId ||
              current.demand.sourceSiteId === localSiteId
            : current.demand.sourceSiteId !== localSiteId)
        )
          throw new Error("Market version changed");
        if (input.operation === "claim-demand") {
          if (!action.contractRevisionId || !allowed.current.includes("agreement.read"))
            throw new Error("Market contract required");
          const contract = await loadMarketClaimContract(
            scope,
            localSiteId,
            current,
            action.contractRevisionId,
          );
          const terms = contract.terms.agreement;
          const requests = await loadMarketClaimRequests(
            scope,
            action.contractRevisionId,
            action.requestPage ?? 0,
          );
          if (
            !requests.enabled ||
            !requests.records.some(
              (row) =>
                row.reservationId === input.claim.claimId &&
                row.demandId === input.claim.demandId &&
                row.direction === "inbound" &&
                row.state === "pending",
            )
          )
            throw new Error("Original market request unavailable");
          if (
            contract.terms.domainId !== input.claim.commercialDomainId ||
            Date.parse(terms.validFrom) > Date.now() ||
            Date.parse(terms.validUntil) <= Date.now() ||
            Date.parse(input.claim.expiresAt) > Date.parse(terms.validUntil) ||
            Object.entries(current.demand.resources).some(
              ([name, value]) =>
                value > terms.resourceLimit[name as keyof typeof terms.resourceLimit],
            )
          )
            throw new Error("Market contract unavailable");
        }
      }
      if (!allowed.current.includes(marketCapability(input)))
        throw new Error("Market permission changed");
      submitted.current.add(identity.id);
      const accepted = MarketAcceptedSchema.parse(
        (await api.post<{ data: unknown }>(`${path}/operations`, input, scope)).data,
      );
      if (accepted.id !== identity.id || accepted.demandId !== identity.demandId)
        throw new Error("Market receipt mismatch");
      return accepted.id;
    },
    onSuccess: complete,
  });
  async function complete(id: string) {
    setConfirmation(false);
    setIntent(null);
    setCreating(false);
    setClaiming(false);
    setOperation(id);
    setTxPage(0);
    setTab("operations");
    await client.invalidateQueries({ queryKey: key });
  }
  const recover = useMutation({
    mutationFn: async () => {
      if (intent?.kind !== "submit" || !canRead) throw new Error("No original request");
      const id = marketIdentity(intent.input).id;
      const original = await getOperation(id);
      if (
        federationCanonicalJson(original.operation.input) !== federationCanonicalJson(intent.input)
      )
        throw new Error("Original request mismatch");
      return id;
    },
    onSuccess: async (id) => {
      mutation.reset();
      await complete(id);
    },
  });
  const uncertain =
    mutation.isError &&
    !!intent &&
    (intent.kind === "retry" || submitted.current.has(marketIdentity(intent.input).id)) &&
    !(mutation.error instanceof ApiError && [400, 403, 409].includes(mutation.error.status));
  const busy =
    switching ||
    capabilities.isFetching ||
    context.isFetching ||
    mutation.isPending ||
    recover.isPending;
  function review(action: Intent) {
    mutation.reset();
    recover.reset();
    setIntent(action);
    setConfirmation(true);
  }
  function refresh() {
    void capabilities.refetch();
    if (canRead) void context.refetch();
    void client.invalidateQueries({ queryKey: key });
  }
  const demand = !detail.isError ? detail.data?.demand : null;
  const op = !transaction.isError ? transaction.data?.operation : null;
  const date = (value: string) => new Date(value).toLocaleString(i18n.language);
  const facts = (row: MarketDemandState) => (
    <dl className="grid gap-4 text-sm sm:grid-cols-2">
      <AgreementFact label={t("federation.market.status")}>
        {t(`federation.market.states.${row.status}`)}
      </AgreementFact>
      <AgreementFact label={t("federation.market.fields.source")}>
        {row.demand.sourceSiteId}
      </AgreementFact>
      <AgreementFact label={t("federation.market.fields.platform")}>
        {row.demand.platform} / {row.demand.architecture}
      </AgreementFact>
      <AgreementFact label={t("federation.market.fields.expiresAt")}>
        {date(row.demand.expiresAt)}
      </AgreementFact>
      {Object.entries(row.demand.resources).map(([name, value]) => (
        <AgreementFact key={name} label={t(`federation.market.fields.${name}`)}>
          {value.toLocaleString(i18n.language)}
        </AgreementFact>
      ))}
      <AgreementFact label={t("federation.market.fields.id")}>{row.demand.demandId}</AgreementFact>
      <AgreementFact label={t("federation.market.version")}>{row.version}</AgreementFact>
      {row.claim ? (
        <AgreementFact label={t("federation.market.fields.provider")}>
          {row.claim.providerSiteId}
        </AgreementFact>
      ) : null}
    </dl>
  );
  if (capabilities.isPending) return <p role="status">{t("federation.loading")}</p>;
  if (!canRead)
    return (
      <div className="space-y-3">
        <p role={capabilities.isError ? "alert" : "status"}>
          {t(capabilities.isError ? "federation.loadFailed" : "federation.market.noPermission")}
        </p>
        <Button variant="outline" onClick={refresh}>
          {t("federation.refresh")}
        </Button>
      </div>
    );
  return (
    <div className="space-y-5">
      <FederationPanelHeader title={t("federation.market.title")}>
        <Button variant="outline" disabled={busy} onClick={refresh}>
          {t("federation.refresh")}
        </Button>
        {enabled &&
        localSiteId &&
        grants.includes("market.publish") &&
        !readOnly &&
        !creating &&
        !intent ? (
          <Button
            disabled={busy}
            onClick={() => {
              setCreating(true);
              setSelected(null);
              setOperation(null);
            }}
          >
            {t("federation.market.publish")}
          </Button>
        ) : null}
      </FederationPanelHeader>
      {operations.data?.enabled === false && !operations.isError ? (
        <p role="status">{t("federation.market.disabled")}</p>
      ) : null}
      {context.isError ? <p role="alert">{t("federation.loadFailed")}</p> : null}
      {recover.isError ? <p role="alert">{t("federation.market.operationUnavailable")}</p> : null}
      {mutation.isError ? (
        <div role="alert" className="space-y-2">
          <p>{t(uncertain ? "federation.market.unknown" : "federation.market.rejected")}</p>
          {uncertain && intent?.kind === "submit" ? (
            <p className="break-all text-sm">
              {t("federation.market.operationId")}: {marketIdentity(intent.input).id}
            </p>
          ) : null}
        </div>
      ) : null}
      {intent && !confirmation ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => setConfirmation(true)}>
            {t("federation.market.resume")}
          </Button>
          {intent.kind === "submit" ? (
            <Button variant="outline" disabled={busy} onClick={() => recover.mutate()}>
              {t("federation.market.findOriginal")}
            </Button>
          ) : null}
          {!uncertain ? (
            <Button
              variant="ghost"
              disabled={busy}
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
      {creating && localSiteId && !intent ? (
        <MarketDemandForm
          localSiteId={localSiteId}
          disabled={busy || !enabled}
          onReview={(input) => review({ kind: "submit", input })}
          onCancel={() => setCreating(false)}
        />
      ) : null}
      {!creating || intent ? (
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value);
            setSelected(null);
            setOperation(null);
            setClaiming(false);
          }}
        >
          <TabsList className="federation-subnav" aria-label={t("federation.market.title")}>
            <TabsTrigger value="directory">{t("federation.market.directory")}</TabsTrigger>
            <TabsTrigger value="operations">{t("federation.market.operations")}</TabsTrigger>
          </TabsList>
          <TabsContent value="directory" className="space-y-4">
            {selected ? (
              <>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setSelected(null);
                    setClaiming(false);
                  }}
                >
                  {t("federation.market.back")}
                </Button>
                {detail.isPending ? (
                  <p role="status">{t("federation.loading")}</p>
                ) : detail.isError ? (
                  <p role="alert">{t("federation.market.unavailable")}</p>
                ) : demand ? (
                  <>
                    <h3 className="font-semibold">{demand.demand.title}</h3>
                    <p className="max-w-prose whitespace-pre-wrap break-words text-sm">
                      {demand.demand.description}
                    </p>
                    {facts(demand)}
                    <p className="text-sm text-muted-foreground">
                      {t("federation.market.observedAt", { time: date(detail.data.observedAt) })}
                    </p>
                    {claiming && localSiteId ? (
                      <MarketClaimForm
                        scope={scope}
                        localSiteId={localSiteId}
                        demand={demand}
                        disabled={busy || !!intent || detail.isFetching || !enabled}
                        onReview={(input, contractRevisionId, requestPage) =>
                          review({ kind: "submit", input, contractRevisionId, requestPage })
                        }
                        onCancel={() => setClaiming(false)}
                      />
                    ) : null}
                    {demand.status === "OPEN" && enabled && localSiteId && !readOnly && !intent ? (
                      <div className="flex flex-wrap gap-2">
                        {grants.includes("market.claim") &&
                        grants.includes("agreement.read") &&
                        demand.demand.sourceSiteId !== localSiteId &&
                        !claiming &&
                        Date.parse(demand.demand.expiresAt) > Date.now() ? (
                          <Button
                            disabled={busy || detail.isFetching}
                            onClick={() => setClaiming(true)}
                          >
                            {t("federation.market.claim")}
                          </Button>
                        ) : null}
                        {grants.includes("market.publish") &&
                        demand.demand.sourceSiteId === localSiteId ? (
                          <Button
                            variant="outline"
                            disabled={busy || detail.isFetching}
                            onClick={() =>
                              review({
                                kind: "submit",
                                input: {
                                  operation: "cancel-open-demand",
                                  cancellation: {
                                    demandId: demand.demand.demandId,
                                    cancellationId: crypto.randomUUID(),
                                    expectedVersion: demand.version,
                                  },
                                },
                              })
                            }
                          >
                            {t("federation.market.cancelDemand")}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : context.data?.enabled === false ? null : directory.isError ? (
              <p role="alert">{t("federation.market.unavailable")}</p>
            ) : directory.isPending ? (
              <p role="status">{t("federation.loading")}</p>
            ) : (
              <>
                <div className="federation-list divide-y">
                  {directory.data.demands.map((row) => (
                    <button
                      key={row.demand.demandId}
                      type="button"
                      className="federation-list-row flex w-full flex-wrap items-center justify-between gap-2 py-4 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setSelected(row.demand.demandId)}
                    >
                      <span className="min-w-0 break-words font-medium">{row.demand.title}</span>
                      <Badge variant="outline">
                        {t(`federation.market.states.${row.status}`)}
                        {Date.parse(row.demand.expiresAt) <= Date.now()
                          ? ` · ${t("federation.market.expired")}`
                          : ""}
                      </Badge>
                    </button>
                  ))}
                </div>
                {!directory.data.demands.length ? (
                  <FederationEmpty>{t("federation.market.empty")}</FederationEmpty>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  {t("federation.market.observedAt", { time: date(directory.data.observedAt) })}
                </p>
                {bookmarks.length > 1 || directory.data.bookmark ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={bookmarks.length === 1 || directory.isFetching}
                      onClick={() => setBookmarks(bookmarks.slice(0, -1))}
                    >
                      {t("federation.previous")}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!directory.data.bookmark || directory.isFetching}
                      onClick={() => setBookmarks([...bookmarks, directory.data.bookmark])}
                    >
                      {t("federation.next")}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </TabsContent>
          <TabsContent value="operations" className="space-y-4">
            {operation ? (
              <>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setOperation(null);
                    setTxPage(0);
                  }}
                >
                  {t("federation.market.back")}
                </Button>
                {transaction.isError ? (
                  <p role="alert">{t("federation.market.operationUnavailable")}</p>
                ) : transaction.isPending ? (
                  <p role="status">{t("federation.loading")}</p>
                ) : op ? (
                  <>
                    <h3 className="font-semibold">
                      {t(`federation.market.actions.${op.input.operation}`)}
                    </h3>
                    <dl className="grid gap-4 text-sm sm:grid-cols-2">
                      <AgreementFact label={t("federation.market.operationId")}>
                        {op.id}
                      </AgreementFact>
                      <AgreementFact label={t("federation.market.status")}>
                        {t(`federation.market.states.${op.state}`)}
                      </AgreementFact>
                      <AgreementFact label={t("federation.market.updatedAt")}>
                        {date(op.updatedAt)}
                      </AgreementFact>
                      <AgreementFact label="SHA-256">{op.digest}</AgreementFact>
                    </dl>
                    {op.lastError ? (
                      <p role="alert" className="break-all">
                        {op.lastError}
                      </p>
                    ) : null}
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSelected(op.demandId);
                        setTab("directory");
                        setOperation(null);
                      }}
                    >
                      {t("federation.market.viewDemand")}
                    </Button>
                    {op.state === "needs_review" &&
                    !intent &&
                    enabled &&
                    !readOnly &&
                    localSiteId &&
                    ["publish-demand", "cancel-open-demand", "claim-demand"].includes(
                      op.input.operation,
                    ) &&
                    grants.includes(
                      op.input.operation === "claim-demand" ? "market.claim" : "market.publish",
                    ) ? (
                      <Button
                        disabled={busy || transaction.isFetching}
                        onClick={() => review({ kind: "retry", id: op.id })}
                      >
                        {t("federation.market.retry")}
                      </Button>
                    ) : null}
                    <h4 className="font-medium">{t("federation.market.transactions")}</h4>
                    <ul className="divide-y text-sm">
                      {transaction.data.transactions.map((tx) => (
                        <li key={tx.number} className="space-y-1 py-3">
                          <p className="break-all">
                            #{tx.number} · {tx.transactionId}
                          </p>
                          <p>
                            {t(`federation.market.states.${tx.stage}`)}
                            {tx.blockNumber !== null
                              ? ` · ${t("federation.market.block")}: ${tx.blockNumber}`
                              : ""}
                            {tx.validationCode !== null
                              ? ` · ${t("federation.market.validation")}: ${tx.validationCode}`
                              : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                    {!transaction.data.transactions.length ? (
                      <p className="text-sm">{t("federation.market.noTransactions")}</p>
                    ) : null}
                    {txPage > 0 || transaction.data.hasMore ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          disabled={txPage === 0 || transaction.isFetching}
                          onClick={() => setTxPage(txPage - 1)}
                        >
                          {t("federation.previous")}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={!transaction.data.hasMore || transaction.isFetching}
                          onClick={() => setTxPage(txPage + 1)}
                        >
                          {t("federation.next")}
                        </Button>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : operations.isError ? (
              <p role="alert">{t("federation.loadFailed")}</p>
            ) : operations.isPending ? (
              <p role="status">{t("federation.loading")}</p>
            ) : (
              <>
                <div className="federation-list divide-y">
                  {operations.data.data.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className="federation-list-row flex w-full flex-wrap justify-between gap-2 py-4 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => {
                        setOperation(row.id);
                        setTxPage(0);
                      }}
                    >
                      <span className="min-w-0 break-all text-sm">
                        {t(`federation.market.actions.${row.input.operation}`)} · {row.id}
                      </span>
                      <span className="text-sm">{t(`federation.market.states.${row.state}`)}</span>
                    </button>
                  ))}
                </div>
                {!operations.data.data.length ? (
                  <FederationEmpty>{t("federation.market.emptyOperations")}</FederationEmpty>
                ) : null}
                {page > 0 || operations.data.hasMore ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={page === 0 || operations.isFetching}
                      onClick={() => setPage(page - 1)}
                    >
                      {t("federation.previous")}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!operations.data.hasMore || operations.isFetching}
                      onClick={() => setPage(page + 1)}
                    >
                      {t("federation.next")}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </TabsContent>
        </Tabs>
      ) : null}
      <Dialog
        open={confirmation && !!intent && !readOnly}
        onOpenChange={(open) => {
          if (!busy) setConfirmation(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("federation.market.review")}</DialogTitle>
            <DialogDescription>
              {t(
                intent?.kind === "submit" && intent.input.operation === "publish-demand"
                  ? "federation.market.publicWarning"
                  : "federation.market.confirmWarning",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {mutation.isError ? (
              <p role="alert" className="mb-4 text-sm">
                {t(uncertain ? "federation.market.unknown" : "federation.market.rejected")}
              </p>
            ) : null}
            {intent ? (
              <div className="space-y-4 text-sm">
                <p className="font-medium">
                  {t(
                    intent.kind === "submit"
                      ? `federation.market.actions.${intent.input.operation}`
                      : "federation.market.retry",
                  )}
                </p>
                <dl>
                  <AgreementFact label={t("federation.market.operationId")}>
                    {intent.kind === "submit" ? marketIdentity(intent.input).id : intent.id}
                  </AgreementFact>
                </dl>
                {intent.kind === "submit" ? (
                  <>
                    {intent.input.operation === "publish-demand" ? (
                      <p>
                        {intent.input.demand.title} · {intent.input.demand.platform} /{" "}
                        {intent.input.demand.architecture}
                      </p>
                    ) : null}
                    <details>
                      <summary className="cursor-pointer">
                        {t("federation.market.original")}
                      </summary>
                      <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all">
                        {JSON.stringify(intent.input, null, 2)}
                      </pre>
                    </details>
                  </>
                ) : null}
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(false)}>
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={
                busy ||
                !intent ||
                !enabled ||
                !allowed.current.includes(
                  intent.kind === "submit" ? marketCapability(intent.input) : "market.read",
                )
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

const MarketOperationsTime = z.iso.datetime();

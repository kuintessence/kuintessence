import {
  type CommercialAgreementApproval,
  type ReservationPolicy,
  ReservationPolicyInputSchema,
  ReservationPolicySchema,
  type TerminalPolicy,
  TerminalPolicyInputSchema,
  TerminalPolicySchema,
} from "@kuintessence/shared/federation/commercial";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
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
import { Input } from "../ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

type Kind = "reservation" | "terminal";
type Policy = ReservationPolicy | TerminalPolicy;
type Grant =
  | { action: "grant"; kind: "reservation"; input: z.infer<typeof ReservationPolicyInputSchema> }
  | { action: "grant"; kind: "terminal"; input: z.infer<typeof TerminalPolicyInputSchema> };
type Action = Grant | { action: "revoke"; kind: Kind; policy: Policy };
type Props = {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  grants: readonly string[];
  writable: boolean;
  busy: boolean;
};
const flags = [
  "allowMarketPublish",
  "allowMarketClaim",
  "allowActivation",
  "allowExecutionConfirmation",
] as const;
const outcomes = ["completed", "failed", "cancelled"] as const;

export function CommercialAutomationPanel(props: Props) {
  return (
    <AutomationPanel
      key={`${props.scope.organizationId}:${props.scope.authRevision}:${props.approval.revisionId}`}
      {...props}
    />
  );
}

function AutomationPanel({ approval, scope, grants, writable, busy }: Props) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const id = useId();
  const refreshFocus = useRef<HTMLButtonElement>(null);
  const [kind, setKind] = useState<Kind>("reservation");
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(false);
  const [intent, setIntent] = useState<Action | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [input, setInput] = useState({
    maxTaskAmount: "",
    maxTotalAmount: "",
    maxTasks: "1",
    validUntil: "",
    allowMarketPublish: false,
    allowMarketClaim: false,
    allowActivation: false,
    allowExecutionConfirmation: false,
    outcomes: ["completed"] as (typeof outcomes)[number][],
  });
  const terms = approval.terms.agreement;
  const enabled = terms.mode === "ledger_coordinated" && !!approval.counterpartyJws;
  const canUse = (flag: (typeof flags)[number]) =>
    flag === "allowMarketClaim"
      ? approval.localSiteId === terms.targetSiteId && grants.includes("market.claim")
      : flag === "allowActivation" || flag === "allowMarketPublish"
        ? approval.localSiteId === terms.sourceSiteId && grants.includes("market.publish")
        : true;
  const allowed = useRef(false);
  allowed.current = enabled && writable && !busy;
  useEffect(() => {
    if (!writable) {
      setEditing(false);
      setIntent(null);
    }
  }, [writable]);
  const base = `/federation/commercial-agreements/${approval.revisionId}`;
  const key = ["federation", "commercial", scope.organizationId, scope.authRevision];
  const check = (row: Policy) => {
    if (
      row.localOrgId !== scope.organizationId ||
      row.localSiteId !== approval.localSiteId ||
      row.agreementRevisionId !== approval.revisionId ||
      row.agreementDigest !== approval.digest ||
      ("maxTasks" in row &&
        (BigInt(row.maxTaskAmount) > BigInt(terms.maxTaskAmount) ||
          BigInt(row.maxTotalAmount) > BigInt(terms.budgetLimit)))
    )
      throw new Error("Automation policy scope mismatch");
    return row;
  };
  const policies = useQuery({
    queryKey: [...key, "automation", approval.revisionId, kind, page],
    enabled,
    refetchOnWindowFocus: false,
    queryFn: async () =>
      z
        .array(kind === "reservation" ? ReservationPolicySchema : TerminalPolicySchema)
        .max(20)
        .parse(
          (
            await api.get<{ data: unknown }>(
              `${base}/${kind}-policies?limit=20&offset=${page * 20}`,
              scope,
            )
          ).data,
        )
        .map(check),
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: Action) => {
      if (!allowed.current || (action.action === "grant" && uncertain))
        throw new Error("Automation authority unavailable");
      if (
        action.action === "grant" &&
        action.kind === "reservation" &&
        flags.some((flag) => action.input[flag] && !canUse(flag))
      )
        throw new Error("Market signing authority unavailable");
      const raw = (
        await api.post<{ data: unknown }>(
          `${base}/${action.kind}-policies${action.action === "revoke" ? `/${action.policy.id}/revoke` : ""}`,
          action.action === "grant" ? action.input : {},
          scope,
        )
      ).data;
      const row = check(
        action.kind === "reservation"
          ? ReservationPolicySchema.parse(raw)
          : TerminalPolicySchema.parse(raw),
      );
      if (action.action === "revoke") {
        if (row.id !== action.policy.id || row.revokedAt === null)
          throw new Error("Policy revocation mismatch");
      } else {
        if (
          row.revokedAt !== null ||
          Date.parse(row.validUntil) !== Date.parse(action.input.validUntil)
        )
          throw new Error("Policy validity mismatch");
        if (action.kind === "reservation") {
          if (
            !("maxTasks" in row) ||
            row.maxTasks !== action.input.maxTasks ||
            row.maxTaskAmount !== action.input.maxTaskAmount ||
            row.maxTotalAmount !== action.input.maxTotalAmount ||
            flags.some((flag) => row[flag] !== action.input[flag])
          )
            throw new Error("Policy limits mismatch");
        } else if (
          !("outcomes" in row) ||
          JSON.stringify(row.outcomes) !== JSON.stringify(action.input.outcomes)
        )
          throw new Error("Policy outcomes mismatch");
      }
    },
    onSuccess: async () => {
      setIntent(null);
      setEditing(false);
      setPage(0);
      await client.invalidateQueries({ queryKey: key });
    },
    onError: (_, action) => {
      // Grants use server-generated IDs: read the persisted outcome before another grant.
      if (action.action === "grant") {
        setUncertain(true);
        setIntent(null);
        setEditing(false);
      }
    },
  });
  const blocked = busy || mutation.isPending || policies.isPending || policies.isError;
  const time = (value: string) => new Date(value).toLocaleString(i18n.language);
  const review = (action: Action) => {
    if (!allowed.current) return;
    mutation.reset();
    setIntent(action);
  };
  const refresh = async () => {
    const result = await policies.refetch();
    if (!result.isError) {
      setUncertain(false);
      mutation.reset();
    }
  };
  const status = (row: Policy) =>
    row.revokedAt
      ? "revoked"
      : Date.parse(row.validUntil) <= Date.now()
        ? "expired"
        : Date.parse(row.validFrom) > Date.now()
          ? "scheduled"
          : "maxTasks" in row &&
              (row.authorizedTasks >= row.maxTasks ||
                (row.marketAuthorizedTasks ?? 0) >= row.maxTasks ||
                (row.maxTotalAmount !== "0" &&
                  (BigInt(row.authorizedAmount) >= BigInt(row.maxTotalAmount) ||
                    BigInt(row.marketAuthorizedAmount ?? "0") >= BigInt(row.maxTotalAmount))))
            ? "exhausted"
            : "active";
  const facts = (row: Policy | Grant["input"]) => (
    <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
      {"maxTasks" in row ? (
        <>
          {(["maxTaskAmount", "maxTotalAmount", "maxTasks"] as const).map((field) => (
            <div key={field}>
              <dt className="text-muted-foreground">{t(`federation.automation.${field}`)}</dt>
              <dd className="mt-1 break-all tabular-nums">
                {row[field]}
                {field !== "maxTasks" ? ` ${terms.unit}` : ""}
              </dd>
            </div>
          ))}
          <div>
            <dt className="text-muted-foreground">{t("federation.automation.permissions")}</dt>
            <dd className="mt-1">
              {flags
                .filter((flag) => row[flag])
                .map((flag) => t(`federation.automation.${flag}`))
                .join(" · ") || t("federation.automation.noAutomaticSteps")}
            </dd>
          </div>
        </>
      ) : (
        <div>
          <dt className="text-muted-foreground">{t("federation.closing.outcomes")}</dt>
          <dd className="mt-1">
            {row.outcomes.map((value) => t(`federation.closing.outcome.${value}`)).join(" · ")}
          </dd>
        </div>
      )}
      <div>
        <dt className="text-muted-foreground">{t("federation.validUntil")}</dt>
        <dd className="mt-1">{time(row.validUntil)}</dd>
      </div>
    </dl>
  );
  if (!enabled) return <p role="status">{t("federation.automation.unavailable")}</p>;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">{t("federation.automation.title")}</h3>
        <div className="flex gap-2">
          <Button
            ref={refreshFocus}
            variant="outline"
            disabled={busy || mutation.isPending || policies.isFetching}
            onClick={() => void refresh()}
          >
            {t("federation.refresh")}
          </Button>
          {writable && !editing ? (
            <Button
              disabled={
                blocked ||
                uncertain ||
                policies.isFetching ||
                page !== 0 ||
                Date.parse(terms.validUntil) <= Date.now() ||
                policies.data?.some((row) => !row.revokedAt)
              }
              onClick={() => {
                setEditing(true);
                setInvalid(false);
                mutation.reset();
              }}
            >
              {t("federation.automation.grant")}
            </Button>
          ) : null}
        </div>
      </div>
      <Tabs
        value={kind}
        onValueChange={(value) => {
          setKind(value as Kind);
          setPage(0);
          setEditing(false);
          setInvalid(false);
        }}
      >
        <TabsList aria-label={t("federation.automation.title")}>
          <TabsTrigger
            value="reservation"
            disabled={mutation.isPending || !!intent || editing || uncertain}
          >
            {t("federation.automation.reservation")}
          </TabsTrigger>
          <TabsTrigger
            value="terminal"
            disabled={mutation.isPending || !!intent || editing || uncertain}
          >
            {t("federation.automation.terminal")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value={kind} className="space-y-5">
          {uncertain ? (
            <p role="alert" className="text-sm text-status-failed">
              {t("federation.automation.uncertain")}
            </p>
          ) : null}
          {editing && writable ? (
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                const date = new Date(input.validUntil);
                if (
                  !Number.isFinite(date.getTime()) ||
                  date.getTime() <= Date.now() ||
                  date.getTime() > Date.parse(terms.validUntil)
                ) {
                  setInvalid(true);
                  return;
                }
                if (kind === "reservation") {
                  const parsed = ReservationPolicyInputSchema.safeParse({
                    ...Object.fromEntries(flags.map((flag) => [flag, input[flag] && canUse(flag)])),
                    maxTaskAmount: input.maxTaskAmount,
                    maxTotalAmount: input.maxTotalAmount,
                    maxTasks: Number(input.maxTasks),
                    validUntil: date.toISOString(),
                  });
                  if (
                    !parsed.success ||
                    BigInt(parsed.data.maxTaskAmount) > BigInt(terms.maxTaskAmount) ||
                    BigInt(parsed.data.maxTotalAmount) > BigInt(terms.budgetLimit)
                  ) {
                    setInvalid(true);
                    return;
                  }
                  review({ action: "grant", kind, input: parsed.data });
                } else {
                  const parsed = TerminalPolicyInputSchema.safeParse({
                    outcomes: input.outcomes,
                    validUntil: date.toISOString(),
                  });
                  if (!parsed.success) {
                    setInvalid(true);
                    return;
                  }
                  review({ action: "grant", kind, input: parsed.data });
                }
                setInvalid(false);
              }}
            >
              <fieldset disabled={blocked || policies.isFetching} className="space-y-5">
                <legend className="sr-only">{t("federation.automation.grant")}</legend>
                {kind === "reservation" ? (
                  <>
                    <div className="grid gap-4 sm:grid-cols-3">
                      {(["maxTaskAmount", "maxTotalAmount", "maxTasks"] as const).map((field) => (
                        <label key={field} htmlFor={`${id}-${field}`} className="space-y-2 text-sm">
                          <span>{t(`federation.automation.${field}`)}</span>
                          <Input
                            id={`${id}-${field}`}
                            inputMode="numeric"
                            value={input[field]}
                            onChange={(event) =>
                              setInput({ ...input, [field]: event.target.value })
                            }
                            maxLength={38}
                            required
                          />
                        </label>
                      ))}
                    </div>
                    <fieldset className="space-y-3">
                      <legend className="mb-3 text-sm font-medium">
                        {t("federation.automation.permissions")}
                      </legend>
                      {flags.filter(canUse).map((flag) => (
                        <label key={flag} className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={input[flag]}
                            onChange={(event) =>
                              setInput({ ...input, [flag]: event.target.checked })
                            }
                          />
                          <span>{t(`federation.automation.${flag}`)}</span>
                        </label>
                      ))}
                    </fieldset>
                  </>
                ) : (
                  <fieldset className="space-y-3">
                    <legend className="mb-3 text-sm font-medium">
                      {t("federation.closing.outcomes")}
                    </legend>
                    {outcomes.map((value) => (
                      <label key={value} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={input.outcomes.includes(value)}
                          onChange={(event) =>
                            setInput({
                              ...input,
                              outcomes: event.target.checked
                                ? [...input.outcomes, value]
                                : input.outcomes.filter((item) => item !== value),
                            })
                          }
                        />
                        <span>{t(`federation.closing.outcome.${value}`)}</span>
                      </label>
                    ))}
                  </fieldset>
                )}
                <label htmlFor={`${id}-expiry`} className="block max-w-sm space-y-2 text-sm">
                  <span>{t("federation.validUntil")}</span>
                  <Input
                    id={`${id}-expiry`}
                    type="datetime-local"
                    required
                    value={input.validUntil}
                    onChange={(event) => setInput({ ...input, validUntil: event.target.value })}
                  />
                </label>
                {invalid ? (
                  <p role="alert" className="text-sm text-status-failed">
                    {t("federation.automation.invalid")}
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <Button type="submit">{t("federation.automation.review")}</Button>
                  <Button variant="outline" type="button" onClick={() => setEditing(false)}>
                    {t("federation.cancel")}
                  </Button>
                </div>
              </fieldset>
            </form>
          ) : uncertain ? null : policies.isError ? (
            <p role="alert">{t("federation.loadFailed")}</p>
          ) : policies.isPending ? (
            <p role="status">{t("federation.loading")}</p>
          ) : policies.data.length ? (
            <ul className="divide-y divide-border">
              {policies.data.map((row) => (
                <li key={row.id} className="space-y-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">
                      {t(`federation.automation.state.${status(row)}`)}
                    </p>
                    {writable && !row.revokedAt ? (
                      <Button
                        variant="outline"
                        disabled={blocked || policies.isFetching || uncertain}
                        onClick={() => review({ action: "revoke", kind, policy: row })}
                      >
                        {t("federation.automation.revoke")}
                      </Button>
                    ) : null}
                  </div>
                  {facts(row)}
                  {"authorizedTasks" in row ? (
                    <div className="grid gap-4 text-sm sm:grid-cols-2">
                      <p>
                        {t("federation.automation.executionUsed", {
                          count: row.authorizedTasks,
                          amount: row.authorizedAmount,
                          unit: terms.unit,
                        })}
                      </p>
                      <p>
                        {row.marketAuthorizedTasks === undefined ||
                        row.marketAuthorizedAmount === undefined
                          ? t("federation.automation.marketMissing")
                          : t("federation.automation.marketUsed", {
                              count: row.marketAuthorizedTasks,
                              amount: row.marketAuthorizedAmount,
                              unit: terms.unit,
                            })}
                      </p>
                    </div>
                  ) : null}
                  <details className="text-sm">
                    <summary className="cursor-pointer">
                      {t("federation.automation.details")}
                    </summary>
                    <dl className="mt-3 space-y-3">
                      {(["id", "grantedBy", "validFrom", "revokedAt", "revokedBy"] as const).map(
                        (field) => (
                          <div key={field}>
                            <dt className="text-muted-foreground">
                              {t(`federation.automation.${field}`)}
                            </dt>
                            <dd className="mt-1 break-all">
                              {row[field]
                                ? field === "validFrom" || field === "revokedAt"
                                  ? time(row[field])
                                  : row[field]
                                : "—"}
                            </dd>
                          </div>
                        ),
                      )}
                    </dl>
                  </details>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {t("federation.automation.empty")}
            </p>
          )}
          {!editing &&
          !uncertain &&
          !policies.isError &&
          (page > 0 || policies.data?.length === 20) ? (
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                disabled={
                  page === 0 || busy || policies.isFetching || mutation.isPending || uncertain
                }
                onClick={() => setPage(page - 1)}
              >
                {t("federation.previous")}
              </Button>
              <span className="text-sm tabular-nums">{page + 1}</span>
              <Button
                variant="outline"
                disabled={
                  policies.data?.length !== 20 ||
                  busy ||
                  policies.isFetching ||
                  mutation.isPending ||
                  uncertain
                }
                onClick={() => setPage(page + 1)}
              >
                {t("federation.next")}
              </Button>
            </div>
          ) : null}
        </TabsContent>
      </Tabs>
      <Dialog
        open={!!intent && writable}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setIntent(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            refreshFocus.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t(
                intent?.action === "revoke"
                  ? "federation.automation.revoke"
                  : "federation.automation.grant",
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                intent?.action === "revoke"
                  ? "federation.automation.revokeEffect"
                  : "federation.automation.grantEffect",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {intent ? facts(intent.action === "grant" ? intent.input : intent.policy) : null}
            {mutation.isError ? (
              <p role="alert" className="mt-4 text-sm text-status-failed">
                {t("federation.saveFailed")}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={mutation.isPending} onClick={() => setIntent(null)}>
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={busy || mutation.isPending || !writable}
              onClick={() => {
                if (intent) mutation.mutate(intent);
              }}
            >
              {t("federation.automation.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

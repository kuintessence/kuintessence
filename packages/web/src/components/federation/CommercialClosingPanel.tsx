import {
  type ClosingPolicy,
  type ClosingPolicyInput,
  ClosingPolicyInputSchema,
  ClosingPolicySchema,
  ClosingTasksViewSchema,
  type CommercialAgreementApproval,
} from "@kuintessence/shared/federation/commercial";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
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

type Kind = ClosingPolicyInput["kind"];
type Intent =
  | { action: "grant"; kind: Kind; input: ClosingPolicyInput }
  | { action: "revoke"; kind: Kind; policy: ClosingPolicy }
  | { action: "retry"; kind: Kind; referenceId: string };
type Props = {
  approval: CommercialAgreementApproval;
  scope: ApiOrganizationScope;
  canBill: boolean;
  canSettle: boolean;
  busy: boolean;
  onOpenRecord: (kind: Kind, recordId: string) => void;
};

export function CommercialClosingPanel(props: Props) {
  return (
    <ClosingPanel
      key={`${props.scope.organizationId}:${props.scope.authRevision}:${props.approval.revisionId}`}
      {...props}
    />
  );
}

function ClosingPanel({ approval, scope, canBill, canSettle, busy, onOpenRecord }: Props) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const id = useId();
  const base = `/federation/commercial-agreements/${approval.revisionId}`;
  const key = ["federation", "commercial", scope.organizationId, scope.authRevision];
  const provider = approval.localSiteId === approval.terms.agreement.targetSiteId;
  const allowed = (kind: Kind) => (kind === "bill" ? canBill : canSettle);
  const [policyPage, setPolicyPage] = useState(0);
  const [taskPage, setTaskPage] = useState(0);
  const [editing, setEditing] = useState<Kind | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [input, setInput] = useState({
    maxAmount: "",
    maxTotalAmount: "",
    maxRecords: "1",
    validUntil: "",
    outcomes: ["completed"] as ClosingPolicyInput["outcomes"],
  });
  useEffect(() => {
    if (editing && !(editing === "bill" ? canBill : canSettle)) setEditing(null);
    if (intent && !(intent.kind === "bill" ? canBill : canSettle)) setIntent(null);
  }, [canBill, canSettle, editing, intent]);
  const checkScope = (row: {
    localSiteId: string;
    localOrgId: string;
    agreementRevisionId: string;
  }) => {
    if (
      row.localOrgId !== scope.organizationId ||
      row.localSiteId !== approval.localSiteId ||
      row.agreementRevisionId !== approval.revisionId
    )
      throw new Error("Closing scope mismatch");
  };
  const checkPolicy = (row: ClosingPolicy) => {
    checkScope(row);
    if (
      row.agreementDigest !== approval.digest ||
      BigInt(row.maxAmount) > BigInt(approval.terms.agreement.maxTaskAmount) ||
      BigInt(row.maxTotalAmount) > BigInt(approval.terms.agreement.budgetLimit)
    )
      throw new Error("Closing policy contract mismatch");
    return row;
  };
  const policies = useQuery({
    queryKey: [...key, "closing-policies", approval.revisionId, policyPage],
    enabled: !!approval.counterpartyJws,
    queryFn: async () =>
      z
        .array(ClosingPolicySchema)
        .max(20)
        .parse(
          (
            await api.get<{ data: unknown }>(
              `${base}/closing-policies?limit=20&offset=${policyPage * 20}`,
              scope,
            )
          ).data,
        )
        .map(checkPolicy),
    refetchInterval: editing || intent || uncertain ? false : 10000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
  });
  const tasks = useQuery({
    queryKey: [...key, "closing-tasks", approval.revisionId, taskPage],
    enabled: !!approval.counterpartyJws && provider,
    queryFn: async () => {
      const value = ClosingTasksViewSchema.parse(
        (
          await api.get<{ data: unknown }>(
            `${base}/closing-tasks?limit=20&offset=${taskPage * 20}`,
            scope,
          )
        ).data,
      );
      value.records.forEach(checkScope);
      return value;
    },
    refetchInterval: intent ? false : 10000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: Intent) => {
      if (busy || !allowed(action.kind) || (action.action === "grant" && uncertain))
        throw new Error("Closing authority unavailable");
      if (action.action === "retry") {
        await api.post(
          `${base}/closing-tasks/${action.kind}/${action.referenceId}/retry`,
          {},
          scope,
        );
        return;
      }
      const row = checkPolicy(
        ClosingPolicySchema.parse(
          (
            await api.post<{ data: unknown }>(
              action.action === "grant"
                ? `${base}/closing-policies`
                : `${base}/closing-policies/${action.policy.id}/revoke`,
              action.action === "grant" ? action.input : {},
              scope,
            )
          ).data,
        ),
      );
      if (row.kind !== action.kind) throw new Error("Policy kind mismatch");
      if (action.action === "grant") {
        for (const field of ["maxAmount", "maxTotalAmount", "maxRecords"] as const)
          if (row[field] !== action.input[field]) throw new Error("Policy limit mismatch");
        if (
          JSON.stringify(row.outcomes) !== JSON.stringify(action.input.outcomes) ||
          Date.parse(row.validUntil) !== Date.parse(action.input.validUntil) ||
          row.revokedAt !== null
        )
          throw new Error("Policy authority mismatch");
      } else if (row.id !== action.policy.id || row.revokedAt === null)
        throw new Error("Policy revocation mismatch");
    },
    onSuccess: async () => {
      setIntent(null);
      setEditing(null);
      await client.invalidateQueries({ queryKey: key });
    },
    onError: (_, action) => {
      // A grant has a server-generated ID; read its outcome before allowing a new grant.
      if (action.action === "grant") {
        setUncertain(true);
        setIntent(null);
        setEditing(null);
      }
    },
  });
  const blocked = busy || mutation.isPending || policies.isError || policies.isPending;
  const review = (value: Intent) => {
    mutation.reset();
    setIntent(value);
  };
  const refresh = async () => {
    const result = await policies.refetch();
    if (!result.isError) {
      setUncertain(false);
      mutation.reset();
    }
    if (provider) await tasks.refetch();
  };
  const status = (policy: ClosingPolicy) =>
    policy.revokedAt
      ? "revoked"
      : Date.parse(policy.validUntil) <= Date.now()
        ? "expired"
        : policy.approvedRecords >= policy.maxRecords
          ? "exhausted"
          : "active";
  const time = (value: string) => new Date(value).toLocaleString(i18n.language);
  const limits = (policy: ClosingPolicyInput) => (
    <dl className="grid gap-4 text-sm sm:grid-cols-2">
      {(["maxAmount", "maxTotalAmount", "maxRecords", "validUntil"] as const).map((field) => (
        <div key={field} className="min-w-0">
          <dt className="text-muted-foreground">{t(`federation.closing.${field}`)}</dt>
          <dd className="mt-1 break-all tabular-nums">
            {field === "validUntil" ? time(policy[field]) : policy[field]}
          </dd>
        </div>
      ))}
      <div>
        <dt className="text-muted-foreground">{t("federation.closing.outcomes")}</dt>
        <dd className="mt-1">
          {policy.outcomes.map((o) => t(`federation.closing.outcome.${o}`)).join(" · ")}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t("federation.settlement.unit")}</dt>
        <dd className="mt-1 break-all">{approval.terms.agreement.unit}</dd>
      </div>
    </dl>
  );
  const pages = (
    page: number,
    length: number,
    fetching: boolean,
    setPage: (page: number) => void,
  ) =>
    page > 0 || length === 20 ? (
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={page === 0 || fetching || blocked}
          onClick={() => setPage(page - 1)}
        >
          {t("federation.previous")}
        </Button>
        <Button
          variant="outline"
          disabled={length < 20 || fetching || blocked}
          onClick={() => setPage(page + 1)}
        >
          {t("federation.next")}
        </Button>
      </div>
    ) : null;
  if (!approval.counterpartyJws)
    return (
      <p className="text-sm text-muted-foreground">
        {t("federation.agreements.awaitingSignature")}
      </p>
    );
  return (
    <div className="space-y-6">
      <section className="space-y-4" aria-label={t("federation.closing.policies")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold">{t("federation.closing.policies")}</h3>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={blocked || policies.isFetching || tasks.isFetching}
              onClick={() => void refresh()}
            >
              {t("federation.refresh")}
            </Button>
            {(["bill", "settlement"] as const).filter(allowed).map((kind) => (
              <Button
                key={kind}
                variant="outline"
                disabled={
                  blocked ||
                  uncertain ||
                  policies.isPending ||
                  policies.isError ||
                  policies.isFetching ||
                  !!editing ||
                  policies.data?.some((p) => p.kind === kind && p.revokedAt === null)
                }
                onClick={() => {
                  setPolicyPage(0);
                  setEditing(kind);
                  setInvalid(false);
                  mutation.reset();
                  setInput({
                    maxAmount: "",
                    maxTotalAmount: "",
                    maxRecords: "1",
                    validUntil: "",
                    outcomes: ["completed"],
                  });
                }}
              >
                {t(`federation.closing.grant.${kind}`)}
              </Button>
            ))}
          </div>
        </div>
        {uncertain ? (
          <p role="alert" className="text-sm text-status-failed">
            {t("federation.closing.unknownGrant")}
          </p>
        ) : null}
        {editing && allowed(editing) ? (
          <form
            className="space-y-4 border-y border-border py-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (blocked || uncertain) return;
              const date = new Date(input.validUntil);
              const parsed = ClosingPolicyInputSchema.safeParse({
                ...input,
                kind: editing,
                maxRecords: Number(input.maxRecords),
                validUntil: Number.isFinite(date.getTime()) ? date.toISOString() : "",
              });
              if (
                !parsed.success ||
                date.getTime() <= Date.now() ||
                BigInt(parsed.data.maxAmount) > BigInt(approval.terms.agreement.maxTaskAmount) ||
                BigInt(parsed.data.maxTotalAmount) > BigInt(approval.terms.agreement.budgetLimit)
              ) {
                setInvalid(true);
                return;
              }
              setInvalid(false);
              review({ action: "grant", kind: editing, input: parsed.data });
            }}
          >
            <h4 className="font-medium">{t(`federation.closing.grant.${editing}`)}</h4>
            <p className="text-sm text-muted-foreground">
              {t("federation.closing.contractLimits", {
                unit: approval.terms.agreement.unit,
                task: approval.terms.agreement.maxTaskAmount,
                total: approval.terms.agreement.budgetLimit,
              })}
            </p>
            <fieldset disabled={blocked} className="grid gap-4 sm:grid-cols-2">
              {(["maxAmount", "maxTotalAmount", "maxRecords", "validUntil"] as const).map(
                (field) => (
                  <div key={field} className="min-w-0 space-y-2">
                    <label htmlFor={`${id}-${field}`} className="text-sm font-medium">
                      {t(`federation.closing.${field}`)}
                    </label>
                    <Input
                      id={`${id}-${field}`}
                      type={field === "validUntil" ? "datetime-local" : "text"}
                      inputMode={field === "validUntil" ? undefined : "numeric"}
                      required
                      maxLength={
                        field === "maxRecords" ? 6 : field === "validUntil" ? undefined : 38
                      }
                      value={input[field]}
                      onChange={(event) => setInput({ ...input, [field]: event.target.value })}
                    />
                  </div>
                ),
              )}
            </fieldset>
            <fieldset disabled={blocked} className="flex flex-wrap gap-4">
              <legend className="mb-2 text-sm font-medium">
                {t("federation.closing.outcomes")}
              </legend>
              {(["completed", "failed", "cancelled"] as const).map((outcome) => (
                <label key={outcome} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={input.outcomes.includes(outcome)}
                    onChange={(event) =>
                      setInput({
                        ...input,
                        outcomes: event.target.checked
                          ? [...input.outcomes, outcome]
                          : input.outcomes.filter((o) => o !== outcome),
                      })
                    }
                  />
                  {t(`federation.closing.outcome.${outcome}`)}
                </label>
              ))}
            </fieldset>
            {invalid ? (
              <p role="alert" className="text-sm text-status-failed">
                {t("federation.closing.invalid")}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={blocked}
                onClick={() => setEditing(null)}
              >
                {t("federation.cancel")}
              </Button>
              <Button type="submit" disabled={blocked}>
                {t("federation.closing.review")}
              </Button>
            </div>
          </form>
        ) : null}
        {policies.isError ? (
          <p role="alert">{t("federation.loadFailed")}</p>
        ) : policies.isPending ? (
          <p role="status">{t("federation.loading")}</p>
        ) : policies.data.length ? (
          <ul className="divide-y divide-border">
            {policies.data.map((policy) => (
              <li key={policy.id} className="space-y-3 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <h4 className="font-medium">{t(`federation.closing.kind.${policy.kind}`)}</h4>
                    <span className="text-sm text-muted-foreground">
                      {t(`federation.closing.policyState.${status(policy)}`)}
                    </span>
                  </div>
                  {allowed(policy.kind) && !policy.revokedAt ? (
                    <Button
                      variant="outline"
                      disabled={blocked || uncertain}
                      onClick={() => review({ action: "revoke", kind: policy.kind, policy })}
                    >
                      {t("federation.closing.revoke")}
                    </Button>
                  ) : null}
                </div>
                {limits(policy)}
                <dl className="grid gap-4 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">
                      {t("federation.closing.approvedAmount")}
                    </dt>
                    <dd className="mt-1 break-all tabular-nums">
                      {policy.approvedAmount} / {policy.maxTotalAmount}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {t("federation.closing.approvedRecords")}
                    </dt>
                    <dd className="mt-1 tabular-nums">
                      {policy.approvedRecords} / {policy.maxRecords}
                    </dd>
                  </div>
                </dl>
                {policy.revokedAt ? (
                  <p className="text-sm text-muted-foreground">
                    {t("federation.closing.revokedAt", { time: time(policy.revokedAt) })}
                  </p>
                ) : null}
                <details className="text-sm">
                  <summary className="cursor-pointer">{t("federation.closing.reference")}</summary>
                  <code className="mt-2 block break-all text-xs">{policy.id}</code>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">{t("federation.closing.noPolicies")}</p>
        )}
        {!policies.isError && policies.data
          ? pages(policyPage, policies.data.length, policies.isFetching, setPolicyPage)
          : null}
      </section>
      <section
        className="space-y-4 border-t border-border pt-5"
        aria-label={t("federation.closing.tasks")}
      >
        <h3 className="text-base font-semibold">{t("federation.closing.tasks")}</h3>
        {!provider ? (
          <p className="text-sm text-muted-foreground">{t("federation.closing.sourceTasks")}</p>
        ) : tasks.isError ? (
          <p role="alert">{t("federation.loadFailed")}</p>
        ) : tasks.isPending ? (
          <p role="status">{t("federation.loading")}</p>
        ) : (
          <>
            {!tasks.data.enabled ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t("federation.closing.transportOff")}
              </p>
            ) : null}
            {tasks.data.records.length ? (
              <ul className="divide-y divide-border">
                {tasks.data.records.map((task) => (
                  <li key={`${task.kind}:${task.referenceId}`} className="space-y-2 py-4 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="font-medium">
                        {t(`federation.closing.kind.${task.kind}`)} ·{" "}
                        {t(`federation.closing.taskState.${task.state}`)}
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {task.recordId ? (
                          <Button
                            variant="outline"
                            disabled={blocked}
                            onClick={() => task.recordId && onOpenRecord(task.kind, task.recordId)}
                          >
                            {t(`federation.closing.open.${task.kind}`)}
                          </Button>
                        ) : null}
                        {allowed(task.kind) && task.state === "needs_review" ? (
                          <Button
                            variant="outline"
                            disabled={blocked || !tasks.data.enabled}
                            onClick={() =>
                              review({
                                action: "retry",
                                kind: task.kind,
                                referenceId: task.referenceId,
                              })
                            }
                          >
                            {t("federation.closing.retry")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <p className="break-all text-muted-foreground">
                      {t(
                        task.kind === "bill"
                          ? "federation.billing.reservationId"
                          : "federation.billing.billId",
                      )}
                      : {task.referenceId}
                    </p>
                    {task.lastError ? (
                      <p className="text-status-failed">
                        {t(`federation.closing.errors.${task.lastError}`, {
                          defaultValue: t("federation.commercial.checkConfiguration"),
                        })}{" "}
                        <code className="break-all text-xs">{task.lastError}</code>
                      </p>
                    ) : null}
                    <p className="text-muted-foreground">
                      {task.completedAt
                        ? t("federation.closing.completedAt", { time: time(task.completedAt) })
                        : task.state === "pending"
                          ? t("federation.closing.nextAttempt", { time: time(task.nextAttemptAt) })
                          : null}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-4 text-sm text-muted-foreground">
                {t("federation.closing.noTasks")}
              </p>
            )}
            {pages(taskPage, tasks.data.records.length, tasks.isFetching, setTaskPage)}
          </>
        )}
      </section>
      <Dialog
        open={!!intent && allowed(intent.kind)}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) {
            setIntent(null);
            mutation.reset();
          }
        }}
      >
        <DialogContent
          dismissible={!mutation.isPending}
          outsideDismissPolicy="never"
          className="sm:max-w-xl"
        >
          <DialogHeader>
            <DialogTitle>
              {intent?.action === "grant"
                ? t(`federation.closing.grant.${intent.kind}`)
                : t(`federation.closing.${intent?.action ?? "review"}`)}
            </DialogTitle>
            <DialogDescription>
              {t(`federation.closing.effect.${intent?.action ?? "grant"}`)}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {intent?.action === "grant" ? (
              limits(intent.input)
            ) : intent?.action === "revoke" ? (
              limits(intent.policy)
            ) : (
              <p className="break-all text-sm">{intent?.referenceId}</p>
            )}
            {mutation.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {t("federation.closing.actionFailed")}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => {
                setIntent(null);
                mutation.reset();
              }}
            >
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={
                blocked ||
                !intent ||
                !allowed(intent.kind) ||
                (intent.action === "grant" && uncertain)
              }
              onClick={() => intent && mutation.mutate(intent)}
            >
              {t(mutation.isPending ? "federation.saving" : "federation.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

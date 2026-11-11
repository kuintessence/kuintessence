import { federationCanonicalJson } from "@kuintessence/shared/federation";
import { ArbitrationReviewSchema } from "@kuintessence/shared/federation/arbitration-context";
import {
  ArbitrationDecisionInputSchema,
  ArbitrationDecisionIntentSchema,
} from "@kuintessence/shared/federation/arbitration-decision";
import {
  CaseArbitrationDecisionSchema,
  CaseReceiptSchema,
} from "@kuintessence/shared/federation/case-ledger";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { checkCaseBinding, DecisionViewSchema, type EvidenceCase } from "./evidence-case-view";

const LedgerViewSchema = z.object({
  payload: CaseArbitrationDecisionSchema,
  digest: z.string(),
  approvedAt: z.iso.datetime(),
});
const DeliverySchema = z.object({
  enabled: z.boolean(),
  data: z
    .object({
      receivingSiteId: z.uuid(),
      deliveryId: z.uuid(),
      state: z.enum(["pending", "received", "needs_review"]),
      lastError: z.string().nullable(),
      acknowledgedAt: z.iso.datetime().nullable(),
    })
    .array()
    .max(2),
});
const LedgerStatusSchema = z.object({
  enabled: z.boolean(),
  data: z
    .object({
      id: z.uuid(),
      state: z.enum(["pending", "committed", "needs_review"]),
      lastError: z.string().nullable(),
      receipt: CaseReceiptSchema.nullable(),
      nextAttemptAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
});
type Action =
  | { kind: "decision"; payload: z.infer<typeof ArbitrationDecisionIntentSchema> }
  | { kind: "ledger"; payload: z.infer<typeof CaseArbitrationDecisionSchema> }
  | { kind: "delivery"; siteId: string }
  | { kind: "retry" };
export function ArbitrationDecisionPanel({
  row,
  scope,
  grants,
  grantIds,
  readOnly,
  busy,
}: {
  row: EvidenceCase;
  scope: ApiOrganizationScope;
  grants: readonly string[];
  grantIds: string[];
  readOnly: boolean;
  busy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const base = `/federation/evidence-cases/${row.caseId}`;
  const key = ["federation", "arbitration", scope.organizationId, scope.authRevision, row.caseId];
  const [review, setReview] = useState<z.infer<typeof ArbitrationReviewSchema> | null>(null);
  const [outcome, setOutcome] = useState("resolve-without-financial-change");
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("0");
  const [reason, setReason] = useState("");
  const [domainId, setDomainId] = useState("");
  const [intent, setIntent] = useState<Action | null>(null);
  const [unknown, setUnknown] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const authority = useRef({ decide: false, publish: false });
  authority.current = {
    decide:
      !readOnly &&
      !busy &&
      !row.closedAt &&
      grants.includes("arbitration.decide") &&
      grants.includes("disclosure.receive"),
    publish: !readOnly && !busy && grants.includes("case.publish"),
  };
  const assertAllowed = (kind: Action["kind"]) => {
    if (
      !active.current ||
      !(kind === "decision" || kind === "delivery"
        ? authority.current.decide
        : authority.current.publish)
    )
      throw new Error("Arbitration signing authority unavailable");
  };
  const checkDecision = (raw: unknown) => {
    const result = DecisionViewSchema.parse(raw);
    checkCaseBinding(result.payload.intent.binding, row);
    return result;
  };
  const decision = useQuery({
    queryKey: [...key, "decision"],
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const raw = (await api.get<{ data: unknown }>(`${base}/arbitration-decision`, scope)).data;
      return raw === null ? null : checkDecision(raw);
    },
  });
  const ledger = useQuery({
    queryKey: [...key, "ledger"],
    enabled: !!decision.data,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const raw = (await api.get<{ data: unknown }>(`${base}/arbitration-decision/ledger`, scope))
        .data;
      if (raw === null) return null;
      const result = LedgerViewSchema.parse(raw);
      if (
        result.payload.decisionId !== decision.data?.payload.intent.decisionId ||
        result.payload.decisionDigest !== decision.data.digest ||
        result.payload.binding.caseId !== row.caseId
      )
        throw new Error("Decision commitment mismatch");
      return result;
    },
  });
  const deliveries = useQuery({
    queryKey: [...key, "delivery"],
    enabled: !!decision.data,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const result = DeliverySchema.parse(
        await api.get(`${base}/arbitration-decision/delivery`, scope),
      );
      const expected = [row.context.sourceSiteId, row.context.targetSiteId];
      if (
        new Set(result.data.map((d) => d.receivingSiteId)).size !== result.data.length ||
        result.data.some((d) => !expected.includes(d.receivingSiteId))
      )
        throw new Error("Decision delivery scope mismatch");
      return result;
    },
  });
  const ledgerStatus = useQuery({
    queryKey: [...key, "ledger-status"],
    enabled: !!ledger.data,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const result = LedgerStatusSchema.parse(
        await api.get(`${base}/arbitration-decision/ledger/status`, scope),
      );
      if (
        result.data?.receipt &&
        (result.data.receipt.recordId !== decision.data?.payload.intent.decisionId ||
          result.data.receipt.digest !== ledger.data?.digest)
      )
        throw new Error("Case ledger receipt mismatch");
      return result;
    },
  });
  const refresh = () => {
    void decision.refetch();
    if (decision.data) {
      void ledger.refetch();
      void deliveries.refetch();
    }
    if (ledger.data) void ledgerStatus.refetch();
  };
  const inspection = useMutation({
    retry: false,
    onMutate: () => setReview(null),
    mutationFn: async () => {
      if (!active.current || busy || row.closedAt)
        throw new Error("Arbitration review unavailable");
      const result = ArbitrationReviewSchema.parse(
        (await api.post<{ data: unknown }>(`${base}/arbitration-review`, { grantIds }, scope)).data,
      );
      checkCaseBinding(result.context.binding, row);
      if (result.evidence.some((e) => !grantIds.includes(e.grantId)))
        throw new Error("Unselected evidence returned");
      return result;
    },
    onSuccess: (result) => {
      if (active.current) {
        setReview(result);
        setTarget("");
        setOutcome(result.context.policy.actions[0] ?? "resolve-without-financial-change");
      }
    },
  });
  const generate = useMutation({
    retry: false,
    mutationFn: async (kind: "decision" | "ledger") => {
      assertAllowed(kind);
      let action: Action;
      if (kind === "decision") {
        const financial = review?.context.financial;
        const selection = financial?.targets.find((item) => item.bill.recordId === target);
        const result =
          outcome === "resolve-without-financial-change"
            ? { action: outcome }
            : outcome === "settle"
              ? { action: outcome, bill: selection?.bill, chargedAmount: amount }
              : {
                  action: outcome,
                  bill: selection?.bill,
                  settlement: selection?.settlement,
                  previousAdjustment: selection?.previousAdjustment,
                  chargedAmount: amount,
                };
        const input = ArbitrationDecisionInputSchema.parse({
          decisionId: crypto.randomUUID(),
          grantIds,
          outcome: result,
          reason,
        });
        const payload = ArbitrationDecisionIntentSchema.parse(
          (await api.post<{ data: unknown }>(`${base}/arbitration-decision/draft`, input, scope))
            .data,
        );
        checkCaseBinding(payload.binding, row);
        if (
          payload.decisionId !== input.decisionId ||
          federationCanonicalJson(payload.outcome) !== federationCanonicalJson(input.outcome) ||
          payload.reason !== input.reason
        )
          throw new Error("Decision draft mismatch");
        action = { kind, payload };
      } else {
        const input = { caseDomainId: z.uuid().parse(domainId.trim()) };
        const payload = CaseArbitrationDecisionSchema.parse(
          (
            await api.post<{ data: unknown }>(
              `${base}/arbitration-decision/ledger/draft`,
              input,
              scope,
            )
          ).data,
        );
        if (
          payload.caseDomainId !== input.caseDomainId ||
          payload.binding.caseId !== row.caseId ||
          payload.decisionId !== decision.data?.payload.intent.decisionId ||
          payload.decisionDigest !== decision.data.digest
        )
          throw new Error("Case ledger draft mismatch");
        action = { kind, payload };
      }
      assertAllowed(kind);
      setIntent(action);
    },
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: Action) => {
      assertAllowed(action.kind);
      if (action.kind === "decision") {
        const raw = (await api.get<{ data: unknown }>(`${base}/arbitration-decision`, scope)).data;
        assertAllowed(action.kind);
        const result =
          raw === null
            ? checkDecision(
                (
                  await api.post<{ data: unknown }>(
                    `${base}/arbitration-decision`,
                    action.payload,
                    scope,
                  )
                ).data,
              )
            : checkDecision(raw);
        if (
          federationCanonicalJson(result.payload.intent) !== federationCanonicalJson(action.payload)
        )
          throw new Error("Persisted decision differs from intent");
      } else if (action.kind === "ledger") {
        const raw = (await api.get<{ data: unknown }>(`${base}/arbitration-decision/ledger`, scope))
          .data;
        assertAllowed(action.kind);
        const result = LedgerViewSchema.parse(
          raw === null
            ? (
                await api.post<{ data: unknown }>(
                  `${base}/arbitration-decision/ledger`,
                  action.payload,
                  scope,
                )
              ).data
            : raw,
        );
        if (federationCanonicalJson(result.payload) !== federationCanonicalJson(action.payload))
          throw new Error("Persisted commitment differs from intent");
      } else
        await api.post(
          `${base}/arbitration-decision/${action.kind === "delivery" ? `delivery/${action.siteId}/retry` : "ledger/retry"}`,
          {},
          scope,
        );
    },
    onSuccess: () => {
      if (!active.current) return;
      setIntent(null);
      setUnknown(false);
      refresh();
    },
    onError: () => setUnknown(true),
  });
  const blocked = busy || mutation.isPending || generate.isPending || inspection.isPending;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">{t("federation.evidence.arbitration")}</h3>
        <Button variant="outline" disabled={blocked} onClick={refresh}>
          {t("federation.refresh")}
        </Button>
      </div>
      {decision.isError ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : decision.isPending ? (
        <p role="status">{t("federation.loading")}</p>
      ) : decision.data ? (
        <>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt>{t("federation.evidence.decisionId")}</dt>
              <dd className="break-all">{decision.data.payload.intent.decisionId}</dd>
            </div>
            <div>
              <dt>{t("federation.evidence.outcome")}</dt>
              <dd>
                {t(`federation.governance.outcomes.${decision.data.payload.intent.outcome.action}`)}
              </dd>
            </div>
            <div>
              <dt>{t("federation.evidence.reason")}</dt>
              <dd className="whitespace-pre-wrap break-words">
                {decision.data.payload.intent.reason}
              </dd>
            </div>
            {decision.data.payload.intent.outcome.action !== "resolve-without-financial-change" ? (
              <div>
                <dt>{t("federation.governance.disclosureFields.chargedAmount")}</dt>
                <dd>
                  {decision.data.payload.intent.outcome.chargedAmount} ·{" "}
                  {decision.data.payload.intent.binding.unit}
                </dd>
              </div>
            ) : null}
          </dl>
          {deliveries.isError ? (
            <p role="alert">{t("federation.evidence.deliveryFailed")}</p>
          ) : deliveries.data ? (
            <div className="space-y-3">
              <h4 className="text-sm font-medium">{t("federation.evidence.deliveries")}</h4>
              {!deliveries.data.enabled ? (
                <p role="status">{t("federation.evidence.deliveryDisabled")}</p>
              ) : null}
              {deliveries.data.data.map((item) => (
                <div
                  className="flex flex-wrap items-center gap-3 text-sm"
                  key={item.receivingSiteId}
                >
                  <span className="min-w-0 break-all">{item.receivingSiteId}</span>
                  <span>{t(`federation.evidence.states.${item.state}`)}</span>
                  {item.lastError ? <span className="break-words">{item.lastError}</span> : null}
                  {item.acknowledgedAt ? (
                    <time dateTime={item.acknowledgedAt}>
                      {new Date(item.acknowledgedAt).toLocaleString(i18n.language)}
                    </time>
                  ) : null}
                  {authority.current.decide &&
                  item.state === "needs_review" &&
                  deliveries.data.enabled ? (
                    <Button
                      variant="outline"
                      disabled={blocked || !!intent}
                      onClick={() => {
                        mutation.reset();
                        setIntent({ kind: "delivery", siteId: item.receivingSiteId });
                      }}
                    >
                      {t("federation.governance.recover")}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {ledger.isError ? (
            <p role="alert">{t("federation.evidence.ledgerFailed")}</p>
          ) : ledger.data ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">{t("federation.evidence.ledger")}</h4>
              {ledgerStatus.isError ? (
                <p role="alert">{t("federation.loadFailed")}</p>
              ) : ledgerStatus.data ? (
                <>
                  <p>
                    {t(
                      ledgerStatus.data.enabled
                        ? `federation.evidence.states.${ledgerStatus.data.data?.state ?? "pending"}`
                        : "federation.evidence.ledgerDisabled",
                    )}
                  </p>
                  {ledgerStatus.data.data?.lastError ? (
                    <p role="alert">{ledgerStatus.data.data.lastError}</p>
                  ) : null}
                  {ledgerStatus.data.data?.receipt ? (
                    <p className="break-all text-sm">{ledgerStatus.data.data.receipt.recordId}</p>
                  ) : null}
                  {authority.current.publish &&
                  ledgerStatus.data.enabled &&
                  ledgerStatus.data.data?.state === "needs_review" ? (
                    <Button
                      disabled={blocked || !!intent}
                      variant="outline"
                      onClick={() => {
                        mutation.reset();
                        setIntent({ kind: "retry" });
                      }}
                    >
                      {t("federation.governance.recover")}
                    </Button>
                  ) : null}
                </>
              ) : (
                <p role="status">{t("federation.loading")}</p>
              )}
            </div>
          ) : authority.current.publish ? (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                generate.mutate("ledger");
              }}
            >
              <label className="grid min-w-0 flex-1 gap-1 text-sm" htmlFor={`${id}-domain`}>
                {t("federation.governance.fields.caseDomainId")}
                <Input
                  required
                  id={`${id}-domain`}
                  value={domainId}
                  disabled={blocked || !!intent}
                  onChange={(event) => setDomainId(event.target.value)}
                />
              </label>
              <Button disabled={blocked || !!intent} type="submit">
                {t("federation.evidence.ledger")}
              </Button>
            </form>
          ) : null}
        </>
      ) : (
        <>
          <Button
            variant="outline"
            disabled={blocked || !!row.closedAt || !!intent}
            onClick={() => inspection.mutate()}
          >
            {t("federation.evidence.review")}
          </Button>
          {inspection.isError ? <p role="alert">{t("federation.evidence.reviewFailed")}</p> : null}
          {review ? (
            <>
              <p className="text-sm">
                {t("federation.evidence.validUntil")}:{" "}
                {new Date(review.expiresAt).toLocaleString(i18n.language)}
              </p>
              <ul className="space-y-2 text-sm">
                {review.evidence.map((item) => (
                  <li key={item.grantId} className="break-all">
                    {t(`federation.governance.records.${item.recordType}`)} · {item.recordId} ·{" "}
                    {item.fields
                      .map((field) => t(`federation.governance.disclosureFields.${field}`))
                      .join(", ")}
                  </li>
                ))}
              </ul>
              {authority.current.decide ? (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    generate.mutate("decision");
                  }}
                >
                  <fieldset className="space-y-3" disabled={blocked || !!intent}>
                    <label className="grid gap-1 text-sm" htmlFor={`${id}-outcome`}>
                      {t("federation.evidence.outcome")}
                      <NativeSelect
                        id={`${id}-outcome`}
                        aria-label={t("federation.evidence.outcome")}
                        value={outcome}
                        onChange={(event) => setOutcome(event.target.value)}
                      >
                        {review.context.policy.actions.map((value) => (
                          <option key={value} value={value}>
                            {t(`federation.governance.outcomes.${value}`)}
                          </option>
                        ))}
                      </NativeSelect>
                    </label>
                    {outcome !== "resolve-without-financial-change" ? (
                      <>
                        <label className="grid gap-1 text-sm" htmlFor={`${id}-target`}>
                          {t("federation.evidence.bill")}
                          <NativeSelect
                            required
                            id={`${id}-target`}
                            aria-label={t("federation.evidence.bill")}
                            value={target}
                            onChange={(event) => setTarget(event.target.value)}
                          >
                            <option value="">{t("federation.evidence.chooseBill")}</option>
                            {review.context.financial?.targets
                              .filter((item) =>
                                outcome === "settle" ? !item.settlement : !!item.settlement,
                              )
                              .map((item) => (
                                <option key={item.bill.recordId} value={item.bill.recordId}>
                                  {item.bill.recordId}
                                </option>
                              ))}
                          </NativeSelect>
                        </label>
                        <label className="grid gap-1 text-sm" htmlFor={`${id}-amount`}>
                          {t("federation.governance.disclosureFields.chargedAmount")} ·{" "}
                          {review.context.policy.unit}
                          <Input
                            required
                            id={`${id}-amount`}
                            inputMode="numeric"
                            value={amount}
                            onChange={(event) => setAmount(event.target.value)}
                          />
                        </label>
                      </>
                    ) : null}
                    <label className="grid gap-1 text-sm" htmlFor={`${id}-reason`}>
                      {t("federation.evidence.reason")}
                      <Textarea
                        required
                        maxLength={4000}
                        id={`${id}-reason`}
                        aria-label={t("federation.evidence.reason")}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </label>
                    <Button type="submit">{t("federation.governance.preview")}</Button>
                  </fieldset>
                </form>
              ) : null}
            </>
          ) : null}
        </>
      )}
      {generate.isError ? <p role="alert">{t("federation.evidence.draftFailed")}</p> : null}
      <Dialog
        open={!!intent}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending && !unknown) setIntent(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(
                intent?.kind === "decision"
                  ? "federation.evidence.signDecision"
                  : intent?.kind === "ledger"
                    ? "federation.evidence.ledger"
                    : "federation.governance.recover",
              )}
            </DialogTitle>
            <DialogDescription>
              {t(unknown ? "federation.governance.unknown" : "federation.evidence.decisionConfirm")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {intent?.kind === "decision" ? (
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt>{t("federation.evidence.fields.caseId")}</dt>
                  <dd className="break-all">{row.caseId}</dd>
                </div>
                <div>
                  <dt>{t("federation.evidence.outcome")}</dt>
                  <dd>{t(`federation.governance.outcomes.${intent.payload.outcome.action}`)}</dd>
                </div>
                {intent.payload.outcome.action !== "resolve-without-financial-change" ? (
                  <div>
                    <dt>{t("federation.governance.disclosureFields.chargedAmount")}</dt>
                    <dd>
                      {intent.payload.outcome.chargedAmount} · {intent.payload.binding.unit}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t("federation.evidence.reason")}</dt>
                  <dd className="whitespace-pre-wrap break-words">{intent.payload.reason}</dd>
                </div>
              </dl>
            ) : null}
            <details className="mt-3">
              <summary className="cursor-pointer text-sm">
                {t("federation.governance.terms")}
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(intent && "payload" in intent ? intent.payload : intent, null, 2)}
              </pre>
            </details>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={unknown || mutation.isPending}
              onClick={() => setIntent(null)}
            >
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={
                blocked ||
                !intent ||
                !(intent.kind === "decision" || intent.kind === "delivery"
                  ? authority.current.decide
                  : authority.current.publish)
              }
              onClick={() => {
                if (intent) mutation.mutate(intent);
              }}
            >
              {t(unknown ? "federation.governance.recover" : "federation.governance.approve")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

import {
  FederationInputReconciliationCandidateSchema,
  type FederationInputReconciliationPlan,
  FederationInputReconciliationPlanSchema,
  type FederationStorageReconciliation,
  FederationStorageReconciliationSchema,
} from "@kuintessence/shared/federation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, RefreshCw } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { api } from "../../lib/api-client";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
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

const root = "/admin/federation/input-reconciliation";
const queryKey = ["federation", "input-reconciliation"] as const;

export function FederationStoragePanel() {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const mobileReadOnly = useMobileMutationBlocked(root);
  const lookupId = useId();
  const [lookup, setLookup] = useState("");
  const [invalidLookup, setInvalidLookup] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey,
    queryFn: async () =>
      z
        .array(FederationInputReconciliationCandidateSchema)
        .parse((await api.get<{ data: unknown }>(`${root}?limit=100`)).data),
    gcTime: 0,
  });
  const detail = useQuery({
    queryKey: [...queryKey, selected],
    enabled: !!selected,
    queryFn: async () =>
      FederationInputReconciliationPlanSchema.parse(
        (await api.get<{ data: unknown }>(`${root}/${selected}`)).data,
      ),
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [busy, setBusy] = useState(false);
  const plan = detail.data;
  const date = (value: string) => new Date(value).toLocaleString(i18n.language);
  return (
    <Card data-testid="federation-storage-panel">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>{t("federation.storage.title")}</CardTitle>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || list.isFetching || detail.isFetching}
          onClick={() => void client.invalidateQueries({ queryKey })}
        >
          <RefreshCw className="h-4 w-4" />
          {t("federation.refresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {selected ? (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelected(null)}>
              <ArrowLeft className="h-4 w-4" />
              {t("federation.storage.back")}
            </Button>
            {detail.isPending ? (
              <p role="status">{t("federation.loading")}</p>
            ) : detail.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {toUserFacingError(detail.error, t("federation.loadFailed"))}
              </p>
            ) : plan ? (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="break-all font-mono text-sm">{plan.generation}</h3>
                  <Badge variant="outline">{t(`federation.storage.states.${plan.state}`)}</Badge>
                </div>
                <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                  <Fact label={t("federation.storage.importId")}>{plan.importId}</Fact>
                  <Fact label={t("federation.storage.reservationId")}>{plan.reservationId}</Fact>
                  <Fact label={t("federation.storage.importState")}>
                    {t(`federation.storage.states.${plan.importState}`)}
                  </Fact>
                  <Fact label={t("federation.storage.executionStopped")}>
                    {t(
                      plan.executionStopped
                        ? "federation.storage.stopped"
                        : "federation.storage.notStopped",
                    )}
                  </Fact>
                  <Fact label={t("federation.storage.leaseUntil")}>{date(plan.leaseUntil)}</Fact>
                  <Fact label={t("federation.storage.sizeBytes")}>
                    {plan.sizeBytes.toLocaleString(i18n.language)}
                  </Fact>
                  <Fact label={t("federation.storage.storageKey")}>{plan.storageKey}</Fact>
                  <Fact label="SHA-256">{plan.sha256}</Fact>
                </dl>
                <details className="text-sm">
                  <summary className="cursor-pointer">{t("federation.storage.snapshot")}</summary>
                  <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                    {(
                      [
                        "localSiteId",
                        "transferId",
                        "snapshotDigest",
                        "uploadId",
                        "destinationVersionId",
                        "destinationEtag",
                      ] as const
                    ).map((key) => (
                      <Fact key={key} label={t(`federation.storage.${key}`)}>
                        {plan[key] ?? t("federation.storage.notRecorded")}
                      </Fact>
                    ))}
                    {(
                      ["allocationStartedAt", "completionStartedAt", "completionSettledAt"] as const
                    ).map((key) => (
                      <Fact key={key} label={t(`federation.storage.${key}`)}>
                        {plan[key] ? date(plan[key]) : t("federation.storage.notRecorded")}
                      </Fact>
                    ))}
                  </dl>
                </details>
                {plan.reconciliation ? (
                  <section className="space-y-3 border-t border-border pt-5">
                    <h4 className="text-sm font-semibold">{t("federation.storage.recorded")}</h4>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <Fact label={t("federation.storage.incidentId")}>
                        {plan.reconciliation.incidentId}
                      </Fact>
                      <Fact label={t("federation.storage.stoppedAt")}>
                        {date(plan.reconciliation.stoppedAt)}
                      </Fact>
                      <Fact label={t("federation.storage.evidenceDigest")}>
                        {plan.reconciliation.evidenceDigest}
                      </Fact>
                      <Fact label={t("federation.storage.actorId")}>
                        {plan.reconciliation.actorId}
                      </Fact>
                      <Fact label={t("federation.storage.recordedAt")}>
                        {date(plan.reconciliation.recordedAt)}
                      </Fact>
                    </dl>
                    <p className="text-sm text-muted-foreground">
                      {t(
                        plan.state === "cleaned"
                          ? "federation.storage.cleaned"
                          : "federation.storage.awaitCleanup",
                      )}
                    </p>
                  </section>
                ) : mobileReadOnly ? (
                  <p className="text-sm text-muted-foreground">
                    {t("federation.storage.desktopOnly")}
                  </p>
                ) : (
                  <ReconciliationForm
                    key={`${plan.generation}:${plan.snapshotDigest}`}
                    plan={plan}
                    disabled={detail.isFetching}
                    onBusy={setBusy}
                    onSaved={() => client.invalidateQueries({ queryKey })}
                  />
                )}
              </>
            ) : null}
          </>
        ) : (
          <>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const parsed = z.uuid().safeParse(lookup.trim());
                setInvalidLookup(!parsed.success);
                if (parsed.success) setSelected(parsed.data);
              }}
            >
              <label htmlFor={lookupId} className="min-w-0 flex-1 space-y-1 text-sm">
                {t("federation.storage.generation")}
                <Input
                  id={lookupId}
                  value={lookup}
                  onChange={(event) => setLookup(event.target.value)}
                  required
                />
              </label>
              <Button variant="outline" type="submit">
                {t("federation.storage.lookup")}
              </Button>
            </form>
            {invalidLookup ? (
              <p role="alert" className="text-sm text-status-failed">
                {t("federation.storage.invalidLookup")}
              </p>
            ) : null}
            {list.isPending ? (
              <p role="status">{t("federation.loading")}</p>
            ) : list.isError ? (
              <p role="alert" className="text-sm text-status-failed">
                {toUserFacingError(list.error, t("federation.loadFailed"))}
              </p>
            ) : list.data?.length ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t("federation.storage.listScope", { count: list.data.length })}
                </p>
                <ul className="divide-y divide-border">
                  {list.data.map((item) => (
                    <li key={item.generation}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-4 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setSelected(item.generation)}
                      >
                        <span className="min-w-0 space-y-1">
                          <span className="block break-all font-mono text-sm">
                            {item.generation}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {t("federation.storage.leaseUntil")}: {date(item.leaseUntil)}
                          </span>
                        </span>
                        <Badge variant="outline">
                          {t(
                            item.reconciliation
                              ? "federation.storage.recorded"
                              : "federation.storage.pending",
                          )}
                        </Badge>
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t("federation.storage.empty")}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all">{children}</dd>
    </div>
  );
}

function ReconciliationForm({
  plan,
  disabled,
  onBusy,
  onSaved,
}: {
  plan: FederationInputReconciliationPlan;
  disabled: boolean;
  onBusy: (value: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const mobileReadOnly = useMobileMutationBlocked(root);
  const [incidentId, setIncidentId] = useState("");
  const [evidenceDigest, setEvidenceDigest] = useState("");
  const [stoppedAt, setStoppedAt] = useState("");
  const [allWritersStopped, setWritersStopped] = useState(false);
  const [storageRequestsDrained, setDrained] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [decision, setDecision] = useState<FederationStorageReconciliation | null>(null);
  const change = useMutation({
    mutationFn: (input: FederationStorageReconciliation) =>
      api.post(`${root}/${plan.generation}`, input),
    onSuccess: async () => {
      setDecision(null);
      await onSaved();
    },
    onSettled: () => onBusy(false),
  });
  const eligible =
    plan.importState === "cancelling" &&
    plan.state === "cleanup_pending" &&
    plan.executionStopped &&
    Date.parse(plan.leaseUntil) <= Date.now() &&
    ((!!plan.allocationStartedAt && !plan.uploadId) ||
      (!!plan.completionStartedAt && !plan.completionSettledAt));
  const blocked = disabled || mobileReadOnly || change.isPending || !eligible;
  return (
    <section className="space-y-4 border-t border-border pt-5">
      <h4 className="text-sm font-semibold">{t("federation.storage.attest")}</h4>
      <p className="max-w-prose text-sm text-muted-foreground">
        {t("federation.storage.boundary")}
      </p>
      {!eligible ? (
        <p role="status" className="text-sm">
          {t("federation.storage.ineligible")}
        </p>
      ) : null}
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (blocked) return;
          const time = new Date(stoppedAt).getTime();
          const parsed = FederationStorageReconciliationSchema.safeParse({
            snapshotDigest: plan.snapshotDigest,
            incidentId: incidentId.trim(),
            evidenceDigest: evidenceDigest.trim(),
            stoppedAt: Number.isFinite(time) ? new Date(time).toISOString() : "",
            allWritersStopped,
            storageRequestsDrained,
          });
          if (!parsed.success || time < Date.parse(plan.leaseUntil) || time > Date.now()) {
            setInvalid(true);
            return;
          }
          setInvalid(false);
          change.reset();
          setDecision(parsed.data);
        }}
      >
        <fieldset disabled={blocked} className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm" htmlFor={`${fieldId}-incident`}>
            {t("federation.storage.incidentId")}
            <Input
              id={`${fieldId}-incident`}
              value={incidentId}
              onChange={(e) => setIncidentId(e.target.value)}
              required
              maxLength={128}
            />
          </label>
          <label className="space-y-1 text-sm" htmlFor={`${fieldId}-stopped`}>
            {t("federation.storage.stoppedAt")}
            <Input
              id={`${fieldId}-stopped`}
              type="datetime-local"
              step="1"
              value={stoppedAt}
              onChange={(e) => setStoppedAt(e.target.value)}
              required
            />
          </label>
          <label className="space-y-1 text-sm sm:col-span-2" htmlFor={`${fieldId}-evidence`}>
            {t("federation.storage.evidenceDigest")}
            <Input
              id={`${fieldId}-evidence`}
              value={evidenceDigest}
              onChange={(e) => setEvidenceDigest(e.target.value)}
              placeholder="sha256:…"
              required
              maxLength={71}
              className="font-mono"
            />
          </label>
          <label
            htmlFor={`${fieldId}-writers`}
            className="flex items-start gap-2 text-sm sm:col-span-2"
          >
            <input
              id={`${fieldId}-writers`}
              type="checkbox"
              checked={allWritersStopped}
              onChange={(e) => setWritersStopped(e.target.checked)}
              required
            />
            {t("federation.storage.allWritersStopped")}
          </label>
          <label
            htmlFor={`${fieldId}-drained`}
            className="flex items-start gap-2 text-sm sm:col-span-2"
          >
            <input
              id={`${fieldId}-drained`}
              type="checkbox"
              checked={storageRequestsDrained}
              onChange={(e) => setDrained(e.target.checked)}
              required
            />
            {t("federation.storage.storageRequestsDrained")}
          </label>
        </fieldset>
        {invalid ? (
          <p role="alert" className="text-sm text-status-failed">
            {t("federation.storage.invalid")}
          </p>
        ) : null}
        {change.isError && !decision ? (
          <p role="alert" className="text-sm text-status-failed">
            {t("federation.storage.saveFailed")}
          </p>
        ) : null}
        <Button type="submit" disabled={blocked || !allWritersStopped || !storageRequestsDrained}>
          {t("federation.storage.attest")}
        </Button>
      </form>
      <Dialog
        open={!!decision}
        onOpenChange={(open) => {
          if (!open && !change.isPending) setDecision(null);
        }}
      >
        <DialogContent dismissible={!change.isPending}>
          <DialogHeader>
            <DialogTitle>{t("federation.storage.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("federation.storage.confirmEffect")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3 text-sm">
            <dl className="space-y-3">
              <Fact label={t("federation.storage.generation")}>{plan.generation}</Fact>
              <Fact label={t("federation.storage.incidentId")}>{decision?.incidentId}</Fact>
              <Fact label={t("federation.storage.evidenceDigest")}>{decision?.evidenceDigest}</Fact>
            </dl>
            {change.isError ? (
              <p role="alert" className="text-status-failed">
                {t("federation.storage.saveFailed")}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={change.isPending} onClick={() => setDecision(null)}>
              {t("federation.cancel")}
            </Button>
            <Button
              disabled={blocked}
              onClick={() => {
                if (!blocked && decision) {
                  onBusy(true);
                  change.mutate(decision);
                }
              }}
            >
              {t(change.isPending ? "federation.saving" : "federation.storage.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

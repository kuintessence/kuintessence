import type { TFunction } from "i18next";
import { DatabaseZap, Loader2, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { ApiError, api } from "../../lib/api-client";
import { getAuthState, subscribeAuthState } from "../../lib/auth";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { toUserFacingError } from "../../lib/user-facing-error";
import { FunctionMaps } from "../function-maps/FunctionMaps";
import { authorizationRuntime } from "../function-maps/runtime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Textarea } from "../ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { OrganizationMembershipPanel } from "./OrganizationMembershipPanel";

interface AuthzHealth {
  mode: "off" | "shadow" | "enforce";
  configured: boolean;
  healthy: boolean;
  schemaWritten: boolean;
  schemaMatches: boolean;
  error: string | null;
  rawTupleAdminEnabled: boolean;
  outbox: { pending: number; processing: number; dead: number };
}

interface AuthzReadiness {
  mode: "off" | "shadow" | "enforce";
  healthy: boolean;
  schemaWritten: boolean;
  schemaMatches: boolean;
  outbox: { pending: number; processing: number; dead: number };
  shadowDiffs: number;
  enforceReady: boolean;
  blockers: string[];
  externalSmokeRequired: boolean;
}

interface AuthzDiff {
  id: string;
  actorEmail: string | null;
  resourceType: string;
  resourceId: string;
  permission: string;
  localAllowed: boolean;
  spiceAllowed: boolean;
  spiceError: string | null;
  createdAt: string;
}

interface AuthzOutboxRow {
  id: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

interface AuthzRebuildResult {
  tupleCount: number;
  purgedResourceTypes: string[];
  counts: Record<string, number>;
}

const RAW_CONFIRM = "I understand this bypasses Server business constraints";
const SHADOW_DIFF_CLEAR_CONFIRM = "I reviewed and accept clearing authorization shadow diffs";

export function canProcessAuthzOutbox(
  readiness: Pick<AuthzReadiness, "outbox"> | null | undefined,
): boolean {
  return (readiness?.outbox.pending ?? 0) > 0 || (readiness?.outbox.processing ?? 0) > 0;
}

function friendlyAuthzBlocker(blocker: string, t: TFunction): string {
  if (blocker === "AUTHZ_MODE is off") return t("adminAccess.modeOff");
  if (blocker === "SpiceDB client is not configured") return t("adminAccess.notConfigured");
  if (blocker === "SpiceDB schema has not been written by this Server") {
    return t("adminAccess.schemaMissing");
  }
  if (blocker === "SpiceDB schema differs from AUTHZ_SCHEMA_PATH") {
    return t("adminAccess.schemaMismatch");
  }
  const pending = blocker.match(/^(\d+) authz outbox rows are pending$/);
  if (pending?.[1]) return t("adminAccess.pendingChanges", { total: pending[1] });
  const processing = blocker.match(/^(\d+) authz outbox rows are still processing$/);
  if (processing?.[1]) return t("adminAccess.processingChanges", { total: processing[1] });
  const dead = blocker.match(/^(\d+) authz outbox rows are dead-lettered$/);
  if (dead?.[1]) return t("adminAccess.deadChanges", { total: dead[1] });
  const diffs = blocker.match(/^(\d+) shadow authorization diffs remain$/);
  if (diffs?.[1]) return t("adminAccess.remainingDiffs", { total: diffs[1] });
  return t("adminAccess.healthFailed");
}

export function AuthzAdminPanel(props: { showBreakGlass?: boolean }) {
  const organizationId = useActiveOrganizationId();
  const revision = useSyncExternalStore(
    subscribeAuthState,
    () => getAuthState().revision,
    () => null,
  );
  return <ScopedAuthzAdminPanel key={`${organizationId}:${revision}`} {...props} />;
}
function ScopedAuthzAdminPanel({ showBreakGlass = false }: { showBreakGlass?: boolean }) {
  const { t } = useTranslation();
  const mobileReadOnly = useMobileMutationBlocked("/admin/authz");
  const [health, setHealth] = useState<AuthzHealth | null>(null);
  const [readiness, setReadiness] = useState<AuthzReadiness | null>(null);
  const [diffs, setDiffs] = useState<AuthzDiff[]>([]);
  const [outbox, setOutbox] = useState<AuthzOutboxRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadForbidden, setLoadForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [clearingDiffs, setClearingDiffs] = useState(false);
  const [processingOutbox, setProcessingOutbox] = useState(false);
  const [rawTuple, setRawTuple] = useState(
    JSON.stringify(
      {
        operation: "create",
        resource: { type: "organization", id: "" },
        relation: "viewer",
        subject: { type: "user", id: "" },
        confirm: RAW_CONFIRM,
      },
      null,
      2,
    ),
  );

  const request = useRef<AbortController | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const [healthRes, readinessRes, diffRes, outboxRes] = await Promise.all([
        api.get<{ success: true; data: AuthzHealth }>(
          "/admin/authz/health",
          undefined,
          controller.signal,
        ),
        api.get<{ success: true; data: AuthzReadiness }>(
          "/admin/authz/readiness",
          undefined,
          controller.signal,
        ),
        api.get<{ success: true; data: AuthzDiff[] }>(
          "/admin/authz/shadow-diffs?limit=20",
          undefined,
          controller.signal,
        ),
        api.get<{ success: true; data: AuthzOutboxRow[] }>(
          "/admin/authz/outbox?limit=20",
          undefined,
          controller.signal,
        ),
      ]);
      if (controller.signal.aborted) return;
      setFetchedAt(new Date().toISOString());
      setHealth(healthRes.data);
      setReadiness(readinessRes.data);
      setDiffs(diffRes.data);
      setOutbox(outboxRes.data);
      setLoadForbidden(false);
      setLoadError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = toUserFacingError(err, t("adminAccess.refreshFailed"));
      setHealth(null);
      setReadiness(null);
      setDiffs([]);
      setOutbox([]);
      setLoadForbidden(err instanceof ApiError && (err.status === 401 || err.status === 403));
      setLoadError(message);
      toast.error(message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);

  const healthTone = health?.healthy ? "brand" : health?.mode === "off" ? "outline" : "failed";
  const rawTupleParsed = useMemo(() => {
    try {
      return JSON.parse(rawTuple) as unknown;
    } catch {
      return null;
    }
  }, [rawTuple]);

  return (
    <div className="space-y-4">
      <OrganizationMembershipPanel />
      <FunctionMaps
        ids={["T01"]}
        runtime={{
          ...authorizationRuntime({
            health,
            readiness,
            state: loading
              ? "loading"
              : loadError
                ? loadForbidden
                  ? "forbidden"
                  : "error"
                : health && readiness
                  ? "ready"
                  : "no-data",
            fetchedAt,
          }),
          refresh: () => void refresh(),
          refreshing: loading,
        }}
        onOpen={() => {
          const details = document.getElementById("authz-existing-controls");
          if (details instanceof HTMLDetailsElement) {
            details.open = true;
            details.scrollIntoView({ block: "start" });
          }
          return true;
        }}
      />
      <details className="border-b" id="authz-existing-controls">
        <summary className="cursor-pointer p-4 text-sm font-medium">
          {t("adminAccess.advancedTitle")}
        </summary>
        <Card data-testid="authz-admin-panel" className="">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4" />

                {t("adminAccess.serviceTitle")}
              </CardTitle>
            </div>
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}

              {t("adminAccess.refresh")}
            </Button>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 md:grid-cols-5">
              <Metric
                label={t("adminAccess.mode")}
                value={
                  health
                    ? t(
                        {
                          off: "adminAccess.off",
                          shadow: "adminAccess.shadow",
                          enforce: "adminAccess.enforced",
                        }[health.mode],
                      )
                    : t("adminAccess.unknown")
                }
                badge={healthTone}
              />
              <Metric
                label={t("adminAccess.health")}
                value={
                  health
                    ? health.healthy
                      ? t("adminAccess.healthy")
                      : t("adminAccess.unhealthy")
                    : t("adminAccess.unknown")
                }
                badge={healthTone}
              />
              <Metric
                label={t("adminAccess.schema")}
                value={
                  health === null
                    ? t("adminAccess.unknown")
                    : health.schemaWritten
                      ? health.schemaMatches
                        ? t("adminAccess.loaded")
                        : t("adminAccess.mismatch")
                      : t("adminAccess.notLoaded")
                }
                badge={health?.schemaWritten && health.schemaMatches ? "brand" : "failed"}
              />
              <Metric
                label={t("adminAccess.enforce")}
                value={
                  readiness
                    ? readiness.enforceReady
                      ? t("adminAccess.ready")
                      : t("adminAccess.notReady")
                    : t("adminAccess.unknown")
                }
                badge={readiness?.enforceReady ? "brand" : "failed"}
              />
              <Metric
                label={t("adminAccess.diffs")}
                value={readiness ? String(readiness.shadowDiffs) : t("adminAccess.unknown")}
              />
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <Metric
                label={t("adminAccess.pending")}
                value={readiness ? String(readiness.outbox.pending) : t("adminAccess.unknown")}
              />
              <Metric
                label={t("adminAccess.processing")}
                value={readiness ? String(readiness.outbox.processing) : t("adminAccess.unknown")}
              />
              <Metric
                label={t("adminAccess.failed")}
                value={readiness ? String(readiness.outbox.dead) : t("adminAccess.unknown")}
              />
            </div>
            {readiness?.blockers.length ? (
              <div className=" p-3 text-sm text-status-failed">
                <div className="font-medium">{t("adminAccess.conditions")}</div>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {readiness.blockers.map((blocker) => (
                    <li key={blocker}>{friendlyAuthzBlocker(blocker, t)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {readiness?.externalSmokeRequired ? (
              <div className=" p-3 text-sm text-muted-foreground">
                {t("adminAccess.verifyEnforcement")}
              </div>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={mobileReadOnly || rebuilding}
              onClick={async () => {
                setRebuilding(true);
                try {
                  const res = await api.post<{ success: true; data: AuthzRebuildResult }>(
                    "/admin/authz/rebuild",
                    {},
                  );
                  toast.success(
                    t("adminAccess.rebuilt", {
                      types: res.data.purgedResourceTypes.length,
                      total: res.data.tupleCount,
                    }),
                  );
                  await refresh();
                } catch (err) {
                  toast.error(toUserFacingError(err, t("adminAccess.rebuildFailed")));
                } finally {
                  setRebuilding(false);
                }
              }}
            >
              {rebuilding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}

              {t("adminAccess.rebuild")}
            </Button>
            {health?.error ? (
              <div className=" p-3 text-sm text-status-failed">{t("adminAccess.unavailable")}</div>
            ) : null}
            {loadError ? (
              <div className=" p-3 text-sm text-status-failed" data-testid="authz-refresh-error">
                {loadError}
              </div>
            ) : null}

            <div>
              {showBreakGlass ? (
                <div className="space-y-3" data-testid="authz-raw-tuple-break-glass">
                  <h3 className="text-sm font-medium">{t("adminAccess.rawTitle")}</h3>
                  <Textarea
                    aria-label={t("adminAccess.rawLabel")}
                    className="min-h-40 w-full font-mono text-xs"
                    value={rawTuple}
                    disabled={mobileReadOnly}
                    onChange={(event) => setRawTuple(event.target.value)}
                  />
                  <Button
                    variant="destructive"
                    disabled={
                      mobileReadOnly || !health?.rawTupleAdminEnabled || rawTupleParsed == null
                    }
                    onClick={async () => {
                      try {
                        await api.post<{ success: true }>(
                          "/admin/authz/raw-tuples",
                          rawTupleParsed,
                        );
                        toast.success(t("adminAccess.queued"));
                        await refresh();
                      } catch (err) {
                        toast.error(toUserFacingError(err, t("adminAccess.writeFailed")));
                      }
                    }}
                  >
                    <DatabaseZap className="h-3.5 w-3.5" />

                    {t("adminAccess.write")}
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <SectionTable
                title={t("adminAccess.recentDiffs")}
                headers={[
                  t("adminAccess.resource"),
                  t("adminAccess.permission"),
                  t("adminAccess.comparison"),
                  t("adminAccess.actor"),
                ]}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      mobileReadOnly || clearingDiffs || (readiness?.shadowDiffs ?? 0) === 0
                    }
                    onClick={async () => {
                      if (!window.confirm(t("adminAccess.clearConfirm"))) return;
                      setClearingDiffs(true);
                      try {
                        const res = await api.post<{ success: true; data: { cleared: number } }>(
                          "/admin/authz/shadow-diffs/clear",
                          { confirm: SHADOW_DIFF_CLEAR_CONFIRM },
                        );
                        toast.success(t("adminAccess.cleared", { total: res.data.cleared }));
                        await refresh();
                      } catch (err) {
                        toast.error(toUserFacingError(err, t("adminAccess.clearFailed")));
                      } finally {
                        setClearingDiffs(false);
                      }
                    }}
                  >
                    {clearingDiffs ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}

                    {t("adminAccess.clear")}
                  </Button>
                }
                rows={diffs.map((row) => [
                  `${row.resourceType}:${row.resourceId}`,
                  row.permission,
                  `${t(row.localAllowed ? "adminAccess.allow" : "adminAccess.deny")} / ${t(row.spiceAllowed ? "adminAccess.allow" : "adminAccess.deny")}`,
                  row.spiceError ? t("adminAccess.diffCheckFailed") : (row.actorEmail ?? ""),
                ])}
                empty={t("adminAccess.noDiffs")}
              />
              <SectionTable
                title={t("adminAccess.recentSync")}
                headers={[
                  t("adminAccess.syncStatus"),
                  t("adminAccess.resourceRelation"),
                  t("adminAccess.subject"),
                  t("adminAccess.delivery"),
                ]}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      mobileReadOnly || processingOutbox || !canProcessAuthzOutbox(readiness)
                    }
                    onClick={async () => {
                      setProcessingOutbox(true);
                      try {
                        const res = await api.post<{
                          success: true;
                          data: { processed: number; dead: number };
                        }>("/admin/authz/outbox/process", { batchSize: 100 });
                        toast.success(
                          t("adminAccess.delivered", {
                            total: res.data.processed,
                            failed: res.data.dead,
                          }),
                        );
                        await refresh();
                      } catch (err) {
                        toast.error(toUserFacingError(err, t("adminAccess.deliveryFailed")));
                      } finally {
                        setProcessingOutbox(false);
                      }
                    }}
                  >
                    {processingOutbox ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}

                    {t("adminAccess.deliver")}
                  </Button>
                }
                rows={outbox.map((row) => [
                  row.status,
                  `${row.resourceType}:${row.resourceId}#${row.relation}`,
                  `${row.subjectType}:${row.subjectId}`,
                  row.status === "dead" ? (
                    <Button
                      key={row.id}
                      disabled={mobileReadOnly}
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        try {
                          await api.post<{ success: true }>(
                            `/admin/authz/outbox/${row.id}/retry`,
                            {},
                          );
                          toast.success(t("adminAccess.requeued"));
                          await refresh();
                        } catch (err) {
                          toast.error(toUserFacingError(err, t("adminAccess.retryFailed")));
                        }
                      }}
                    >
                      {t("adminAccess.retry")}
                    </Button>
                  ) : (
                    <span key={row.id}>
                      {row.lastError
                        ? t("adminAccess.incomplete")
                        : t("adminAccess.attempts", { total: row.attempts })}
                    </span>
                  ),
                ])}
                empty={t("adminAccess.noOutbox")}
              />
            </div>
          </CardContent>
        </Card>
      </details>
    </div>
  );
}

function Metric({
  label,
  value,
  badge = "outline",
}: {
  label: string;
  value: string;
  badge?: "brand" | "outline" | "failed";
}) {
  return (
    <div className=" p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <Badge variant={badge} className="mt-2">
        {value}
      </Badge>
    </div>
  );
}

function SectionTable({
  title,
  headers,
  action,
  rows,
  empty,
}: {
  title: string;
  headers: string[];
  action?: ReactNode;
  rows: ReactNode[][];
  empty: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {action}
      </div>
      <SimpleTable headers={headers} rows={rows} empty={empty} />
    </div>
  );
}

function SimpleTable({
  headers,
  rows,
  empty,
}: {
  headers: string[];
  rows: ReactNode[][];
  empty: string;
}) {
  if (rows.length === 0) return <p className="py-6 text-sm text-muted-foreground">{empty}</p>;
  const cellKeys = ["primary", "secondary", "tertiary", "quaternary"] as const;
  return (
    <div className="max-h-[28rem] overflow-auto ">
      <Table className="w-full min-w-[32rem] table-fixed text-left text-xs">
        <TableHeader className="sticky top-0 border-b ">
          <TableRow>
            {headers.map((label) => (
              <TableHead key={label} className="p-3 font-medium">
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const rowKey = row.map((cell) => (typeof cell === "string" ? cell : "node")).join("|");
            return (
              <TableRow key={rowKey} className="border-b last:border-b-0">
                {row.map((cell, index) => (
                  <TableCell
                    key={cellKeys[index] ?? index}
                    className="break-words p-3 align-top [overflow-wrap:anywhere]"
                  >
                    {cell || "—"}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

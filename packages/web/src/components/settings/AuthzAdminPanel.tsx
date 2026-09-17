import { DatabaseZap, Loader2, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

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

interface AuthzMembership {
  id: string;
  userId: string;
  email: string | null;
  orgId: string;
  role: string;
  updatedAt: string;
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

const MEMBERSHIP_ROLES = ["owner", "admin", "operator", "member", "viewer"] as const;
const RAW_CONFIRM = "I understand this bypasses Server business constraints";
const SHADOW_DIFF_CLEAR_CONFIRM = "I reviewed and accept clearing authorization shadow diffs";

export function canProcessAuthzOutbox(
  readiness: Pick<AuthzReadiness, "outbox"> | null | undefined,
): boolean {
  return (readiness?.outbox.pending ?? 0) > 0 || (readiness?.outbox.processing ?? 0) > 0;
}

function friendlyAuthzBlocker(blocker: string): string {
  if (blocker === "AUTHZ_MODE is off") return "平台授权模式尚未启用";
  if (blocker === "SpiceDB client is not configured") return "授权服务尚未完成配置";
  if (blocker === "SpiceDB schema has not been written by this Server") {
    return "授权关系模型尚未初始化";
  }
  if (blocker === "SpiceDB schema differs from AUTHZ_SCHEMA_PATH") {
    return "授权关系模型与平台配置不一致";
  }
  const pending = blocker.match(/^(\d+) authz outbox rows are pending$/);
  if (pending?.[1]) return `仍有 ${pending[1]} 条授权变更等待投递`;
  const processing = blocker.match(/^(\d+) authz outbox rows are still processing$/);
  if (processing?.[1]) return `仍有 ${processing[1]} 条授权变更正在投递`;
  const dead = blocker.match(/^(\d+) authz outbox rows are dead-lettered$/);
  if (dead?.[1]) return `有 ${dead[1]} 条授权变更需要人工重试`;
  const diffs = blocker.match(/^(\d+) shadow authorization diffs remain$/);
  if (diffs?.[1]) return `仍有 ${diffs[1]} 条授权差异需要复核`;
  return "授权服务健康检查未通过，请查看运维日志";
}

export function AuthzAdminPanel({ showBreakGlass = false }: { showBreakGlass?: boolean }) {
  const [health, setHealth] = useState<AuthzHealth | null>(null);
  const [readiness, setReadiness] = useState<AuthzReadiness | null>(null);
  const [diffs, setDiffs] = useState<AuthzDiff[]>([]);
  const [outbox, setOutbox] = useState<AuthzOutboxRow[]>([]);
  const [memberships, setMemberships] = useState<AuthzMembership[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [clearingDiffs, setClearingDiffs] = useState(false);
  const [processingOutbox, setProcessingOutbox] = useState(false);
  const [membership, setMembership] = useState({ userId: "", orgId: "", role: "member" });
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

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [healthRes, readinessRes, diffRes, outboxRes, membershipRes] = await Promise.all([
        api.get<{ success: true; data: AuthzHealth }>("/admin/authz/health"),
        api.get<{ success: true; data: AuthzReadiness }>("/admin/authz/readiness"),
        api.get<{ success: true; data: AuthzDiff[] }>("/admin/authz/shadow-diffs?limit=20"),
        api.get<{ success: true; data: AuthzOutboxRow[] }>("/admin/authz/outbox?limit=20"),
        api.get<{ success: true; data: AuthzMembership[] }>("/admin/authz/memberships"),
      ]);
      setHealth(healthRes.data);
      setReadiness(readinessRes.data);
      setDiffs(diffRes.data);
      setOutbox(outboxRes.data);
      setMemberships(membershipRes.data);
      setLoadError(null);
    } catch (err) {
      const message = toUserFacingError(err, "授权状态暂时无法刷新，请稍后重试。");
      setHealth(null);
      setReadiness(null);
      setDiffs([]);
      setOutbox([]);
      setMemberships([]);
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
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
    <Card data-testid="authz-admin-panel">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" />
            SpiceDB 授权层
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {showBreakGlass
              ? "Shadow diff、outbox、membership 与 break-glass raw tuple 管理。"
              : "Shadow diff、outbox 与 membership 管理。"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          刷新
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 md:grid-cols-5">
          <Metric label="Mode" value={health?.mode ?? "unknown"} badge={healthTone} />
          <Metric label="Healthy" value={health?.healthy ? "yes" : "no"} badge={healthTone} />
          <Metric
            label="Schema"
            value={
              health?.schemaWritten ? (health.schemaMatches ? "loaded" : "mismatch") : "pending"
            }
            badge={health?.schemaWritten && health.schemaMatches ? "brand" : "failed"}
          />
          <Metric
            label="Enforce ready"
            value={readiness?.enforceReady ? "yes" : "no"}
            badge={readiness?.enforceReady ? "brand" : "failed"}
          />
          <Metric label="Shadow diffs" value={String(readiness?.shadowDiffs ?? 0)} />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Metric label="Outbox pending" value={String(readiness?.outbox.pending ?? 0)} />
          <Metric label="Outbox processing" value={String(readiness?.outbox.processing ?? 0)} />
          <Metric label="Outbox dead" value={String(readiness?.outbox.dead ?? 0)} />
        </div>
        {readiness?.blockers.length ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <div className="font-medium">Enforce blockers</div>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {readiness.blockers.map((blocker) => (
                <li key={blocker}>{friendlyAuthzBlocker(blocker)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {readiness?.externalSmokeRequired ? (
          <div className="rounded-md border p-3 text-sm text-muted-foreground">
            切换 enforce 前仍需完成 Compose / scheduler Compose 的真实 SpiceDB smoke。
          </div>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={rebuilding}
          onClick={async () => {
            setRebuilding(true);
            try {
              const res = await api.post<{ success: true; data: AuthzRebuildResult }>(
                "/admin/authz/rebuild",
                {},
              );
              toast.success(
                `已替换 ${res.data.purgedResourceTypes.length} 类资源，写入 ${res.data.tupleCount} 条授权关系`,
              );
              await refresh();
            } catch (err) {
              toast.error(toUserFacingError(err, "授权状态重建失败，请稍后重试。"));
            } finally {
              setRebuilding(false);
            }
          }}
        >
          {rebuilding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          重建 SpiceDB 关系
        </Button>
        {health?.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            授权服务当前不可用，请重试；如问题持续，请查看平台服务与 SpiceDB 运维日志。
          </div>
        ) : null}
        {loadError ? (
          <div
            className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
            data-testid="authz-refresh-error"
          >
            {loadError}
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-3">
            <h3 className="text-sm font-medium">Membership upsert</h3>
            <div className="grid gap-2 md:grid-cols-[1fr_1fr_140px_auto]">
              <input
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="user UUID"
                value={membership.userId}
                onChange={(event) =>
                  setMembership((prev) => ({ ...prev, userId: event.target.value }))
                }
              />
              <input
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="org UUID"
                value={membership.orgId}
                onChange={(event) =>
                  setMembership((prev) => ({ ...prev, orgId: event.target.value }))
                }
              />
              <select
                className="rounded-md border bg-background px-3 py-2 text-sm"
                value={membership.role}
                onChange={(event) =>
                  setMembership((prev) => ({ ...prev, role: event.target.value }))
                }
              >
                {MEMBERSHIP_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <Button
                onClick={async () => {
                  try {
                    await api.put<{ success: true }>("/admin/authz/memberships", membership);
                    toast.success("Membership 已写入 outbox");
                    await refresh();
                  } catch (err) {
                    toast.error(toUserFacingError(err, "成员授权保存失败，请稍后重试。"));
                  }
                }}
              >
                保存
              </Button>
            </div>
            <SimpleTable
              rows={memberships
                .slice(0, 8)
                .map((row) => [row.email ?? row.userId, row.orgId, row.role])}
              empty="暂无 membership"
            />
          </div>

          {showBreakGlass ? (
            <div className="space-y-3" data-testid="authz-raw-tuple-break-glass">
              <h3 className="text-sm font-medium">Raw tuple break-glass</h3>
              <textarea
                className="min-h-40 w-full rounded-md border bg-background p-3 font-mono text-xs"
                value={rawTuple}
                onChange={(event) => setRawTuple(event.target.value)}
              />
              <Button
                variant="destructive"
                disabled={!health?.rawTupleAdminEnabled || rawTupleParsed == null}
                onClick={async () => {
                  try {
                    await api.post<{ success: true }>("/admin/authz/raw-tuples", rawTupleParsed);
                    toast.success("Raw tuple 已写入 outbox");
                    await refresh();
                  } catch (err) {
                    toast.error(toUserFacingError(err, "授权关系写入失败，请稍后重试。"));
                  }
                }}
              >
                <DatabaseZap className="h-3.5 w-3.5" />
                写入 raw tuple
              </Button>
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <SectionTable
            title="最近 Shadow diff"
            action={
              <Button
                variant="outline"
                size="sm"
                disabled={clearingDiffs || (readiness?.shadowDiffs ?? 0) === 0}
                onClick={async () => {
                  if (!window.confirm("确认已审阅 Shadow diff，并清空当前 diff 记录？")) return;
                  setClearingDiffs(true);
                  try {
                    const res = await api.post<{ success: true; data: { cleared: number } }>(
                      "/admin/authz/shadow-diffs/clear",
                      { confirm: SHADOW_DIFF_CLEAR_CONFIRM },
                    );
                    toast.success(`已清理 ${res.data.cleared} 条 Shadow diff`);
                    await refresh();
                  } catch (err) {
                    toast.error(toUserFacingError(err, "授权差异清理失败，请稍后重试。"));
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
                清理
              </Button>
            }
            rows={diffs.map((row) => [
              `${row.resourceType}:${row.resourceId}`,
              row.permission,
              `${row.localAllowed}/${row.spiceAllowed}`,
              row.spiceError ? "授权差异检测未完成，请查看运维日志" : (row.actorEmail ?? ""),
            ])}
            empty="暂无 diff"
          />
          <SectionTable
            title="最近 Outbox"
            action={
              <Button
                variant="outline"
                size="sm"
                disabled={processingOutbox || !canProcessAuthzOutbox(readiness)}
                onClick={async () => {
                  setProcessingOutbox(true);
                  try {
                    const res = await api.post<{
                      success: true;
                      data: { processed: number; dead: number };
                    }>("/admin/authz/outbox/process", { batchSize: 100 });
                    toast.success(`已投递 ${res.data.processed} 条，dead ${res.data.dead} 条`);
                    await refresh();
                  } catch (err) {
                    toast.error(toUserFacingError(err, "授权变更投递失败，请稍后重试。"));
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
                立即投递
              </Button>
            }
            rows={outbox.map((row) => [
              row.status,
              `${row.resourceType}:${row.resourceId}#${row.relation}`,
              `${row.subjectType}:${row.subjectId}`,
              row.status === "dead" ? (
                <Button
                  key={row.id}
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      await api.post<{ success: true }>(`/admin/authz/outbox/${row.id}/retry`, {});
                      toast.success("Outbox dead-letter 已重新入队");
                      await refresh();
                    } catch (err) {
                      toast.error(toUserFacingError(err, "授权变更重试失败，请稍后重试。"));
                    }
                  }}
                >
                  Retry
                </Button>
              ) : (
                <span key={row.id}>
                  {row.lastError ? "授权变更投递未完成，请稍后重试" : `attempts=${row.attempts}`}
                </span>
              ),
            ])}
            empty="暂无 outbox"
          />
        </div>
      </CardContent>
    </Card>
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
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <Badge variant={badge} className="mt-2">
        {value}
      </Badge>
    </div>
  );
}

function SectionTable({
  title,
  action,
  rows,
  empty,
}: {
  title: string;
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
      <SimpleTable rows={rows} empty={empty} />
    </div>
  );
}

function SimpleTable({ rows, empty }: { rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        {empty}
      </div>
    );
  }
  const cellKeys = ["primary", "secondary", "tertiary", "quaternary"] as const;
  return (
    <div className="overflow-hidden rounded-md border">
      {rows.map((row) => {
        const rowKey = row.map((cell) => (typeof cell === "string" ? cell : "node")).join("|");
        return (
          <div key={rowKey} className="grid grid-cols-4 gap-2 border-b p-2 text-xs last:border-b-0">
            {row.map((cell, index) => (
              <div
                key={cellKeys[index] ?? index}
                className="truncate font-mono"
                title={typeof cell === "string" ? cell : undefined}
              >
                {cell || "-"}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

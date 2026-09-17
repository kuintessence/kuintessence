import type { CloudStorageOverview } from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock3, Database, HardDrive, Loader2, Save, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

const GB = 1024 ** 3;

interface StoragePolicyRow {
  defaultQuotaBytes: number;
  maxQuotaBytes: number | null;
  requestMode: "auto" | "manual" | "disabled";
  autoApproveLimitBytes: number | null;
  enabled: boolean;
}

interface PolicyResponse {
  policy: StoragePolicyRow | null;
  effectivePolicy: Omit<StoragePolicyRow, "enabled">;
}

interface QuotaRequestRow {
  id: string;
  userId: string;
  requestedQuotaBytes: number;
  requestedExpiresAt: string | null;
  reason: string;
  status: string;
  createdAt: string;
}

interface PolicyDraft {
  defaultQuotaGb: string;
  maxQuotaGb: string;
  requestMode: StoragePolicyRow["requestMode"];
  autoApproveLimitGb: string;
  enabled: boolean;
}

const EMPTY_DRAFT: PolicyDraft = {
  defaultQuotaGb: "50",
  maxQuotaGb: "",
  requestMode: "manual",
  autoApproveLimitGb: "",
  enabled: true,
};

export function CloudStorageGovernancePanel() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PolicyDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [grantUserId, setGrantUserId] = useState("");
  const [grantQuotaGb, setGrantQuotaGb] = useState("");
  const [grantExpiresAt, setGrantExpiresAt] = useState("");
  const [granting, setGranting] = useState(false);
  const policyQ = useQuery({
    queryKey: ["admin-storage-policy", "cloud", "global"],
    queryFn: () => api.get<PolicyResponse>("/admin/storage/policy?scope=cloud&scopeId=global"),
  });
  const overviewQ = useQuery({
    queryKey: ["admin-storage-overview"],
    queryFn: () => api.get<CloudStorageOverview>("/admin/storage/overview"),
    refetchInterval: 30_000,
  });
  const requestsQ = useQuery({
    queryKey: ["admin-storage-quota-requests", "cloud", "global"],
    queryFn: () =>
      api.get<{ requests: QuotaRequestRow[] }>(
        "/admin/storage/quota-requests?scope=cloud&scopeId=global",
      ),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (!policyQ.data) return;
    const source = policyQ.data.policy ?? {
      ...policyQ.data.effectivePolicy,
      enabled: true,
    };
    setDraft({
      defaultQuotaGb: bytesToGbInput(source.defaultQuotaBytes),
      maxQuotaGb: source.maxQuotaBytes == null ? "" : bytesToGbInput(source.maxQuotaBytes),
      requestMode: source.requestMode,
      autoApproveLimitGb:
        source.autoApproveLimitBytes == null ? "" : bytesToGbInput(source.autoApproveLimitBytes),
      enabled: source.enabled,
    });
  }, [policyQ.data]);

  const savePolicy = async () => {
    const defaultQuotaBytes = gbInputToBytes(draft.defaultQuotaGb);
    const maxQuotaBytes = draft.maxQuotaGb ? gbInputToBytes(draft.maxQuotaGb) : null;
    const autoApproveLimitBytes = draft.autoApproveLimitGb
      ? gbInputToBytes(draft.autoApproveLimitGb)
      : null;
    if (defaultQuotaBytes == null || (draft.maxQuotaGb && maxQuotaBytes == null)) {
      toast.error("请输入有效的存储配额");
      return;
    }
    setSaving(true);
    try {
      await api.put("/admin/storage/policy", {
        scope: "cloud",
        scopeId: "global",
        defaultQuotaBytes,
        maxQuotaBytes,
        requestMode: draft.requestMode,
        autoApproveLimitBytes,
        enabled: draft.enabled,
      });
      toast.success("云存储配额策略已保存");
      await queryClient.invalidateQueries({ queryKey: ["admin-storage-policy"] });
    } catch (error) {
      toast.error(toUserFacingError(error, "保存云存储策略失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  };

  const decide = async (requestId: string, decision: "approved" | "rejected") => {
    try {
      await api.post(`/admin/storage/quota-requests/${requestId}/decision`, {
        decision,
        note: decision === "approved" ? "平台管理员批准" : "平台管理员拒绝",
      });
      toast.success(decision === "approved" ? "配额申请已批准" : "配额申请已拒绝");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-storage-quota-requests"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-storage-overview"] }),
      ]);
    } catch (error) {
      toast.error(toUserFacingError(error, "处理配额申请失败，请稍后重试。"));
    }
  };

  const createGrant = async () => {
    const quotaBytes = gbInputToBytes(grantQuotaGb);
    if (!grantUserId.trim() || quotaBytes == null || quotaBytes <= 0) {
      toast.error("请填写用户 ID 和有效配额");
      return;
    }
    setGranting(true);
    try {
      await api.post("/admin/storage/grants", {
        userId: grantUserId.trim(),
        scope: "cloud",
        scopeId: "global",
        quotaBytes,
        expiresAt: grantExpiresAt ? new Date(grantExpiresAt).toISOString() : null,
        note: grantExpiresAt ? "平台分配临时配额" : "平台手动分配配额",
      });
      setGrantUserId("");
      setGrantQuotaGb("");
      setGrantExpiresAt("");
      toast.success("存储配额已分配");
      await queryClient.invalidateQueries({ queryKey: ["admin-storage-overview"] });
    } catch (error) {
      toast.error(toUserFacingError(error, "分配配额失败，请稍后重试。"));
    } finally {
      setGranting(false);
    }
  };

  const overview = overviewQ.data;
  const pendingRequests = (requestsQ.data?.requests ?? []).filter(
    (request) => request.status === "pending",
  );

  return (
    <Card data-testid="cloud-storage-governance-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-4 w-4" />
          云存储与配额治理
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          统一管理全局 NetDrive 的默认配额、审批方式、临时配额与存储计量。
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="实时占用" value={formatBytes(overview?.usedBytes ?? 0)} />
          <Metric label="对象数量" value={`${overview?.fileCount ?? 0}`} />
          <Metric
            label="近 30 天传输"
            value={formatBytes(
              (overview?.uploadedBytes30d ?? 0) + (overview?.downloadedBytes30d ?? 0),
            )}
          />
          <Metric
            label="存储计量（近 30 天）"
            value={formatByteHours(overview?.storedByteHours30d ?? 0)}
          />
        </div>

        <section className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">全局配额策略</div>
              <div className="text-xs text-muted-foreground">
                用户未单独分配配额时使用默认值；自动审批只在限制范围内生效。
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => void savePolicy()}
              disabled={saving || policyQ.isLoading}
            >
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              保存策略
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Field label="默认配额（GB）">
              <Input
                aria-label="默认配额（GB）"
                type="number"
                min="0"
                value={draft.defaultQuotaGb}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, defaultQuotaGb: event.target.value }))
                }
              />
            </Field>
            <Field label="单用户上限（GB）">
              <Input
                aria-label="单用户上限（GB）"
                type="number"
                min="1"
                placeholder="不限制"
                value={draft.maxQuotaGb}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, maxQuotaGb: event.target.value }))
                }
              />
            </Field>
            <Field label="申请审批方式">
              <select
                aria-label="申请审批方式"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={draft.requestMode}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    requestMode: event.target.value as PolicyDraft["requestMode"],
                  }))
                }
              >
                <option value="auto">自动审批</option>
                <option value="manual">人工审批</option>
                <option value="disabled">关闭申请</option>
              </select>
            </Field>
            <Field label="自动审批上限（GB）">
              <Input
                aria-label="自动审批上限（GB）"
                type="number"
                min="1"
                disabled={draft.requestMode !== "auto"}
                value={draft.autoApproveLimitGb}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, autoApproveLimitGb: event.target.value }))
                }
              />
            </Field>
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">待审批申请</div>
              <Badge variant={pendingRequests.length > 0 ? "brand" : "outline"}>
                {pendingRequests.length} 条
              </Badge>
            </div>
            {pendingRequests.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                当前没有待审批的配额申请。
              </div>
            ) : (
              <div className="max-h-64 space-y-2 overflow-auto">
                {pendingRequests.map((request) => (
                  <div key={request.id} className="rounded-md border p-3 text-xs">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono font-medium">{request.userId}</div>
                        <div className="mt-1 text-sm font-semibold">
                          {formatBytes(request.requestedQuotaBytes)}
                        </div>
                        <div className="mt-1 line-clamp-2 text-muted-foreground">
                          {request.reason}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="outline"
                          title="拒绝"
                          onClick={() => void decide(request.id, "rejected")}
                        >
                          <X />
                        </Button>
                        <Button
                          size="icon"
                          title="批准"
                          onClick={() => void decide(request.id, "approved")}
                        >
                          <Check />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div>
              <div className="text-sm font-semibold">手动分配配额</div>
              <div className="text-xs text-muted-foreground">
                可分配长期配额；填写到期时间后将作为临时配额自动失效。
              </div>
            </div>
            <Field label="平台用户 ID">
              <Input
                aria-label="平台用户 ID"
                value={grantUserId}
                onChange={(event) => setGrantUserId(event.target.value)}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="总配额（GB）">
                <Input
                  aria-label="总配额（GB）"
                  type="number"
                  min="1"
                  value={grantQuotaGb}
                  onChange={(event) => setGrantQuotaGb(event.target.value)}
                />
              </Field>
              <Field label="到期时间（可选）">
                <Input
                  aria-label="到期时间（可选）"
                  type="datetime-local"
                  value={grantExpiresAt}
                  onChange={(event) => setGrantExpiresAt(event.target.value)}
                />
              </Field>
            </div>
            <Button className="w-full" onClick={() => void createGrant()} disabled={granting}>
              {granting ? (
                <Loader2 className="animate-spin" />
              ) : grantExpiresAt ? (
                <Clock3 />
              ) : (
                <HardDrive />
              )}
              分配配额
            </Button>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5 text-xs">
      <span className="font-medium">{label}</span>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/25 p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function gbInputToBytes(value: string): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * GB);
}

function bytesToGbInput(value: number): string {
  return `${Math.round((value / GB) * 100) / 100}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatByteHours(byteHours: number): string {
  return `${(byteHours / GB).toFixed(1)} GB·h`;
}

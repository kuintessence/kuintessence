import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const GB = 1024 ** 3;

interface PolicyResponse {
  policy: {
    defaultQuotaBytes: number;
    maxQuotaBytes: number | null;
    requestMode: "auto" | "manual" | "disabled";
    autoApproveLimitBytes: number | null;
  } | null;
  effectivePolicy: {
    defaultQuotaBytes: number;
    maxQuotaBytes: number | null;
    requestMode: "auto" | "manual" | "disabled";
    autoApproveLimitBytes: number | null;
  };
}

interface RequestRow {
  id: string;
  userId: string;
  requestedQuotaBytes: number;
  status: string;
  reason: string;
}

export function ClusterStoragePolicyEditor({ rootId }: { rootId: string }) {
  const queryClient = useQueryClient();
  const [defaultGb, setDefaultGb] = useState("0");
  const [maxGb, setMaxGb] = useState("");
  const [autoLimitGb, setAutoLimitGb] = useState("");
  const [requestMode, setRequestMode] = useState<"auto" | "manual" | "disabled">("manual");
  const [saving, setSaving] = useState(false);
  const query = `scope=cluster_root&scopeId=${encodeURIComponent(rootId)}`;
  const policyQ = useQuery({
    queryKey: ["cluster-storage-policy", rootId],
    queryFn: () => api.get<PolicyResponse>(`/admin/storage/policy?${query}`),
  });
  const requestsQ = useQuery({
    queryKey: ["cluster-storage-quota-requests", rootId],
    queryFn: () => api.get<{ requests: RequestRow[] }>(`/admin/storage/quota-requests?${query}`),
  });

  useEffect(() => {
    if (!policyQ.data) return;
    const policy = policyQ.data.policy ?? policyQ.data.effectivePolicy;
    setDefaultGb(bytesToGb(policy.defaultQuotaBytes));
    setMaxGb(policy.maxQuotaBytes == null ? "" : bytesToGb(policy.maxQuotaBytes));
    setAutoLimitGb(
      policy.autoApproveLimitBytes == null ? "" : bytesToGb(policy.autoApproveLimitBytes),
    );
    setRequestMode(policy.requestMode);
  }, [policyQ.data]);

  const save = async () => {
    const defaultQuotaBytes = gbToBytes(defaultGb);
    const maxQuotaBytes = maxGb ? gbToBytes(maxGb) : null;
    const autoApproveLimitBytes = autoLimitGb ? gbToBytes(autoLimitGb) : null;
    if (defaultQuotaBytes == null || (maxGb && maxQuotaBytes == null)) {
      toast.error("请输入有效的集群存储配额");
      return;
    }
    setSaving(true);
    try {
      await api.put("/admin/storage/policy", {
        scope: "cluster_root",
        scopeId: rootId,
        defaultQuotaBytes,
        maxQuotaBytes,
        requestMode,
        autoApproveLimitBytes,
        enabled: true,
      });
      toast.success("集群存储申请策略已保存");
      await queryClient.invalidateQueries({ queryKey: ["cluster-storage-policy", rootId] });
    } catch (error) {
      toast.error(toUserFacingError(error, "保存集群存储策略失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  };

  const decide = async (id: string, decision: "approved" | "rejected") => {
    try {
      await api.post(`/admin/storage/quota-requests/${id}/decision`, {
        decision,
        note: decision === "approved" ? "算力提供方批准" : "算力提供方拒绝",
      });
      await queryClient.invalidateQueries({
        queryKey: ["cluster-storage-quota-requests", rootId],
      });
    } catch (error) {
      toast.error(toUserFacingError(error, "处理申请失败，请稍后重试。"));
    }
  };

  const pending = (requestsQ.data?.requests ?? []).filter((item) => item.status === "pending");
  return (
    <div className="space-y-3 rounded-md border border-dashed bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold">用户配额申请策略</div>
          <div className="text-[11px] text-muted-foreground">
            控制用户对该集群存储根目录的默认配额与审批方式。
          </div>
        </div>
        <Badge variant={pending.length > 0 ? "brand" : "outline"}>待审批 {pending.length}</Badge>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_auto]">
        <LabeledInput label="默认配额（GB）" value={defaultGb} onChange={setDefaultGb} />
        <LabeledInput label="单用户上限（GB）" value={maxGb} onChange={setMaxGb} />
        <label className="space-y-1 text-[11px]">
          <span>审批方式</span>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={requestMode}
            onChange={(event) => setRequestMode(event.target.value as typeof requestMode)}
          >
            <option value="auto">自动审批</option>
            <option value="manual">人工审批</option>
            <option value="disabled">关闭申请</option>
          </select>
        </label>
        <LabeledInput
          label="自动审批上限（GB）"
          value={autoLimitGb}
          onChange={setAutoLimitGb}
          disabled={requestMode !== "auto"}
        />
        <Button size="sm" className="self-end" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          保存策略
        </Button>
      </div>
      {pending.length > 0 ? (
        <div className="grid gap-2 md:grid-cols-2">
          {pending.map((request) => (
            <div
              key={request.id}
              className="flex items-center gap-2 rounded-md border bg-background p-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono">{request.userId}</div>
                <div className="font-medium">{bytesToGb(request.requestedQuotaBytes)} GB</div>
              </div>
              <Button
                size="icon"
                variant="outline"
                onClick={() => void decide(request.id, "rejected")}
                title="拒绝"
              >
                <X />
              </Button>
              <Button size="icon" onClick={() => void decide(request.id, "approved")} title="批准">
                <Check />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1 text-[11px]">
      <span>{label}</span>
      <Input
        aria-label={label}
        type="number"
        min="0"
        step="0.01"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function gbToBytes(value: string): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * GB);
}

function bytesToGb(value: number): string {
  return `${Math.round((value / GB) * 100) / 100}`;
}

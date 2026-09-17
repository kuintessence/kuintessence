import type { StorageQuotaSummary } from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CalendarClock, Database, Loader2, RefreshCw, Send } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
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
import { Input } from "../ui/input";

interface StorageQuotaRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: StorageQuotaSummary | null;
  summaryLoading?: boolean;
  summaryError?: string | null;
  onRetrySummary?: () => void;
}

interface QuotaRequestRow {
  id: string;
  requestedQuotaBytes: number;
  requestedExpiresAt: string | null;
  status: string;
  reason: string;
  createdAt: string;
}

export function StorageQuotaRequestDialog({
  open,
  onOpenChange,
  summary,
  summaryLoading = false,
  summaryError = null,
  onRetrySummary,
}: StorageQuotaRequestDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [quotaGb, setQuotaGb] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const requestsQ = useQuery({
    queryKey: ["storage-quota-requests"],
    queryFn: () => api.get<{ requests: QuotaRequestRow[] }>("/storage/quota-requests"),
    enabled: open,
  });
  const dirty = Boolean(quotaGb || expiresAt || reason);
  const submit = async () => {
    if (submittingRef.current || !summary || summaryError) return;
    const requestedQuotaBytes = Math.round(Number(quotaGb) * 1024 * 1024 * 1024);
    if (!Number.isFinite(requestedQuotaBytes) || requestedQuotaBytes <= 0 || !reason.trim()) {
      toast.error(t("files.quota.formIncomplete"));
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await api.post("/storage/quota-requests", {
        scope: "cloud",
        scopeId: "global",
        requestedQuotaBytes,
        requestedExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        reason: reason.trim(),
      });
      toast.success(t("files.quota.requestCreated"));
      setQuotaGb("");
      setExpiresAt("");
      setReason("");
      queryClient.invalidateQueries({ queryKey: ["storage-quota-requests"] });
      queryClient.invalidateQueries({ queryKey: ["storage-summary"] });
    } catch (error) {
      toast.error(toUserFacingError(error, t("files.quota.requestFailed")));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => (!submittingRef.current ? onOpenChange(nextOpen) : undefined)}
    >
      <DialogContent outsideDismissPolicy="when-pristine" dirty={dirty} dismissible={!submitting}>
        <DialogHeader>
          <DialogTitle>{t("files.quota.title")}</DialogTitle>
          <DialogDescription>{t("files.quota.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {summaryLoading ? (
            <StatusMessage icon={<Loader2 className="animate-spin" />}>
              {t("files.quota.summaryLoading")}
            </StatusMessage>
          ) : summaryError || !summary ? (
            <StatusMessage icon={<AlertCircle />} error>
              <span className="flex-1">{t("files.quota.summaryLoadFailed")}</span>
              {onRetrySummary ? (
                <Button type="button" variant="outline" size="sm" onClick={onRetrySummary}>
                  <RefreshCw />
                  {t("common.retry")}
                </Button>
              ) : null}
            </StatusMessage>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric label={t("files.quota.used")} value={formatBytes(summary.usedBytes)} />
              <Metric label={t("files.quota.current")} value={formatBytes(summary.quotaBytes)} />
              <Metric
                label={t("files.quota.approval")}
                value={t(`files.quota.mode.${summary.policy.requestMode}`)}
              />
            </div>
          )}
          <fieldset disabled={submitting} className="space-y-3 disabled:opacity-70">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm" htmlFor="storage-quota-gb">
                <span className="font-medium">{t("files.quota.requestedGb")}</span>
                <Input
                  id="storage-quota-gb"
                  type="number"
                  min="1"
                  step="1"
                  value={quotaGb}
                  onChange={(event) => setQuotaGb(event.target.value)}
                />
              </label>
              <label className="space-y-1.5 text-sm" htmlFor="storage-quota-expires-at">
                <span className="flex items-center gap-1.5 font-medium">
                  <CalendarClock className="h-4 w-4" />
                  {t("files.quota.expiresAt")}
                </span>
                <Input
                  id="storage-quota-expires-at"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              </label>
            </div>
            <label className="block space-y-1.5 text-sm" htmlFor="storage-quota-reason">
              <span className="font-medium">{t("files.quota.reason")}</span>
              <textarea
                id="storage-quota-reason"
                className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                maxLength={2000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t("files.quota.reasonPlaceholder")}
              />
            </label>
          </fieldset>
          <div className="space-y-2">
            <div className="text-sm font-medium">{t("files.quota.history")}</div>
            {requestsQ.isLoading ? (
              <StatusMessage icon={<Loader2 className="animate-spin" />}>
                {t("files.quota.historyLoading")}
              </StatusMessage>
            ) : requestsQ.error ? (
              <StatusMessage icon={<AlertCircle />} error>
                <span className="flex-1">
                  {toUserFacingError(requestsQ.error, t("files.quota.historyLoadFailed"))}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => requestsQ.refetch()}
                >
                  <RefreshCw />
                  {t("common.retry")}
                </Button>
              </StatusMessage>
            ) : (requestsQ.data?.requests ?? []).length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                {t("files.quota.noRequests")}
              </div>
            ) : (
              <div className="divide-y overflow-hidden rounded-md border">
                {(requestsQ.data?.requests ?? []).slice(0, 5).map((request) => (
                  <div key={request.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                    <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{formatBytes(request.requestedQuotaBytes)}</div>
                      <div className="truncate text-muted-foreground">{request.reason}</div>
                    </div>
                    <Badge variant="outline">{t(`files.quota.status.${request.status}`)}</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogBody>
        <DialogFooter className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              submitting ||
              summaryLoading ||
              Boolean(summaryError) ||
              !summary ||
              summary.policy.requestMode === "disabled"
            }
          >
            {submitting ? <Loader2 className="animate-spin" /> : <Send />}
            {t("files.quota.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusMessage({
  children,
  icon,
  error = false,
}: {
  children: ReactNode;
  icon: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 text-xs",
        error
          ? "border-status-failed/30 bg-status-failed/5 text-status-failed"
          : "border-border text-muted-foreground",
      )}
      role={error ? "alert" : "status"}
    >
      <span className="[&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/25 p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

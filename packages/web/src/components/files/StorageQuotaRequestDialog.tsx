import {
  StorageQuotaRequestCreateSchema,
  type StorageQuotaSummary,
  type StorageScope,
} from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CalendarClock, ChevronRight, Loader2, RefreshCw, Send } from "lucide-react";
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
import { Input, Textarea } from "../ui/input";
import { fmtBytes } from "./path-picker-utils";

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
  scope: StorageScope;
  scopeId: string;
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
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [quotaGb, setQuotaGb] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [fieldError, setFieldError] = useState<{ field: string; key: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const close = () => {
    if (submittingRef.current) return;
    setFieldError(null);
    setSubmitError(null);
    onOpenChange(false);
  };
  const requestsQ = useQuery({
    queryKey: ["storage-quota-requests"],
    queryFn: () => api.get<{ requests: QuotaRequestRow[] }>("/storage/quota-requests"),
    enabled: open,
  });
  const dirty = Boolean(quotaGb || expiresAt || reason);
  const cloudRequests = (requestsQ.data?.requests ?? []).filter(
    (request) => request.scope === "cloud" && request.scopeId === "global",
  );
  const summaryUnavailable =
    summaryLoading ||
    Boolean(summaryError) ||
    !summary ||
    summary.policy.requestMode === "disabled";
  const submit = async (form: HTMLFormElement) => {
    if (submittingRef.current || summaryUnavailable || !summary) return;
    const invalid = (field: string, key: string) => {
      setFieldError({ field, key });
      form.querySelector<HTMLElement>(`#storage-quota-${field}`)?.focus();
    };
    setSubmitError(null);
    const requestedGb = Number(quotaGb);
    if (!Number.isInteger(requestedGb) || requestedGb < 1) {
      invalid("gb", "files.quota.invalidQuota");
      return;
    }
    const expiry = expiresAt ? new Date(expiresAt) : null;
    if (expiry && (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now())) {
      invalid("expires-at", "files.quota.expiryMustBeFuture");
      return;
    }
    const input = StorageQuotaRequestCreateSchema.safeParse({
      scope: "cloud",
      scopeId: "global",
      requestedQuotaBytes: requestedGb * 1024 ** 3,
      requestedExpiresAt: expiry?.toISOString() ?? null,
      reason: reason.trim(),
    });
    if (!input.success) {
      if (input.error.issues[0]?.path[0] === "reason") {
        invalid("reason", "files.quota.reasonRequired");
      } else {
        invalid("gb", "files.quota.invalidQuota");
      }
      return;
    }
    if (
      summary.policy.maxQuotaBytes != null &&
      input.data.requestedQuotaBytes > summary.policy.maxQuotaBytes
    ) {
      invalid("gb", "files.quota.exceedsLimit");
      return;
    }
    setFieldError(null);
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await api.post("/storage/quota-requests", input.data);
      toast.success(t("files.quota.requestCreated"));
      setQuotaGb("");
      setExpiresAt("");
      setReason("");
      queryClient.invalidateQueries({ queryKey: ["storage-quota-requests"] });
      queryClient.invalidateQueries({ queryKey: ["storage-summary"] });
    } catch (error) {
      setSubmitError(toUserFacingError(error, t("files.quota.requestFailed")));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const errorFor = (field: string) => fieldError?.field === field;
  const errorMessage = (field: string) =>
    errorFor(field) && fieldError ? (
      <p role="alert" id={`storage-quota-${field}-error`} className="text-xs text-status-failed">
        {t(fieldError.key)}
      </p>
    ) : null;
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
      <DialogContent outsideDismissPolicy="when-pristine" dirty={dirty} dismissible={!submitting}>
        <DialogHeader>
          <DialogTitle>{t("files.quota.title")}</DialogTitle>
          <DialogDescription>{t("files.quota.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {summaryLoading ? (
            <StatusMessage icon={<Loader2 className="animate-spin motion-reduce:animate-none" />}>
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
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-b border-border pb-3 sm:grid-cols-3">
              <Metric label={t("files.quota.used")} value={fmtBytes(summary.usedBytes)} />
              <Metric label={t("files.quota.current")} value={fmtBytes(summary.quotaBytes)} />
              <Metric
                label={t("files.quota.approval")}
                value={t(`files.quota.mode.${summary.policy.requestMode}`)}
              />
            </div>
          )}
          <form
            id="storage-quota-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit(event.currentTarget);
            }}
          >
            <fieldset
              disabled={submitting || summary?.policy.requestMode === "disabled"}
              className="space-y-3 disabled:opacity-70"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 text-sm">
                  <label className="font-medium" htmlFor="storage-quota-gb">
                    {t("files.quota.requestedGb")}
                  </label>
                  <Input
                    id="storage-quota-gb"
                    aria-describedby={
                      [
                        !summaryUnavailable &&
                          summary?.policy.maxQuotaBytes != null &&
                          "storage-quota-limit",
                        errorFor("gb") && "storage-quota-gb-error",
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    type="number"
                    min="1"
                    step="1"
                    max={
                      summary?.policy.maxQuotaBytes != null
                        ? summary.policy.maxQuotaBytes / 1024 ** 3
                        : undefined
                    }
                    value={quotaGb}
                    required
                    aria-invalid={errorFor("gb")}
                    onChange={(event) => {
                      setQuotaGb(event.target.value);
                      if (errorFor("gb")) setFieldError(null);
                    }}
                  />
                  {!summaryUnavailable && summary?.policy.maxQuotaBytes != null ? (
                    <span id="storage-quota-limit" className="block text-xs text-muted-foreground">
                      {t("files.quota.limit", { value: fmtBytes(summary.policy.maxQuotaBytes) })}
                    </span>
                  ) : null}
                  {errorMessage("gb")}
                </div>
                <div className="space-y-1.5 text-sm">
                  <label
                    htmlFor="storage-quota-expires-at"
                    className="flex items-center gap-1.5 font-medium"
                  >
                    <CalendarClock className="h-4 w-4" />
                    {t("files.quota.expiresAt")}
                  </label>
                  <Input
                    id="storage-quota-expires-at"
                    type="datetime-local"
                    value={expiresAt}
                    aria-invalid={errorFor("expires-at")}
                    aria-describedby={
                      errorFor("expires-at") ? "storage-quota-expires-at-error" : undefined
                    }
                    onChange={(event) => {
                      setExpiresAt(event.target.value);
                      if (errorFor("expires-at")) setFieldError(null);
                    }}
                  />
                  {errorMessage("expires-at")}
                </div>
              </div>
              <div className="space-y-1.5 text-sm">
                <label htmlFor="storage-quota-reason" className="font-medium">
                  {t("files.quota.reason")}
                </label>
                <Textarea
                  id="storage-quota-reason"
                  className="min-h-20 w-full"
                  maxLength={2000}
                  value={reason}
                  required
                  aria-invalid={errorFor("reason")}
                  aria-describedby={errorFor("reason") ? "storage-quota-reason-error" : undefined}
                  onChange={(event) => {
                    setReason(event.target.value);
                    if (errorFor("reason")) setFieldError(null);
                  }}
                  placeholder={t("files.quota.reasonPlaceholder")}
                />
                {errorMessage("reason")}
              </div>
            </fieldset>
          </form>
          <div className="space-y-2">
            <div className="text-sm font-medium">{t("files.quota.history")}</div>
            {requestsQ.isLoading ? (
              <StatusMessage icon={<Loader2 className="animate-spin motion-reduce:animate-none" />}>
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
            ) : cloudRequests.length === 0 ? (
              <div className=" p-4 text-center text-xs text-muted-foreground">
                {t("files.quota.noRequests")}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {cloudRequests.slice(0, 5).map((request) => (
                  <details key={request.id} className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-sm focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground group-open:rotate-90" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium tabular-nums">
                          {fmtBytes(request.requestedQuotaBytes)}
                        </span>
                        <time
                          dateTime={request.createdAt}
                          className="block text-xs text-muted-foreground"
                        >
                          {new Date(request.createdAt).toLocaleString(
                            i18n?.resolvedLanguage ?? i18n?.language,
                          )}
                        </time>
                      </span>
                      <Badge
                        variant={
                          request.status === "approved"
                            ? "succeeded"
                            : request.status === "rejected"
                              ? "failed"
                              : "outline"
                        }
                      >
                        {t(`files.quota.status.${request.status}`)}
                      </Badge>
                    </summary>
                    <p className="whitespace-pre-wrap pb-2 pl-6 text-sm [overflow-wrap:anywhere]">
                      {request.reason}
                    </p>
                  </details>
                ))}
              </div>
            )}
          </div>
        </DialogBody>
        <DialogFooter className="flex flex-wrap justify-end gap-2">
          {submitError ? (
            <p
              role="alert"
              className="basis-full text-sm text-status-failed [overflow-wrap:anywhere]"
            >
              {submitError}
            </p>
          ) : null}
          <Button variant="outline" onClick={close} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="storage-quota-form"
            disabled={submitting || summaryUnavailable}
          >
            {submitting ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" />
            ) : (
              <Send />
            )}
            {t(submitting ? "files.quota.submitting" : "files.quota.submit")}
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
        "flex min-h-12 items-center gap-2 px-3 py-2 text-xs",
        error ? " text-status-failed" : "border-border text-muted-foreground",
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
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

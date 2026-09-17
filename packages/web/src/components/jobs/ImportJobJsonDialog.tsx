import {
  type JobSubmit,
  JobSubmitSchema,
  type QueueRegistryView,
  QueueRegistryViewSchema,
} from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileJson, Loader2, Upload } from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { api } from "../../lib/api-client";
import { queueEligibility } from "../../lib/queue-selection";
import { toUserFacingError } from "../../lib/user-facing-error";
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

interface JobResponse {
  id: string;
  name: string;
  status: string;
}

interface ImportedJob {
  fileName: string;
  job: JobSubmit;
  removedSourceUrls: boolean;
}

export interface ImportJobJsonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: (job: JobResponse) => void;
}

function schemaErrorMessage(job: ReturnType<typeof JobSubmitSchema.safeParse>): string {
  if (job.success) return "";
  const issue = job.error.issues[0];
  if (!issue) return "";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function queueSummary(job: JobSubmit): string | null {
  const strategy = job.schedulingStrategy;
  if (strategy?.queueId) return strategy.queueId;
  if (strategy?.preferredQueueIds?.length) return strategy.preferredQueueIds.join(", ");
  return null;
}

function parseVisibleQueues(value: unknown): QueueRegistryView[] {
  if (typeof value !== "object" || value === null || !("queues" in value)) {
    throw new Error("Queue list response is invalid");
  }
  return QueueRegistryViewSchema.array().parse(value.queues);
}

function sanitizeImportedJob(job: JobSubmit): Pick<ImportedJob, "job" | "removedSourceUrls"> {
  if (!job.inputStaging) return { job, removedSourceUrls: false };
  return {
    job: {
      ...job,
      inputStaging: job.inputStaging.map(({ fileMetadataId, stagePath }) => ({
        fileMetadataId,
        stagePath,
      })),
    },
    removedSourceUrls: job.inputStaging.some((entry) => Boolean(entry.sourceUrl)),
  };
}

const BASIC_REVIEW_FIELDS = new Set(["name", "command", "resources", "schedulingStrategy"]);

function advancedFieldNames(job: JobSubmit): string[] {
  return Object.keys(job).filter((field) => !BASIC_REVIEW_FIELDS.has(field));
}

export function ImportJobJsonDialog({ open, onOpenChange, onImported }: ImportJobJsonDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectionRevisionRef = useRef(0);
  const activeOrganizationId = useActiveOrganizationId();
  const [importedJob, setImportedJob] = useState<ImportedJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const queuesQuery = useQuery({
    queryKey: ["queues-visible", activeOrganizationId, "import-json"],
    queryFn: async () => parseVisibleQueues(await api.get<unknown>("/queues/visible")),
    enabled: open && Boolean(importedJob?.job.schedulingStrategy?.queueId),
    retry: false,
  });

  const reset = () => {
    selectionRevisionRef.current += 1;
    setImportedJob(null);
    setError(null);
    setSubmitting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  useEffect(() => {
    if (!open) {
      selectionRevisionRef.current += 1;
      setImportedJob(null);
      setError(null);
      setSubmitting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [open]);

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const selectionRevision = selectionRevisionRef.current + 1;
    selectionRevisionRef.current = selectionRevision;

    setError(null);
    setImportedJob(null);
    let content: string;
    try {
      content = await file.text();
    } catch {
      if (selectionRevision !== selectionRevisionRef.current) return;
      setError(t("jobs.importJson.readFailed", { defaultValue: "Unable to read this JSON file." }));
      return;
    }
    if (selectionRevision !== selectionRevisionRef.current) return;

    let raw: unknown;
    try {
      raw = JSON.parse(content) as unknown;
    } catch {
      setError(t("jobs.importJson.invalidJson", { defaultValue: "This file is not valid JSON." }));
      return;
    }

    const result = JobSubmitSchema.safeParse(raw);
    if (!result.success) {
      const details = schemaErrorMessage(result);
      setError(
        t("jobs.importJson.invalidSchema", {
          defaultValue: "This JSON does not contain a valid job submission.",
        }) + (details ? ` ${details}` : ""),
      );
      return;
    }
    const sanitized = sanitizeImportedJob(result.data);
    setImportedJob({ fileName: file.name, ...sanitized });
  };

  const submit = async () => {
    if (!importedJob) return;
    const queueId = importedJob.job.schedulingStrategy?.queueId;
    const selectedQueue = queueId
      ? (queuesQuery.data ?? []).find((queue) => queue.queueId === queueId)
      : null;
    if (queueId && (queuesQuery.isLoading || queuesQuery.error || !selectedQueue)) {
      setError(
        t("jobs.importJson.queueUnavailable", {
          defaultValue:
            "The imported queue target is unavailable. Choose a valid target before confirming.",
        }),
      );
      return;
    }
    if (selectedQueue && queueEligibility(selectedQueue).state === "blocked") {
      setError(
        t("jobs.importJson.queueBlocked", {
          defaultValue:
            "The imported queue target cannot be submitted in the current organization.",
        }),
      );
      return;
    }
    setSubmitting(true);
    try {
      const response = await api.post<JobResponse>("/jobs", importedJob.job);
      toast.success(t("jobs.submitted", { name: response.name, id: response.id.slice(0, 8) }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs-list"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      onImported?.(response);
      close();
    } catch (submitError) {
      toast.error(
        toUserFacingError(
          submitError,
          t("jobs.submitFailed", { defaultValue: "Failed to submit job" }),
        ),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const job = importedJob?.job;
  const queue = job ? queueSummary(job) : null;
  const importedQueueId = job?.schedulingStrategy?.queueId ?? null;
  const importedQueue = importedQueueId
    ? ((queuesQuery.data ?? []).find((item) => item.queueId === importedQueueId) ?? null)
    : null;
  const importedQueueEligibility = importedQueue ? queueEligibility(importedQueue) : null;
  const importedQueueBlocked =
    Boolean(importedQueueId) &&
    (Boolean(queuesQuery.error) ||
      (!queuesQuery.isLoading && !importedQueue) ||
      importedQueueEligibility?.state === "blocked");
  const advancedFields = job ? advancedFieldNames(job) : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && submitting) return;
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent
        data-testid="import-job-json-dialog"
        outsideDismissPolicy={submitting ? "never" : "always"}
      >
        <DialogHeader>
          <DialogTitle>
            {t("jobs.importJson.title", { defaultValue: "Import job JSON" })}
          </DialogTitle>
          <DialogDescription>
            {t("jobs.importJson.description", {
              defaultValue: "Review the imported job before submitting it to the Server.",
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            onChange={onFileChange}
            data-testid="import-job-json-file"
            aria-label={t("jobs.importJson.fileLabel", { defaultValue: "Choose JSON file" })}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting}
            data-testid="import-job-json-choose"
          >
            <Upload />
            {t(importedJob ? "jobs.importJson.replace" : "jobs.importJson.choose", {
              defaultValue: importedJob ? "Replace file" : "Choose JSON file",
            })}
          </Button>

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-status-failed/40 bg-status-failed/10 px-3 py-2 text-sm text-status-failed"
              data-testid="import-job-json-error"
            >
              {error}
            </div>
          ) : null}

          {importedJob && job ? (
            <div
              className="space-y-3 rounded-md border border-border bg-muted/30 p-3"
              data-testid="import-job-json-preview"
            >
              <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <FileJson className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate" title={importedJob.fileName}>
                  {importedJob.fileName}
                </span>
              </div>
              <div className="text-xs font-medium uppercase text-muted-foreground">
                {t("jobs.importJson.review", { defaultValue: "Review before submitting" })}
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{t("jobs.nameLabel")}</dt>
                  <dd className="truncate font-medium" data-testid="import-job-json-name">
                    {job.name}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{t("jobs.commandLabel")}</dt>
                  <dd className="truncate font-mono text-xs" data-testid="import-job-json-command">
                    {job.command}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("jobs.importJson.resources", { defaultValue: "Resources" })}
                  </dt>
                  <dd data-testid="import-job-json-resources">
                    {job.resources.cpus} CPU · {job.resources.memoryMb} MiB
                    {job.resources.gpus ? ` · ${job.resources.gpus} GPU` : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("jobs.queueLabel", { defaultValue: "Queue" })}
                  </dt>
                  <dd data-testid="import-job-json-queue">
                    {queue ?? t("jobs.queueAuto", { defaultValue: "Auto placement" })}
                  </dd>
                </div>
              </dl>
              {importedQueueId ? (
                <div className="text-xs" data-testid="import-job-json-queue-validation">
                  {queuesQuery.isLoading ? (
                    <span className="text-muted-foreground">
                      {t("jobs.importJson.queueChecking", {
                        defaultValue: "Checking queue target...",
                      })}
                    </span>
                  ) : importedQueueBlocked ? (
                    <span className="text-status-failed" role="alert">
                      {t("jobs.importJson.queueUnavailable", {
                        defaultValue:
                          "The imported queue target is unavailable. Confirming this import is blocked.",
                      })}
                    </span>
                  ) : importedQueueEligibility?.state === "warning" ? (
                    <span className="text-muted-foreground">
                      {t("jobs.importJson.queueWarning", {
                        defaultValue:
                          "The queue target has a warning and will be checked again before submit.",
                      })}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {advancedFields.length > 0 ? (
                <div className="space-y-2" data-testid="import-job-json-advanced-fields">
                  <div className="text-xs font-medium text-muted-foreground">
                    {t("jobs.importJson.advancedFields", {
                      count: advancedFields.length,
                      defaultValue: `${advancedFields.length} advanced configuration fields`,
                    })}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {advancedFields.map((field) => (
                      <code
                        key={field}
                        className="rounded border border-border bg-background px-1.5 py-1 text-[11px]"
                      >
                        {field}
                      </code>
                    ))}
                  </div>
                </div>
              ) : null}
              {importedJob.removedSourceUrls ? (
                <p className="text-xs text-muted-foreground">
                  {t("jobs.importJson.securityNotice", {
                    defaultValue:
                      "Temporary download URLs are ignored. Server reauthorizes input files using fileMetadataId.",
                  })}
                </p>
              ) : null}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={close} disabled={submitting}>
            {t("common.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={!importedJob || submitting || queuesQuery.isLoading || importedQueueBlocked}
            data-testid="import-job-json-submit"
          >
            {submitting ? <Loader2 className="animate-spin" /> : null}
            {t(submitting ? "jobs.importJson.submitting" : "jobs.importJson.submit", {
              defaultValue: submitting ? "Submitting..." : "Confirm and submit",
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

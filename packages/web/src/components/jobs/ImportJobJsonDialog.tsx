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

function advancedFieldsOf(job: JobSubmit) {
  return Object.entries(job).filter(([field]) => !BASIC_REVIEW_FIELDS.has(field));
}

export function ImportJobJsonDialog({ open, onOpenChange, onImported }: ImportJobJsonDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectionRevisionRef = useRef(0);
  const activeOrganizationId = useActiveOrganizationId();
  const [importedJob, setImportedJob] = useState<ImportedJob | null>(null);
  const [fileName, setFileName] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
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
    setFileName("");
    setSubmitError(null);
    setError(null);
    setSubmitting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  useEffect(() => {
    if (!open) {
      selectionRevisionRef.current += 1;
      setImportedJob(null);
      setFileName("");
      setSubmitError(null);
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

    setFileName(file.name);
    setSubmitError(null);
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
    setImportedJob(sanitized);
  };

  const submit = async () => {
    if (!importedJob || submitting || checkingQueue || importedQueueBlocked) return;
    setSubmitError(null);
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
    } catch (cause) {
      setSubmitError(
        toUserFacingError(cause, t("jobs.submitFailed", { defaultValue: "Failed to submit job" })),
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
  const checkingQueue = Boolean(importedQueueId) && queuesQuery.isFetching;
  const advancedFields = job ? advancedFieldsOf(job) : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && submitting) return;
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent data-testid="import-job-json-dialog" dismissible={!submitting}>
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
            className="hidden"
            type="file"
            accept="application/json,.json"
            onChange={onFileChange}
            data-testid="import-job-json-file"
            aria-label={t("jobs.importJson.fileLabel", { defaultValue: "Choose JSON file" })}
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              type="button"
              variant={fileName ? "outline" : "default"}
              onClick={() => fileInputRef.current?.click()}
              disabled={submitting}
              data-testid="import-job-json-choose"
            >
              <Upload />
              {t(fileName ? "jobs.importJson.replace" : "jobs.importJson.choose", {
                defaultValue: fileName ? "Replace file" : "Choose JSON file",
              })}
            </Button>
            {fileName ? (
              <div className="flex min-w-0 items-start gap-1.5 text-sm text-muted-foreground">
                <FileJson className="mt-0.5 size-4 shrink-0" />
                <span className="[overflow-wrap:anywhere]">{fileName}</span>
              </div>
            ) : null}
          </div>
          {fileName && !importedJob && !error ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("jobs.importJson.reading")}
            </p>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="text-sm text-status-failed [overflow-wrap:anywhere]"
              data-testid="import-job-json-error"
            >
              {error}
            </p>
          ) : null}

          {importedJob && job ? (
            <section
              className="space-y-4 border-t border-border pt-4"
              data-testid="import-job-json-preview"
            >
              <h3
                className="text-base font-semibold [overflow-wrap:anywhere]"
                data-testid="import-job-json-name"
              >
                {job.name}
              </h3>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("jobs.importJson.resources", { defaultValue: "Resources" })}
                  </dt>
                  <dd data-testid="import-job-json-resources">
                    {job.resources.cpus} CPU · {job.resources.memoryMb} MiB
                    {job.resources.gpus ? ` · ${job.resources.gpus} GPU` : ""}
                    {job.resources.wallTimeSec ? (
                      <div>
                        {t("jobs.importJson.wallTime", { count: job.resources.wallTimeSec })}
                      </div>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("jobs.queueLabel", { defaultValue: "Queue" })}
                  </dt>
                  <dd className="[overflow-wrap:anywhere]" data-testid="import-job-json-queue">
                    {queue ?? t("jobs.queueAuto", { defaultValue: "Auto placement" })}
                  </dd>
                  {importedQueueId ? (
                    <dd className="mt-1 text-sm" data-testid="import-job-json-queue-validation">
                      {checkingQueue ? (
                        <span role="status" className="text-muted-foreground">
                          {t("jobs.importJson.queueChecking")}
                        </span>
                      ) : queuesQuery.isError ? (
                        <>
                          <p role="alert" className="text-status-failed">
                            {t("jobs.importJson.queueLoadFailed")}
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-2"
                            onClick={() => void queuesQuery.refetch()}
                          >
                            {t("common.retry")}
                          </Button>
                        </>
                      ) : importedQueueBlocked ? (
                        <span role="alert" className="text-status-failed">
                          {t(
                            importedQueue
                              ? "jobs.importJson.queueBlocked"
                              : "jobs.importJson.queueUnavailable",
                          )}
                        </span>
                      ) : importedQueueEligibility?.state === "warning" ? (
                        <span className="text-status-warning">
                          {t("jobs.importJson.queueWarning")}
                        </span>
                      ) : null}
                    </dd>
                  ) : null}
                </div>
                <div className="min-w-0 sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">{t("jobs.commandLabel")}</dt>
                  <dd
                    className="max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-5 [overflow-wrap:anywhere]"
                    data-testid="import-job-json-command"
                  >
                    {job.command}
                  </dd>
                </div>
              </dl>
              {advancedFields.length > 0 ? (
                <details
                  className="border-t border-border pt-2"
                  data-testid="import-job-json-advanced-fields"
                >
                  <summary className="cursor-pointer py-1 text-sm font-medium">
                    {t("jobs.importJson.advancedFields", { count: advancedFields.length })}
                  </summary>
                  <dl className="mt-2 space-y-3">
                    {advancedFields.map(([field, value]) => (
                      <div key={field}>
                        <dt className="font-mono text-xs font-medium">{field}</dt>
                        <dd className="mt-1 whitespace-pre-wrap font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                          {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}
              {importedJob.removedSourceUrls ? (
                <p className="text-xs text-muted-foreground">
                  {t("jobs.importJson.securityNotice", {
                    defaultValue:
                      "Temporary download URLs are ignored. Server reauthorizes input files using fileMetadataId.",
                  })}
                </p>
              ) : null}
            </section>
          ) : null}
        </DialogBody>
        {submitError ? (
          <p
            role="alert"
            className="shrink-0 border-t border-border px-4 py-2 text-sm text-status-failed [overflow-wrap:anywhere] sm:px-5"
            data-testid="import-job-json-submit-error"
          >
            {submitError}
          </p>
        ) : null}
        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={close} disabled={submitting}>
            {t("common.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={!importedJob || submitting || checkingQueue || importedQueueBlocked}
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

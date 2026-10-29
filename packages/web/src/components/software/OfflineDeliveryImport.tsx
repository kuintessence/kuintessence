import {
  OFFLINE_DELIVERY_MAX_BYTES,
  type OfflineDelivery,
  type OfflineDeliveryReport,
  OfflineDeliverySchema,
} from "@kuintessence/shared/browser";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { requestSoftwareJson, softwareWriteHeaders } from "../../lib/software-client";
import { uploadSpackMaterial } from "../../lib/spack-materials-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function OfflineDeliveryImport({
  isCurrent,
  canWriteRepository,
}: {
  isCurrent: () => boolean;
  canWriteRepository: (repository: string) => boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [plan, setPlan] = useState<OfflineDelivery | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [report, setReport] = useState<OfflineDeliveryReport | null>(null);
  const [history, setHistory] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const selection = useRef(0);
  useEffect(
    () => () => {
      selection.current++;
      active.current?.abort();
    },
    [],
  );
  const allowed = !!plan && canWriteRepository(plan.repository) && isCurrent();
  async function select(file?: File) {
    const revision = ++selection.current;
    setPlan(null);
    setReport(null);
    setHistory(null);
    setError("");
    if (!file) return;
    try {
      if (file.size > OFFLINE_DELIVERY_MAX_BYTES)
        throw new Error(t("materials.offline.invalidPlan"));
      const parsed = OfflineDeliverySchema.parse(JSON.parse(await file.text()));
      if (revision === selection.current && isCurrent()) setPlan(parsed);
    } catch {
      if (revision === selection.current && isCurrent())
        setError(t("materials.offline.invalidPlan"));
    }
  }
  async function run(action: "preflight" | "import" | "history") {
    if (!plan || !allowed || busy) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    if (action === "preflight") setReport(null);
    const check = () => {
      controller.signal.throwIfAborted();
      if (!isCurrent() || !canWriteRepository(plan.repository))
        throw new Error(t("materials.offline.sessionChanged"));
    };
    try {
      check();
      if (action === "preflight" && files.length) {
        const selected = new Map(
          files.map((file) => [
            file.webkitRelativePath
              ? file.webkitRelativePath.split("/").slice(1).join("/")
              : file.name,
            file,
          ]),
        );
        for (const entry of plan.files)
          if (selected.get(entry.path)?.size !== entry.blob.size)
            throw new Error(t("materials.offline.missingFile", { path: entry.path }));
        for (const entry of plan.files) {
          check();
          const file = selected.get(entry.path);
          if (!file) throw new Error(t("materials.offline.missingFile", { path: entry.path }));
          await uploadSpackMaterial(plan.repository, entry.blob, file, controller.signal);
        }
      }
      check();
      const result = await requestSoftwareJson<OfflineDeliveryReport>(
        `/offline-deliveries/${action}`,
        {
          method: "POST",
          headers: softwareWriteHeaders(),
          body: JSON.stringify(plan),
          signal: controller.signal,
        },
      );
      check();
      if (action === "history") setHistory(result);
      else setReport(result);
    } catch (failure) {
      if (isCurrent() && !controller.signal.aborted)
        setError(toUserFacingError(failure, t("materials.offline.failed")));
    } finally {
      if (isCurrent()) setBusy(false);
      active.current = null;
    }
  }
  return (
    <details
      className="group rounded-lg border border-border bg-card"
      data-testid="offline-delivery-import"
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring">
        {t("materials.offline.title")}
      </summary>
      <div className="space-y-4 border-t border-border p-4" aria-busy={busy}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <label htmlFor={`${id}-plan`} className="block text-sm font-medium">
              {t("materials.offline.plan")}
            </label>
            <Input
              id={`${id}-plan`}
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(event) => void select(event.target.files?.[0])}
            />
          </div>
          <div className="min-w-0 space-y-2">
            <label htmlFor={`${id}-files`} className="block text-sm font-medium">
              {t("materials.offline.directory")}
            </label>
            <Input
              id={`${id}-files`}
              type="file"
              multiple
              {...{ webkitdirectory: "" }}
              disabled={busy}
              onChange={(event) => {
                setFiles(Array.from(event.target.files ?? []));
                setReport(null);
              }}
            />
          </div>
        </div>
        {plan ? (
          <p className="text-xs text-muted-foreground">{t("materials.offline.changesNotice")}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={report ? "outline" : "default"}
            disabled={!allowed || busy}
            onClick={() => void run("preflight")}
          >
            {t("materials.offline.preflight")}
          </Button>
          <Button
            disabled={
              !allowed ||
              busy ||
              !report ||
              report.items.some((item) => !["planned", "existing"].includes(item.status))
            }
            onClick={() => void run("import")}
          >
            {t("materials.offline.execute")}
          </Button>
          <Button
            variant="ghost"
            className="sm:ml-auto"
            disabled={!allowed || busy}
            onClick={() => void run("history")}
          >
            {t("materials.offline.history")}
          </Button>
        </div>
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("materials.offline.busy")}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="break-words rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {report && (
          <section className="space-y-3" aria-label={t("materials.offline.result")}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-semibold">
                {report.status === "planned"
                  ? t("materials.offline.preflightResult")
                  : t(`materials.offline.status.${report.status}`)}
              </h3>
              <details className="min-w-0 text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t("materials.offline.digest")}</summary>
                <code className="mt-2 block break-all">{report.digest}</code>
              </details>
            </div>
            <ul className="divide-y divide-border rounded-md border border-border">
              {report.items.map((item) => (
                <li key={item.id} className="space-y-2 p-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="min-w-0 flex-1 break-all text-sm font-medium">{item.id}</span>
                    <span className="text-xs text-muted-foreground">
                      {t(`materials.offline.kind.${item.kind}`)}
                    </span>
                    <Badge
                      variant={
                        item.status === "completed" || item.status === "existing"
                          ? "succeeded"
                          : item.status === "planned"
                            ? "outline"
                            : "failed"
                      }
                    >
                      {t(`materials.offline.status.${item.status}`)}
                    </Badge>
                  </div>
                  {item.code ? <p className="break-words font-mono text-xs">{item.code}</p> : null}
                  {item.receipt !== undefined ? (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">{t("materials.offline.receipt")}</summary>
                      <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted/40 p-3">
                        {JSON.stringify(item.receipt, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        )}
        {history !== null && (
          <pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-3 text-xs">
            {JSON.stringify(history, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}

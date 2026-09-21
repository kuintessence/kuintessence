import type { SpackUpstreamImport, SpackUpstreamImportResult } from "@kuintessence/shared/browser";
import { Download, FileJson, Loader2, Square } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SoftwareError } from "../../lib/software-client";
import { importSpackUpstream, readSpackUpstreamManifest } from "../../lib/spack-upstream-client";
import { Button } from "../ui/button";

type Status =
  | "idle"
  | "reading"
  | "ready"
  | "importing"
  | "succeeded"
  | "invalid"
  | "denied"
  | "failed"
  | "unknown";

export function SpackOnlineImport({
  kind,
  canWriteRepository,
  isCurrent,
  onImported,
}: {
  kind: SpackUpstreamImport["kind"];
  canWriteRepository: (repository: string) => boolean;
  isCurrent: () => boolean;
  onImported: (result: SpackUpstreamImportResult) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [manifest, setManifest] = useState<SpackUpstreamImport | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [refreshFailed, setRefreshFailed] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = null;
    };
  }, []);
  const current = () => mounted.current && isCurrent();
  const destination = (value: SpackUpstreamImport) =>
    value.kind === "recipe" ? value.repository : value.release.repository;
  const permitted = (value: SpackUpstreamImport) =>
    current() && value.kind === kind && canWriteRepository(destination(value));
  const live = (controller: AbortController) =>
    current() && active.current === controller && !controller.signal.aborted;
  const busy = status === "reading" || status === "importing";
  const denied = !!manifest && !permitted(manifest);
  const ready = status === "ready" && !!manifest && !denied;

  async function select(file: File | undefined) {
    if (!current() || active.current) return;
    setManifest(null);
    setRefreshFailed(false);
    setStatus(file ? "reading" : "idle");
    if (!file) return;
    const controller = new AbortController();
    active.current = controller;
    try {
      const value = await readSpackUpstreamManifest(file, controller.signal);
      if (!live(controller)) return;
      if (value.kind !== kind) {
        setStatus("invalid");
      } else if (!permitted(value)) {
        setStatus("denied");
      } else {
        setManifest(value);
        setStatus("ready");
      }
    } catch {
      if (live(controller)) setStatus("invalid");
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  async function start() {
    if (!ready || !manifest || active.current || !permitted(manifest)) return;
    const controller = new AbortController();
    active.current = controller;
    setStatus("importing");
    try {
      const result = await importSpackUpstream(manifest, controller.signal);
      if (!live(controller) || !permitted(manifest)) return;
      setStatus("succeeded");
      try {
        await onImported(result);
      } catch {
        // A view refresh failure must not obscure a confirmed successful import.
        if (live(controller)) setRefreshFailed(true);
      }
    } catch (error) {
      if (live(controller)) {
        const rejected =
          error instanceof SoftwareError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408 &&
          error.code !== "UPSTREAM_IMPORT_RESULT_UNKNOWN" &&
          error.code !== "REGISTRY_INVALID_RESPONSE";
        setStatus(rejected ? "failed" : "unknown");
      }
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  function cancel() {
    if (!current()) return;
    active.current?.abort();
    active.current = null;
    setManifest(null);
    setStatus(status === "importing" ? "unknown" : "idle");
  }

  const visibleStatus = denied ? "denied" : status;
  const error = ["invalid", "denied", "failed", "unknown"].includes(visibleStatus);
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-2 border-y border-border py-3"
    >
      <h3 id={`${id}-title`} className="text-xs font-medium">
        {t(`spackOnline.${kind}Title`)}
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          className="sr-only"
          type="file"
          accept=".json,application/json"
          aria-label={t(`spackOnline.${kind}Manifest`)}
          disabled={busy}
          onChange={(event) => {
            void select(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="outline"
          title={t("spackOnline.chooseManifest")}
          aria-label={t("spackOnline.chooseManifest")}
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          <FileJson />
        </Button>
        <Button type="button" size="sm" disabled={!ready} onClick={() => void start()}>
          {status === "importing" ? <Loader2 className="animate-spin" /> : <Download />}
          {t(`spackOnline.${kind}Submit`)}
        </Button>
        {busy ? (
          <Button
            type="button"
            size="icon"
            variant="outline"
            title={t("spackOnline.cancel")}
            aria-label={t("spackOnline.cancel")}
            onClick={cancel}
          >
            <Square />
          </Button>
        ) : null}
      </div>
      {manifest ? (
        <p className="break-all text-xs text-muted-foreground">
          {destination(manifest)} ·{" "}
          {t("spackOnline.files", {
            count: manifest.kind === "recipe" ? 1 : manifest.files.length,
          })}
        </p>
      ) : null}
      {visibleStatus !== "idle" ? (
        <p
          role={error ? "alert" : "status"}
          className={`break-words text-xs ${error ? "text-status-failed" : ""}`}
        >
          {t(`spackOnline.${visibleStatus}`)}
        </p>
      ) : null}
      {refreshFailed ? (
        <p role="alert" className="text-xs text-status-failed">
          {t("spackOnline.refreshFailed")}
        </p>
      ) : null}
    </section>
  );
}

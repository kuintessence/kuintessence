import type { SpackMaterialBinding, SpackMaterialImport } from "@kuintessence/shared/browser";
import { Copy, Eye, Loader2, Square, Upload } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type MaterialImportProgress,
  MaterialPackError,
  MissingMaterialFiles,
  matchMaterialFiles,
  readMaterialPack,
  runMaterialImport,
} from "../../lib/spack-material-import";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

interface ImportRow {
  status: "queued" | MaterialImportProgress["status"];
  verifiedFiles: number;
  totalFiles: number;
  binding?: SpackMaterialBinding;
  publicationUnconfirmed?: boolean;
  error?: string;
}

export function MaterialPackImport({
  canWriteRepository,
  isCurrent,
  onInspect,
}: {
  canWriteRepository: (repository: string) => boolean;
  isCurrent: () => boolean;
  onInspect: (binding: SpackMaterialBinding) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [pack, setPack] = useState<SpackMaterialImport | null>(null);
  const [manifestName, setManifestName] = useState("");
  const [selection, setSelection] = useState<{
    files: File[];
    mode: "files" | "directory";
    retained?: ReadonlyMap<string, File>;
  }>({
    files: [],
    mode: "files",
  });
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [running, setRunning] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  const current = () => mounted.current && isCurrent();
  const initialRows = (value: SpackMaterialImport) =>
    value.releases.map(() => ({
      status: "queued" as const,
      verifiedFiles: 0,
      totalFiles: 0,
    }));
  const matched = useMemo<{ files: Map<string, File> } | { error: true } | null>(() => {
    if (!pack) return null;
    try {
      const files = matchMaterialFiles(pack, selection.files, selection.mode, manifestName);
      return { files: selection.retained ? new Map([...selection.retained, ...files]) : files };
    } catch {
      return { error: true as const };
    }
  }, [pack, selection, manifestName]);
  const pending = rows.flatMap((row, index) => (row.status === "published" ? [] : [index]));
  const denied = pack?.releases.some((release) => !canWriteRepository(release.repository)) ?? false;
  const ready =
    !!pack && !!matched && "files" in matched && !denied && confirmed && pending.length > 0;
  const published = rows.filter((row) => row.status === "published").length;
  const failed = rows.filter(
    (row) => row.status === "failed" && !row.publicationUnconfirmed,
  ).length;
  const uncertain = rows.filter((row) => row.publicationUnconfirmed).length;

  async function selectManifest(file: File | undefined) {
    if (!current() || running) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setPack(null);
    setRows([]);
    setConfirmed(false);
    setError(null);
    setReading(!!file);
    if (manifestName || !file) setSelection({ files: [], mode: "files" });
    setManifestName(file?.name ?? "");
    if (!file) {
      active.current = null;
      return;
    }
    try {
      const result = await readMaterialPack(file, controller.signal);
      if (current() && !controller.signal.aborted) {
        setPack(result);
        setRows(initialRows(result));
      }
    } catch {
      if (current() && !controller.signal.aborted) setError(t("materials.invalidManifest"));
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (current()) setReading(false);
      }
    }
  }

  function selectFiles(files: File[], mode: "files" | "directory") {
    if (!current() || running) return;
    setSelection((previous) => ({
      files,
      mode,
      retained: files.length ? previous.retained : undefined,
    }));
    setConfirmed(false);
    setError(null);
  }

  async function start() {
    if (!current() || active.current || !ready || !pack || !matched || !("files" in matched))
      return;
    const controller = new AbortController();
    active.current = controller;
    setRunning(true);
    setError(null);
    try {
      await runMaterialImport({
        pack,
        files: matched.files,
        indices: pending,
        signal: controller.signal,
        canWriteRepository: (repository) => current() && canWriteRepository(repository),
        onProgress: ({ index, error: failure, ...progress }) => {
          if (!current()) return;
          const safeError =
            failure && !(failure instanceof MissingMaterialFiles)
              ? toUserFacingError(failure, t("materials.itemFailed"))
              : undefined;
          setRows((previous) =>
            previous.map((row, rowIndex) =>
              rowIndex === index
                ? {
                    ...progress,
                    error: safeError,
                    // An earlier lost response stays uncertain until publication is confirmed.
                    publicationUnconfirmed:
                      progress.status !== "published" &&
                      (progress.status === "uncertain" || row.publicationUnconfirmed === true),
                  }
                : row,
            ),
          );
        },
      });
    } catch (failure) {
      if (current()) {
        if (controller.signal.aborted) setError(t("materials.stopped"));
        else if (failure instanceof MissingMaterialFiles) {
          setSelection({ files: [], mode: "files", retained: matched.files });
          setError(t("materials.missingFiles", { paths: failure.paths.join("\n") }));
        } else if (failure instanceof MaterialPackError) setError(t(`materials.${failure.code}`));
        else setError(toUserFacingError(failure, t("materials.itemFailed")));
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (current()) setRunning(false);
      }
    }
  }

  async function copy(binding: SpackMaterialBinding) {
    if (!current()) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(binding, null, 2));
    } catch {
      if (current()) setError(t("materials.copyFailed"));
    }
  }

  return (
    <div className="min-w-0 space-y-3 border-border py-3">
      <div className="grid min-w-0 gap-3 lg:grid-cols-3">
        <label htmlFor={`${id}-manifest`} className="min-w-0 space-y-1 text-xs font-medium">
          <span>{t("materials.manifestFile")}</span>
          <Input
            id={`${id}-manifest`}
            type="file"
            accept=".json"
            disabled={running}
            onChange={(event) => {
              void selectManifest(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
        <label htmlFor={`${id}-files`} className="min-w-0 space-y-1 text-xs font-medium">
          <span>{t("materials.files")}</span>
          <Input
            id={`${id}-files`}
            type="file"
            multiple
            disabled={running || reading}
            onChange={(event) => {
              selectFiles(Array.from(event.target.files ?? []), "files");
              event.target.value = "";
            }}
          />
        </label>
        <label htmlFor={`${id}-directory`} className="min-w-0 space-y-1 text-xs font-medium">
          <span>{t("materials.directory")}</span>
          <Input
            id={`${id}-directory`}
            type="file"
            multiple
            disabled={running || reading}
            ref={(element) => element?.setAttribute("webkitdirectory", "")}
            onChange={(event) => {
              selectFiles(Array.from(event.target.files ?? []), "directory");
              event.target.value = "";
            }}
          />
        </label>
      </div>
      {reading ? (
        <p role="status" className="text-xs">
          {t("materials.reading")}
        </p>
      ) : null}
      {pack ? (
        <p className="break-all text-xs text-muted-foreground">
          {manifestName} ·{" "}
          {t("materials.packSummary", {
            releases: pack.releases.length,
            files: pack.files.length,
            selected: matched && "files" in matched ? matched.files.size : selection.files.length,
          })}
        </p>
      ) : null}
      {matched && "error" in matched ? (
        <p role="alert" className="text-xs text-status-failed">
          {t("materials.invalidFiles")}
        </p>
      ) : null}
      {denied ? (
        <p role="alert" className="text-xs text-status-failed">
          {t("materials.accessChanged")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="whitespace-pre-line break-all text-xs text-status-failed">
          {error}
        </p>
      ) : null}
      {pack ? (
        <div className="overflow-x-auto">
          <Table
            className="w-full min-w-[36rem] table-fixed text-left text-xs"
            aria-label={t("materials.queue")}
          >
            <TableHeader className="border-b border-border text-muted-foreground">
              <TableRow>
                <TableHead className="w-[28%] p-2 font-medium">
                  {t("materials.repository")}
                </TableHead>
                <TableHead className="w-[32%] p-2 font-medium">{t("materials.release")}</TableHead>
                <TableHead className="p-2 font-medium">{t("materials.status")}</TableHead>
                <TableHead className="w-24 p-2 font-medium">{t("materials.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pack.releases.map((release, index) => {
                const row = rows[index];
                return (
                  <TableRow
                    key={JSON.stringify([
                      release.repository,
                      release.spec,
                      release.target,
                      release.spackVersion,
                    ])}
                    className="border-b border-border"
                  >
                    <TableCell className="break-all p-2 align-top font-mono">
                      {release.repository}
                    </TableCell>
                    <TableCell className="break-all p-2 align-top">
                      <div className="font-mono">{release.spec}</div>
                      <div className="text-muted-foreground">{release.target}</div>
                    </TableCell>
                    <TableCell className="break-words p-2 align-top" aria-live="polite">
                      {t(
                        `materials.${
                          row?.publicationUnconfirmed &&
                          row.status !== "uploading" &&
                          row.status !== "publishing"
                            ? "uncertain"
                            : (row?.status ?? "queued")
                        }`,
                      )}
                      {row?.publicationUnconfirmed &&
                      (row.status === "uploading" || row.status === "publishing") ? (
                        <div>{t("materials.uncertain")}</div>
                      ) : null}
                      {row?.status === "uploading" ? (
                        <div>
                          {row.verifiedFiles} / {row.totalFiles}
                        </div>
                      ) : null}
                      {row?.error && row.status === "failed" ? (
                        <div className="text-status-failed">{row.error}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="p-2 align-top">
                      {row?.binding ? (
                        <div className="flex">
                          <Button
                            size="icon"
                            variant="ghost"
                            title={t("materials.inspect")}
                            aria-label={t("materials.inspect")}
                            onClick={() => row.binding && onInspect(row.binding)}
                          >
                            <Eye />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title={t("materials.copyBinding")}
                            aria-label={t("materials.copyBinding")}
                            onClick={() => row.binding && void copy(row.binding)}
                          >
                            <Copy />
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
          checked={confirmed}
          disabled={running || !pack}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>{t("materials.redistribution")}</span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={!ready || running || reading} onClick={() => void start()}>
          {running ? <Loader2 className="animate-spin" /> : <Upload />}
          {t(published + failed + uncertain > 0 ? "materials.retry" : "materials.import")}
        </Button>
        {running ? (
          <Button
            size="icon"
            variant="outline"
            title={t("materials.stop")}
            aria-label={t("materials.stop")}
            onClick={() => active.current?.abort()}
          >
            <Square />
          </Button>
        ) : null}
        {rows.some((row) => row.status !== "queued") ? (
          <p role="status" className="text-xs">
            {t("materials.resultSummary", { published, failed, uncertain })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

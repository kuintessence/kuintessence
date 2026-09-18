import { type RecipeRepository, RecipeRepositoryNameSchema } from "@kuintessence/shared/browser";
import { Loader2, Upload, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { importRecipeRepository } from "../../lib/recipe-repositories-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface ImportItem {
  id: number;
  file: File;
  repository: string;
  status: "queued" | "uploadingItem" | "succeeded" | "failed";
  error?: string;
}

function validDestination(value: string) {
  return /^(public|org)\//.test(value) && RecipeRepositoryNameSchema.safeParse(value).success;
}

export function RecipeBundleImport({
  organizationId,
  canWriteRepository,
  onImported,
}: {
  organizationId: string | null;
  canWriteRepository: (repository: string) => boolean;
  onImported: (repository: RecipeRepository) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ImportItem[]>([]);
  const [fileError, setFileError] = useState(false);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const mounted = useRef(true);
  const fileInputId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pending = items.filter((item) => item.status !== "succeeded");
  const ready =
    pending.length > 0 &&
    pending.every(
      (item) => validDestination(item.repository) && canWriteRepository(item.repository),
    );
  const success = items.filter((item) => item.status === "succeeded").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const duplicateDestination = new Set(items.map((item) => item.repository)).size < items.length;

  function patchItem(id: number, patch: Partial<ImportItem>) {
    if (!mounted.current) return;
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function upload() {
    if (!ready || runningRef.current || fileError) return;
    runningRef.current = true;
    setRunning(true);
    try {
      for (const item of pending) {
        if (!mounted.current || !canWriteRepository(item.repository)) break;
        patchItem(item.id, { status: "uploadingItem", error: undefined });
        try {
          const result = await importRecipeRepository(item.repository, item.file);
          await onImported(result);
          patchItem(item.id, { status: "succeeded" });
        } catch (error) {
          patchItem(item.id, {
            status: "failed",
            error: toUserFacingError(error, t("recipes.importFailed")),
          });
        }
      }
    } finally {
      runningRef.current = false;
      if (mounted.current) setRunning(false);
    }
  }

  return (
    <div className="space-y-2 border-y border-border py-3">
      <label htmlFor={fileInputId} className="block space-y-1 text-xs font-medium">
        <span>{t("recipes.files")}</span>
        <Input
          id={fileInputId}
          type="file"
          accept=".bundle"
          multiple
          disabled={running}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            const invalid = files.some(
              (file) => !file.name.toLowerCase().endsWith(".bundle") || file.size === 0,
            );
            setFileError(invalid);
            setItems(
              invalid
                ? []
                : files.map((file, id) => ({
                    id,
                    file,
                    repository: `${organizationId ? `org/${organizationId}` : "public"}/${file.name
                      .slice(0, -7)
                      .toLowerCase()
                      .replace(/[^a-z0-9._-]/g, "-")}`,
                    status: "queued",
                  })),
            );
            event.target.value = "";
          }}
        />
      </label>
      {items.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("recipes.selectedFiles", { count: items.length })}
        </p>
      ) : null}
      {fileError ? (
        <p role="alert" className="text-xs text-status-failed">
          {t("recipes.invalidFile")}
        </p>
      ) : null}
      {duplicateDestination ? (
        <p className="text-xs text-status-pending">{t("recipes.duplicateDestination")}</p>
      ) : null}
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li
            key={item.id}
            className="grid min-w-0 gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
          >
            <span className="break-all text-xs">{item.file.name}</span>
            <div className="min-w-0 space-y-1">
              <Input
                aria-label={t("recipes.namespace", { file: item.file.name })}
                value={item.repository}
                placeholder={t("recipes.namespaceHint")}
                disabled={running || item.status === "succeeded"}
                aria-invalid={
                  !validDestination(item.repository) || !canWriteRepository(item.repository)
                }
                onChange={(event) =>
                  patchItem(item.id, {
                    repository: event.target.value,
                    status: "queued",
                    error: undefined,
                  })
                }
              />
              {!validDestination(item.repository) ? (
                <p className="text-xs text-status-failed">{t("recipes.invalidNamespace")}</p>
              ) : !canWriteRepository(item.repository) ? (
                <p className="text-xs text-status-failed">{t("recipes.readOnlyDestination")}</p>
              ) : null}
              {item.error ? (
                <p role="alert" className="text-xs text-status-failed">
                  {item.error}
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs" aria-live="polite">
                {t(`recipes.${item.status}`)}
              </span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title={t("recipes.remove", { file: item.file.name })}
                aria-label={t("recipes.remove", { file: item.file.name })}
                disabled={running}
                onClick={() =>
                  setItems((current) => current.filter((entry) => entry.id !== item.id))
                }
              >
                <X />
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          disabled={!ready || running || fileError}
          onClick={() => void upload()}
        >
          {running ? <Loader2 className="animate-spin" /> : <Upload />}
          {t(running ? "recipes.uploading" : "recipes.import")}
        </Button>
        {!running && success + failed > 0 ? (
          <p role="status" className="text-xs">
            {t("recipes.importSummary", { success, failed })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

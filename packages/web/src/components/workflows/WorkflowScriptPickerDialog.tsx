import { Check, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SandboxScriptAsset } from "../../lib/sandbox-client";
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

type LanguageFilter = "all" | "python" | "nodejs" | "bash";

export function WorkflowScriptPickerDialog({
  busy,
  error,
  loading,
  onApply,
  onOpenChange,
  open,
  scripts,
}: {
  busy: boolean;
  error: boolean;
  loading: boolean;
  onApply: (script: SandboxScriptAsset) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  scripts: SandboxScriptAsset[];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState<LanguageFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return scripts.filter((script) => {
      const matchesLanguage = language === "all" || script.payload.language === language;
      const matchesQuery =
        needle.length === 0 ||
        [
          script.name,
          script.version,
          script.payload.entrypoint,
          ...Object.keys(script.payload.inputs),
          ...Object.keys(script.payload.outputs),
        ].some((value) => value.toLowerCase().includes(needle));
      return matchesLanguage && matchesQuery;
    });
  }, [language, query, scripts]);
  const selected = scripts.find((script) => script.id === selectedId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(86vh,820px)] w-[min(calc(100vw-1rem),1040px)]"
        data-testid="workflow-script-picker-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("workflow.editor.scriptPicker.title")}</DialogTitle>
          <DialogDescription>{t("workflow.editor.scriptPicker.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px]">
            <div className="relative min-w-0">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("workflow.editor.scriptPicker.search")}
                className="pl-8"
                data-testid="workflow-script-search"
              />
            </div>
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value as LanguageFilter)}
              aria-label={t("sandbox.catalog.language")}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              data-testid="workflow-script-language-filter"
            >
              <option value="all">{t("sandbox.catalog.allLanguages")}</option>
              <option value="python">Python</option>
              <option value="nodejs">Node.js</option>
              <option value="bash">Bash</option>
            </select>
          </div>
          <div className="grid min-h-72 flex-1 auto-rows-max content-start gap-3 overflow-auto rounded-md border border-border bg-background p-2 sm:grid-cols-2 lg:grid-cols-3">
            {loading ? (
              <PickerState text={t("common.loading")} />
            ) : error ? (
              <PickerState failed text={t("workflow.editor.scriptPicker.loadFailed")} />
            ) : filtered.length === 0 ? (
              <PickerState text={t("workflow.editor.scriptPicker.empty")} />
            ) : (
              filtered.map((script) => {
                const active = selectedId === script.id;
                return (
                  <button
                    key={script.id}
                    type="button"
                    onClick={() => setSelectedId(script.id)}
                    onDoubleClick={() => onApply(script)}
                    className={`min-h-40 min-w-0 rounded-md border bg-card p-3 text-left transition-colors hover:border-brand/50 hover:bg-muted/30 ${
                      active ? "border-brand ring-1 ring-brand/40" : "border-border"
                    }`}
                    data-testid={`workflow-script-option-${script.id}`}
                    aria-pressed={active}
                    title={t("workflow.editor.scriptPicker.doubleClickHint")}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{script.name}</span>
                      {active ? <Check className="h-4 w-4 shrink-0 text-brand" /> : null}
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {script.payload.entrypoint}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-1">
                      <Badge variant="brand">{script.payload.language}</Badge>
                      <Badge variant="outline">v{script.version}</Badge>
                      <Badge variant="outline">{script.lifecycle}</Badge>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                      <span>
                        {t("sandbox.catalog.inputs")}: {Object.keys(script.payload.inputs).length}
                      </span>
                      <span>
                        {t("sandbox.catalog.outputs")}: {Object.keys(script.payload.outputs).length}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </DialogBody>
        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {selected
              ? t("workflow.editor.scriptPicker.pendingSelection", { name: selected.name })
              : t("workflow.editor.scriptPicker.noSelection")}
          </span>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!selected || busy}
              onClick={() => {
                if (selected) onApply(selected);
              }}
              data-testid="workflow-script-apply"
            >
              {busy ? t("common.loading") : t("workflow.editor.scriptPicker.add")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PickerState({ failed = false, text }: { failed?: boolean; text: string }) {
  return (
    <div
      className={`rounded-md border bg-card p-4 text-sm ${
        failed
          ? "border-status-failed/40 text-status-failed"
          : "border-border text-muted-foreground"
      }`}
    >
      {text}
    </div>
  );
}

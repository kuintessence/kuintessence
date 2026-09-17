import { Check, Sparkles } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { parseWorkflowYaml } from "../../lib/workflow-parser";
import { TEMPLATES, type WorkflowTemplate } from "./templates";

export interface TemplateGalleryProps {
  onPick: (yaml: string) => void;
  selectedYaml?: string;
}

function selectedTemplate(yaml: string | undefined): WorkflowTemplate | null {
  if (!yaml) return null;
  const exact = TEMPLATES.find((template) => template.yaml === yaml);
  if (exact) return exact;
  const parsed = parseWorkflowYaml(yaml);
  if (!parsed.ok) return null;
  return (
    TEMPLATES.find((template) => {
      const templateParsed = parseWorkflowYaml(template.yaml);
      return templateParsed.ok && templateParsed.workflow.name === parsed.workflow.name;
    }) ?? null
  );
}

export function TemplateGallery({ onPick, selectedYaml }: TemplateGalleryProps) {
  const { t } = useTranslation();
  const selected = useMemo(() => selectedTemplate(selectedYaml), [selectedYaml]);

  return (
    <div
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
      data-testid="template-gallery"
    >
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 shrink-0 text-brand" />
            <span>{t("workflows.templates.title")}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("workflows.templates.pickHint", {
              defaultValue: "Pick a base graph, then tune YAML and visual nodes together.",
            })}
          </p>
        </div>
        <span
          className="min-w-0 truncate rounded-full border border-border bg-background px-3 py-1 font-mono text-[11px] text-muted-foreground"
          data-testid="template-selected"
          title={selected?.name ?? t("workflows.templates.custom")}
        >
          {selected
            ? t("workflows.templates.selected", { name: selected.name })
            : t("workflows.templates.custom")}
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1" data-testid="template-strip">
        {TEMPLATES.map((template) => {
          const active = selected?.slug === template.slug;
          return (
            <button
              type="button"
              key={template.slug}
              data-testid={`template-${template.slug}`}
              onClick={() => onPick(template.yaml)}
              className={cn(
                "flex min-h-24 w-[17rem] shrink-0 flex-col items-start rounded-lg border bg-background p-3 text-left transition-colors hover:border-brand/70 hover:bg-brand-soft/30 sm:w-[20rem]",
                active ? "border-brand bg-brand-soft/40 ring-1 ring-brand" : "border-border",
              )}
              aria-pressed={active}
            >
              <span className="flex w-full items-center justify-between gap-2 text-sm font-semibold">
                <span className="truncate">{template.name}</span>
                {active ? <Check className="h-3.5 w-3.5 shrink-0 text-brand" /> : null}
              </span>
              <span className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                {template.blurb}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

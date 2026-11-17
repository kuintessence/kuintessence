import { Blocks, LayoutTemplate } from "lucide-react";
import { useTranslation } from "react-i18next";

export function WorkflowStartOverlay({
  onScratch,
  onTemplate,
}: {
  onScratch: () => void;
  onTemplate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-h-64 items-start justify-center rounded-xl border border-border bg-card p-4 sm:min-h-80 sm:items-center"
      data-testid="workflow-start-overlay"
    >
      <div className="w-full max-w-lg p-2 sm:p-7">
        <div className="text-center">
          <h3 className="text-xl font-semibold">{t("workflows.creation.start.title")}</h3>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={onScratch}
            className="flex items-center gap-3 rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-brand hover:bg-brand-soft/40 focus-visible:outline-2 focus-visible:outline-ring"
            data-testid="workflow-start-scratch"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-soft text-brand">
              <Blocks className="h-5 w-5" />
            </span>
            <span className="font-semibold">{t("workflows.creation.start.scratchTitle")}</span>
          </button>
          <button
            type="button"
            onClick={onTemplate}
            className="flex items-center gap-3 rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-brand hover:bg-brand-soft/40 focus-visible:outline-2 focus-visible:outline-ring"
            data-testid="workflow-start-template"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-soft text-brand">
              <LayoutTemplate className="h-5 w-5" />
            </span>
            <span className="font-semibold">{t("workflows.creation.start.templateTitle")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

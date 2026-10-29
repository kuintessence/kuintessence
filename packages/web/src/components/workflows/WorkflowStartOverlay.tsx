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
      className="absolute inset-0 z-30 flex items-center justify-center rounded-xl bg-background/85 p-4 backdrop-blur-sm"
      data-testid="workflow-start-overlay"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-xl sm:p-7">
        <div className="text-center">
          <h3 className="text-xl font-semibold">{t("workflows.creation.start.title")}</h3>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
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

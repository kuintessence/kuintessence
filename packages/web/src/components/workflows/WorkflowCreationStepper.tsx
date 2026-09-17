import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

export type WorkflowCreationStep = "edit" | "inputs" | "resources" | "review";

const STEPS: WorkflowCreationStep[] = ["edit", "inputs", "resources", "review"];

export function WorkflowCreationStepper({
  blocked = false,
  current,
  embedded = false,
  onChange,
}: {
  blocked?: boolean;
  current: WorkflowCreationStep;
  embedded?: boolean;
  onChange: (step: WorkflowCreationStep) => void;
}) {
  const { t } = useTranslation();
  const currentIndex = STEPS.indexOf(current);

  return (
    <nav
      aria-label={t("workflows.creation.stepsLabel")}
      className={cn(
        "grid overflow-hidden bg-card md:grid-cols-4",
        embedded ? "border-t border-border" : "rounded-xl border border-border shadow-sm",
      )}
      data-testid="workflow-creation-steps"
    >
      {STEPS.map((step, index) => {
        const active = step === current;
        const complete = index < currentIndex;
        return (
          <button
            key={step}
            type="button"
            aria-current={active ? "step" : undefined}
            disabled={blocked}
            onClick={() => onChange(step)}
            className={cn(
              "flex min-w-0 items-center gap-3 border-border px-4 py-3 text-left transition-colors md:border-l md:first:border-l-0",
              active ? "bg-brand-soft text-brand" : "hover:bg-muted/50",
              blocked && "cursor-not-allowed opacity-55 hover:bg-transparent",
            )}
            data-testid={`workflow-step-${step}`}
          >
            <span
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                active || complete
                  ? "border-brand bg-brand text-white"
                  : "border-border bg-background text-muted-foreground",
              )}
            >
              {complete ? <Check className="h-4 w-4" /> : index + 1}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {t(`workflows.creation.steps.${step}.title`)}
              </span>
              <span className="mt-0.5 hidden truncate text-xs text-muted-foreground lg:block">
                {t(`workflows.creation.steps.${step}.description`)}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

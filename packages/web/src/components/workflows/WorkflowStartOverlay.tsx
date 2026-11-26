import { Blocks, LayoutTemplate } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

export function WorkflowStartOverlay({
  onScratch,
  onTemplate,
}: {
  onScratch: () => void;
  onTemplate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full max-w-lg py-4 sm:py-8" data-testid="workflow-start-overlay">
      <h2 className="text-lg font-semibold">{t("workflows.creation.start.title")}</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Button
          variant="outline"
          type="button"
          onClick={onScratch}
          className="h-auto min-h-12 justify-start gap-3 whitespace-normal py-2 text-left"
          data-testid="workflow-start-scratch"
        >
          <Blocks className="text-brand" />
          <span className="font-semibold">{t("workflows.creation.start.scratchTitle")}</span>
        </Button>
        <Button
          variant="outline"
          type="button"
          onClick={onTemplate}
          className="h-auto min-h-12 justify-start gap-3 whitespace-normal py-2 text-left"
          data-testid="workflow-start-template"
        >
          <LayoutTemplate className="text-brand" />
          <span className="font-semibold">{t("workflows.creation.start.templateTitle")}</span>
        </Button>
      </div>
    </div>
  );
}

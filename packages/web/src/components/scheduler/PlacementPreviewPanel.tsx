import type { JobSubmit } from "@kuintessence/shared/browser";
import { Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePlacementPreview } from "../../lib/use-placement-preview";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { PlacementPipelineView } from "./PlacementPipelineView";

/**
 * pre-submit placement preview panel.
 *
 * Wraps the `usePlacementPreview` mutation and the `PlacementPipelineView`
 * stepper. Callers (the SubmitJobDialog) pass the latest user-edited job
 * spec via `getJobSpec`, plus a flag controlling whether the panel is
 * allowed to fire (e.g. don't preview an obviously-empty form).
 *
 * The panel intentionally does NOT auto-refresh on every keystroke —
 * placement runs server-side filters that may be expensive, so the user
 * explicitly clicks "Refresh preview" when they want a new trace.
 */
export interface PlacementPreviewPanelProps {
  /** Returns the current draft job spec, or null when the form is invalid. */
  getJobSpec: () => JobSubmit | null | Promise<JobSubmit | null>;
  canPreview?: boolean;
  /** Optional click handler to drill into a specific agent. */
  onAgentPick?: (agentId: string) => void;
}

export function PlacementPreviewPanel({
  canPreview = true,
  getJobSpec,
  onAgentPick,
}: PlacementPreviewPanelProps) {
  const { t } = useTranslation();
  const { trace, isLoading, error, refresh } = usePlacementPreview();

  async function handleRefresh() {
    const job = await getJobSpec();
    if (!job) return;
    try {
      await refresh(job);
    } catch {
      // Error surfaces below via `error`.
    }
  }

  const errorMessage = error
    ? toUserFacingError(
        error,
        t("scheduler.placement.preview.loadFailed", {
          defaultValue: "暂时无法生成调度预览，请稍后重试。",
        }),
      )
    : null;

  return (
    <div className="space-y-2" data-testid="placement-preview-panel">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {t("scheduler.placement.preview.title", { defaultValue: "Placement preview" })}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("scheduler.placement.preview.subtitle", {
              defaultValue: "Run the queue-aware placement pipeline against this draft.",
            })}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full sm:w-auto"
          onClick={handleRefresh}
          disabled={isLoading || !canPreview}
          data-testid="placement-preview-refresh"
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span className="ml-1.5">
            {t("scheduler.placement.preview.button", { defaultValue: "Refresh preview" })}
          </span>
        </Button>
      </div>

      {errorMessage ? (
        <div
          className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_8%,transparent)] p-2 text-xs text-status-failed"
          role="alert"
          data-testid="placement-preview-error"
        >
          {errorMessage}
        </div>
      ) : null}

      <PlacementPipelineView trace={trace} onAgentPick={onAgentPick} />
    </div>
  );
}

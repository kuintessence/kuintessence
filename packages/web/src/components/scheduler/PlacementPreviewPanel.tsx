import type { JobSubmit } from "@kuintessence/shared/browser";
import { Loader2, SearchCheck } from "lucide-react";
import { useState } from "react";
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
 * explicitly clicks "Check available resources" when they want a new trace.
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

  const [checkedDraft, setCheckedDraft] = useState<{
    getJobSpec: PlacementPreviewPanelProps["getJobSpec"];
  } | null>(null);
  const visibleTrace = checkedDraft?.getJobSpec === getJobSpec ? trace : null;
  const [preparing, setPreparing] = useState(false);
  const [preparationError, setPreparationError] = useState<unknown>(null);
  async function handleRefresh() {
    setPreparationError(null);
    setCheckedDraft({ getJobSpec });
    setPreparing(true);
    try {
      const job = await getJobSpec();
      if (job) await refresh(job);
    } catch (failure) {
      setPreparationError(failure);
    } finally {
      setPreparing(false);
    }
  }

  const failure = preparationError ?? error;
  const errorMessage = failure
    ? toUserFacingError(
        failure,
        t("scheduler.placement.preview.loadFailed", {
          defaultValue: "暂时无法生成调度预览，请稍后重试。",
        }),
      )
    : null;

  return (
    <div className="space-y-2" data-testid="placement-preview-panel">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full sm:w-auto"
        onClick={handleRefresh}
        disabled={preparing || isLoading || !canPreview}
        data-testid="placement-preview-refresh"
      >
        {preparing || isLoading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <SearchCheck className="h-3.5 w-3.5" />
        )}
        <span className="ml-1.5">
          {t("scheduler.placement.preview.button", { defaultValue: "Check available resources" })}
        </span>
      </Button>

      {errorMessage ? (
        <div
          className=" p-2 text-xs text-status-failed"
          role="alert"
          data-testid="placement-preview-error"
        >
          {errorMessage}
        </div>
      ) : null}

      {!preparing && visibleTrace?.federation ? (
        <dl className="grid gap-3 py-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t("federation.clusters.clusterName")}</dt>
            <dd className="mt-1 break-words font-medium">{visibleTrace.federation.clusterName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("federation.clusters.profileName")}</dt>
            <dd className="mt-1 break-words">{visibleTrace.federation.profileName}</dd>
          </div>
        </dl>
      ) : !preparing && visibleTrace ? (
        <PlacementPipelineView trace={visibleTrace} onAgentPick={onAgentPick} />
      ) : null}
    </div>
  );
}

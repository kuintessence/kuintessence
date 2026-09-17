import type { PlacementStageResult, PlacementTrace } from "@kuintessence/shared/browser";
import { ChevronDown, ChevronRight, Trophy, XCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

/**
 * Read-only stepper that explains placement decisions.
 *
 * The component renders the canonical pipeline stages as a vertical list.
 * Each row shows the per-stage pass/reject counts and lets the user expand
 * the rejection list inline, with a one-line reason per agent. The final
 * decision (if any) is highlighted at the top so the user can see at a
 * glance who won the placement.
 */

const STAGE_ORDER = [
  "compute-health",
  "permission",
  "queue",
  "software",
  "billing",
  "load",
  "urgency",
  "install-rights",
  "manual",
  "auto",
] as const;

function placementReason(reason: string, t: ReturnType<typeof useTranslation>["t"]): string {
  const normalized = reason.trim();
  const operational =
    /^(agent (?:is not bound|denied|not in)|schedulerType .* does not match|missing software:|(?:guest role|user (?:quota|lacks)|org quota)|agent (?:CPU|at concurrency limit)|cpus .* > limit|memoryMb .* > limit|wallTime > limit|compute health (?:reports unavailable|is unknown|report is stale|report is invalid)|.*\b\d+%)/i.test(
      normalized,
    );
  if (operational && !/(?:error|exception|stderr|stack|password|token|secret)/i.test(normalized)) {
    return normalized;
  }
  return t("scheduler.placement.rejected.generic", {
    defaultValue: "该计算节点未通过此阶段筛选，请调整资源或队列约束后重试。",
  });
}

export interface PlacementPipelineViewProps {
  /** When null the empty/preview-prompt state is rendered instead. */
  trace: PlacementTrace | null;
  /** Optional click handler for picking a specific agent (e.g. drill-into agent detail). */
  onAgentPick?: (agentId: string) => void;
  /** Optional override for the heading shown above the stepper. */
  emptyMessage?: string;
}

export function PlacementPipelineView({
  trace,
  onAgentPick,
  emptyMessage,
}: PlacementPipelineViewProps) {
  const { t } = useTranslation();

  if (!trace) {
    return (
      <div
        className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
        data-testid="placement-empty"
      >
        {emptyMessage ??
          t("scheduler.placement.preview.empty", {
            defaultValue: "Run preview to see how your job will be placed.",
          })}
      </div>
    );
  }

  // Sort stages by canonical order; a malformed trace simply renders the
  // stages it contains without crashing.
  const ordered = [...trace.stages].sort((a, b) => {
    const aIdx = STAGE_ORDER.indexOf(a.name as (typeof STAGE_ORDER)[number]);
    const bIdx = STAGE_ORDER.indexOf(b.name as (typeof STAGE_ORDER)[number]);
    return aIdx - bIdx;
  });

  return (
    <div className="space-y-3" data-testid="placement-pipeline">
      <FinalDecisionBanner trace={trace} onAgentPick={onAgentPick} />
      <ol className="space-y-2" data-testid="placement-stages">
        {ordered.map((stage, idx) => (
          <StageRow
            key={stage.name}
            index={idx + 1}
            stage={stage}
            onAgentPick={onAgentPick}
            highlightAgentId={trace.finalDecision?.agentId ?? null}
          />
        ))}
      </ol>
    </div>
  );
}

function FinalDecisionBanner({
  trace,
  onAgentPick,
}: {
  trace: PlacementTrace;
  onAgentPick?: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  if (!trace.finalDecision) {
    return (
      <div
        className="flex items-start gap-3 rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
        data-testid="placement-no-decision"
      >
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-failed" />
        <div>
          <div className="font-medium">
            {t("scheduler.placement.noDecision.title", {
              defaultValue: "No agent passed the placement pipeline",
            })}
          </div>
          <div className="text-muted-foreground">
            {t("scheduler.placement.noDecision.body", {
              defaultValue: "Expand the stages below to see which filter rejected each candidate.",
            })}
          </div>
        </div>
      </div>
    );
  }
  const id = trace.finalDecision.agentId;
  return (
    <button
      type="button"
      onClick={onAgentPick ? () => onAgentPick(id) : undefined}
      disabled={!onAgentPick}
      className={cn(
        "flex w-full flex-wrap items-center gap-3 rounded-md border border-status-succeeded/40 bg-[color-mix(in_oklab,var(--status-succeeded)_12%,transparent)] p-3 text-left text-sm",
        onAgentPick
          ? "hover:bg-[color-mix(in_oklab,var(--status-succeeded)_18%,transparent)]"
          : "cursor-default",
      )}
      data-testid="placement-final-decision"
    >
      <Trophy className="h-4 w-4 shrink-0 text-status-succeeded" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {t("scheduler.placement.finalDecision.label", { defaultValue: "Final decision" })}:{" "}
          <span className="break-all font-mono">{id}</span>
        </div>
        {trace.finalDecision.siteName ? (
          <div className="text-xs text-muted-foreground">{trace.finalDecision.siteName}</div>
        ) : null}
      </div>
      {typeof trace.finalDecision.score === "number" ? (
        <Badge variant="succeeded">
          {t("scheduler.placement.score", { defaultValue: "score" })}{" "}
          {trace.finalDecision.score.toFixed(0)}
        </Badge>
      ) : null}
    </button>
  );
}

function StageRow({
  index,
  stage,
  onAgentPick,
  highlightAgentId,
}: {
  index: number;
  stage: PlacementStageResult;
  onAgentPick?: (agentId: string) => void;
  highlightAgentId: string | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(stage.rejected.length > 0);

  const passedCount = stage.passed.length;
  const rejectedCount = stage.rejected.length;
  const everyoneDropped = rejectedCount > 0 && passedCount === 0;

  return (
    <li
      className={cn(
        "rounded-md border bg-card",
        everyoneDropped ? "border-status-failed/40" : "border-border",
      )}
      data-testid={`placement-stage-${stage.name}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full flex-wrap items-center gap-3 p-3 text-left text-sm"
        aria-expanded={expanded}
        data-testid={`placement-stage-toggle-${stage.name}`}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {String(index).padStart(2, "0")}
        </span>
        <span className="min-w-0 flex-1 font-medium">
          {t(`scheduler.placement.stages.${stage.name}`, { defaultValue: stage.name })}
        </span>
        <span className="flex flex-wrap justify-end gap-1.5">
          <Badge variant="default">
            {t("scheduler.placement.input.label", { defaultValue: "in" })}: {stage.inputCount}
          </Badge>
          <Badge variant="succeeded">
            {t("scheduler.placement.passed.label", { defaultValue: "passed" })}: {passedCount}
          </Badge>
          <Badge variant={rejectedCount > 0 ? "failed" : "outline"}>
            {t("scheduler.placement.rejected.label", { defaultValue: "rejected" })}: {rejectedCount}
          </Badge>
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-border p-3 space-y-2">
          {rejectedCount === 0 && passedCount === 0 ? (
            <div className="text-xs text-muted-foreground">
              {t("scheduler.placement.stage.skipped", {
                defaultValue: "No candidates entered this stage.",
              })}
            </div>
          ) : null}
          {rejectedCount > 0 ? (
            <div className="space-y-1" data-testid={`placement-rejected-${stage.name}`}>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("scheduler.placement.rejected.heading", { defaultValue: "Rejected" })}
              </div>
              <ul className="space-y-1">
                {stage.rejected.map((r) => (
                  <li
                    key={`${stage.name}-${r.agent.agentId}`}
                    className="flex items-start gap-2 rounded border border-status-failed/30 bg-[color-mix(in_oklab,var(--status-failed)_8%,transparent)] p-2 text-xs"
                    data-testid={`placement-rejected-row-${r.agent.agentId}`}
                  >
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-failed" />
                    <div className="flex-1 space-y-0.5">
                      <button
                        type="button"
                        onClick={onAgentPick ? () => onAgentPick(r.agent.agentId) : undefined}
                        disabled={!onAgentPick}
                        className={cn(
                          "font-mono text-xs",
                          onAgentPick ? "underline-offset-2 hover:underline" : "cursor-default",
                        )}
                      >
                        {r.agent.agentId}
                      </button>
                      <div className="text-muted-foreground">{placementReason(r.reason, t)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {passedCount > 0 ? (
            <div className="space-y-1" data-testid={`placement-passed-${stage.name}`}>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("scheduler.placement.passed.heading", { defaultValue: "Passed" })}
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {stage.passed.map((a) => (
                  <li key={`${stage.name}-pass-${a.agentId}`}>
                    <button
                      type="button"
                      onClick={onAgentPick ? () => onAgentPick(a.agentId) : undefined}
                      disabled={!onAgentPick}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px]",
                        a.agentId === highlightAgentId
                          ? "border-status-succeeded/50 bg-[color-mix(in_oklab,var(--status-succeeded)_15%,transparent)]"
                          : "border-border",
                        onAgentPick ? "hover:bg-muted" : "cursor-default",
                      )}
                      data-testid={`placement-passed-row-${a.agentId}`}
                    >
                      {a.agentId === highlightAgentId ? (
                        <Trophy className="h-3 w-3 text-status-succeeded" />
                      ) : null}
                      <span>{a.agentId}</span>
                      {typeof a.score === "number" ? (
                        <span className="text-muted-foreground">·{a.score.toFixed(0)}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

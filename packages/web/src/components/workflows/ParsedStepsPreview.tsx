import { Boxes, CircleAlert, GitBranch } from "lucide-react";
import type { ParseResult } from "../../lib/workflow-parser";
import { summarize } from "../../lib/workflow-parser";

export interface ParsedStepsPreviewProps {
  result: ParseResult | null;
}

export function ParsedStepsPreview({ result }: ParsedStepsPreviewProps) {
  if (!result) {
    return (
      <div
        className="flex h-28 items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 px-4 text-center text-xs text-muted-foreground"
        data-testid="parsed-empty"
      >
        Edit the YAML on the left to see parsed nodes.
      </div>
    );
  }
  if (!result.ok) {
    return (
      <div
        className="rounded-lg border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-4 text-sm"
        data-testid="parsed-error"
      >
        <div className="flex items-center gap-2 font-medium">
          <CircleAlert className="h-4 w-4 text-[var(--status-failed)]" />
          {result.message}
        </div>
        {result.issues ? (
          <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {result.issues.slice(0, 6).map((iss) => (
              <li key={`${iss.path.join(".")}::${iss.message}`}>
                <code>{iss.path.join(".") || "(root)"}</code>: {iss.message}
              </li>
            ))}
            {result.issues.length > 6 ? (
              <li className="italic">…and {result.issues.length - 6} more</li>
            ) : null}
          </ul>
        ) : null}
      </div>
    );
  }
  const summary = summarize(result.workflow);
  return (
    <div className="space-y-3" data-testid="parsed-summary">
      <div className="grid grid-cols-2 gap-2">
        <Counter icon={Boxes} label="Nodes" value={summary.nodeCount} />
        <Counter icon={GitBranch} label="Edges" value={summary.edgeCount} />
      </div>
      <div>
        <div className="text-xs font-medium text-muted-foreground">Parsed nodes</div>
        <ul className="mt-1 space-y-1">
          {result.workflow.spec.nodeDrafts.map((n) => (
            <li key={n.id} className="rounded-lg border border-border bg-card px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{n.name || n.id}</span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {n.type}
                </span>
              </div>
              {n.when ? (
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  when: {n.when.expr}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface CounterProps {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}

function Counter({ icon: Icon, label, value }: CounterProps) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-center">
      <div className="flex items-center justify-center gap-1 text-[10px] font-medium text-muted-foreground">
        {Icon ? <Icon className="h-3 w-3" /> : null}
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

export interface StatCardProps {
  title: string;
  value: ReactNode;
  hint?: string;
  icon: LucideIcon;
  tone?: "default" | "running" | "succeeded" | "failed";
  testId?: string;
}

const toneClasses: Record<NonNullable<StatCardProps["tone"]>, string> = {
  default: "text-muted-foreground",
  running: "text-[var(--status-running)]",
  succeeded: "text-[var(--status-succeeded)]",
  failed: "text-[var(--status-failed)]",
};

export function StatCard({
  title,
  value,
  hint,
  icon: Icon,
  tone = "default",
  testId,
}: StatCardProps) {
  return (
    <Card data-testid={testId} className="flex min-w-0 flex-col">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 p-3 pb-1 sm:p-4 sm:pb-2">
        <CardTitle>{title}</CardTitle>
        <Icon className={cn("h-4 w-4 shrink-0", toneClasses[tone])} aria-hidden />
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-end p-3 pt-1 sm:p-4 sm:pt-2">
        <div
          className="text-2xl font-semibold tracking-tight tabular-nums"
          data-testid={testId ? `${testId}-value` : undefined}
        >
          {value}
        </div>
        {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

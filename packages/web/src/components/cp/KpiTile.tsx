import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

export interface KpiTileProps {
  title: string;
  titleSuffix?: string;
  value: ReactNode;
  hint?: string;
  icon?: LucideIcon;
  tone?: "default" | "running" | "succeeded" | "failed";
  testId?: string;
}

const toneClasses: Record<NonNullable<KpiTileProps["tone"]>, string> = {
  default: "text-muted-foreground",
  running: "text-[var(--status-running)]",
  succeeded: "text-[var(--status-succeeded)]",
  failed: "text-[var(--status-failed)]",
};

export function KpiTile({
  title,
  titleSuffix,
  value,
  hint,
  icon: Icon,
  tone = "default",
  testId,
}: KpiTileProps) {
  return (
    <Card data-testid={testId} className="flex min-h-24 flex-col">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 pb-1">
        <CardTitle className="min-w-0 leading-snug">
          {title}
          {titleSuffix ? (
            <>
              <wbr />
              <span className="whitespace-nowrap">{titleSuffix}</span>
            </>
          ) : null}
        </CardTitle>
        {Icon ? <Icon className={cn("h-4 w-4 shrink-0", toneClasses[tone])} aria-hidden /> : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-end p-3 pt-1">
        <div
          className="text-xl font-semibold tracking-tight tabular-nums"
          data-testid={testId ? `${testId}-value` : undefined}
        >
          {value}
        </div>
        {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

import { ArrowUpRight, CheckCircle2, type LucideIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

export interface AttentionOverviewItem {
  key: string;
  label: string;
  count: number | null;
  href: string;
  external?: boolean;
}

interface AttentionOverviewCardProps {
  title: string;
  description: string;
  icon: LucideIcon;
  items: AttentionOverviewItem[];
  emptyLabel: string;
  partialFailureLabel: string;
  partialFailure?: boolean;
  tone: "pending" | "failed";
  testId: string;
  compact?: boolean;
}

export function AttentionOverviewCard({
  title,
  description,
  icon: Icon,
  items,
  emptyLabel,
  partialFailureLabel,
  partialFailure = false,
  tone,
  testId,
  compact = false,
}: AttentionOverviewCardProps) {
  const knownCounts = items.flatMap((item) => (item.count == null ? [] : [item.count]));
  const total = knownCounts.reduce((sum, count) => sum + count, 0);
  const hasUnknown = knownCounts.length !== items.length;
  const badgeVariant = total > 0 ? tone : "succeeded";

  if (compact && total === 0 && !hasUnknown && !partialFailure) {
    return (
      <a
        href={items[0]?.href}
        data-testid={testId}
        className="flex items-center gap-2 rounded-md py-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <CheckCircle2 className="h-4 w-4 shrink-0 text-status-succeeded" />
        {emptyLabel}
      </a>
    );
  }
  return (
    <Card data-testid={testId}>
      <CardHeader className={compact ? "p-0 pb-3" : "p-4 pb-2"}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Icon className="h-5 w-5 shrink-0 text-brand" />
            <div className="min-w-0">
              <CardTitle className="text-base font-semibold text-foreground">{title}</CardTitle>
              {!compact && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
            </div>
          </div>
          <Badge
            variant={badgeVariant}
            className={`shrink-0 text-2xl font-semibold tabular-nums ${total > 0 ? (tone === "failed" ? "text-status-failed" : "text-brand") : ""}`}
          >
            {hasUnknown ? "—" : total}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className={compact ? "space-y-2 p-0" : "space-y-2 p-4 pt-2"}>
        {total === 0 && !hasUnknown ? (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-[var(--status-succeeded)]" />
            {emptyLabel}
          </div>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          {items.map((item) => (
            <a
              key={item.key}
              href={item.href}
              target={item.external ? "_blank" : undefined}
              rel={item.external ? "noreferrer" : undefined}
              className="group flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2 transition-colors hover:border-brand/45 hover:bg-muted/35"
              data-testid={`${testId}-${item.key}`}
            >
              <span className="truncate text-xs text-muted-foreground group-hover:text-foreground">
                {item.label}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-sm font-semibold tabular-nums">{item.count ?? "—"}</span>
                <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
              </span>
            </a>
          ))}
        </div>
        {partialFailure ? (
          <p className="text-xs text-[var(--status-failed)]">{partialFailureLabel}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

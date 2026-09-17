import { Link } from "@tanstack/react-router";
import { PackagePlus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";

type CatalogCreateRoute =
  | "/software/workflow-templates/new"
  | "/software/usecases/new"
  | "/software/spack/new"
  | "/software/scripts/new";

export function CatalogEmptyState({
  actionLabel,
  actionTo,
  description,
  icon,
  showAction = true,
  testId,
  title,
}: {
  actionLabel: string;
  actionTo: CatalogCreateRoute;
  description: string;
  icon: ReactNode;
  showAction?: boolean;
  testId: string;
  title: string;
}) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-dashed border-border bg-muted/20"
      data-testid={testId}
    >
      <div className="flex flex-col items-center px-5 py-9 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-card text-brand shadow-sm [&_svg]:h-5 [&_svg]:w-5">
          {icon}
        </div>
        <h3 className="mt-3 text-sm font-semibold text-foreground">{title}</h3>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
        {showAction ? (
          <Button asChild size="sm" className="mt-4">
            <Link to={actionTo}>
              <PackagePlus />
              {actionLabel}
            </Link>
          </Button>
        ) : null}
      </div>
      <div
        className="grid gap-3 border-t border-border/70 bg-card/50 p-4 sm:grid-cols-3"
        data-testid={`${testId}-placeholders`}
        aria-hidden="true"
      >
        {[0, 1, 2].map((index) => (
          <div key={index} className="rounded-md border border-border/70 bg-card p-3">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-md bg-muted" />
              <div className="h-2.5 w-24 rounded-full bg-muted" />
            </div>
            <div className="mt-4 h-2 w-full rounded-full bg-muted/80" />
            <div className="mt-2 h-2 w-2/3 rounded-full bg-muted/60" />
          </div>
        ))}
      </div>
    </div>
  );
}

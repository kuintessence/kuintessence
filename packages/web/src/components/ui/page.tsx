import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function PageShell({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-5", className)} {...props} />;
}

interface PageHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({
  title,
  subtitle,
  meta,
  actions,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-card/90 p-4 shadow-sm sm:p-5", className)}
      {...props}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          {meta ? <div className="mb-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          {subtitle ? (
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

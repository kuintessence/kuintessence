import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Card } from "./card";

export function PageShell({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <Card className={cn("min-w-0 space-y-5 p-4 sm:p-5", className)} {...props} />;
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
    <div className={cn("border-b border-border pb-5", className)} {...props}>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="min-w-0 flex-[3_1_20rem]">
          <h1 className="break-words text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">
            {title}
          </h1>
          {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
          {subtitle ? (
            <p className="mt-1 max-w-prose break-words [overflow-wrap:anywhere] text-sm leading-6 text-muted-foreground">
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="kq-fill-row max-w-full flex-[1_1_auto] sm:flex-initial sm:justify-end [&>span]:flex-none">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

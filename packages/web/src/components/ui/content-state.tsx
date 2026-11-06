import { Loader2 } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function LoadingState({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground",
        className,
      )}
      {...props}
    >
      <Loader2
        className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
      {children}
    </div>
  );
}

export function ErrorState({
  children,
  actions,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { actions?: ReactNode }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-md border border-status-failed/40 bg-status-failed/5 p-3 text-sm",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 break-words">{children}</div>
      {actions}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  actions,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-dashed border-border bg-muted/20 px-5 py-9 text-center",
        className,
      )}
      {...props}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className="mb-3 flex justify-center text-brand [&_svg]:h-6 [&_svg]:w-6"
        >
          {icon}
        </div>
      ) : null}
      <h3 className="text-sm font-semibold">{title}</h3>
      {description ? (
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      ) : null}
      {actions ? <div className="mt-4 flex justify-center">{actions}</div> : null}
    </div>
  );
}

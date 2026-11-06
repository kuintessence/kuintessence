import * as React from "react";
import { cn } from "../../lib/utils";

// Keep native form validation, option groups, keyboard navigation and mobile pickers.
export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-9 min-w-0 max-w-full rounded-md border border-border bg-card px-3 py-1 text-sm text-foreground",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-status-failed",
      className,
    )}
    {...props}
  />
));
NativeSelect.displayName = "NativeSelect";

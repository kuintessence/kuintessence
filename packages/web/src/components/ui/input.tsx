import * as React from "react";
import { cn } from "../../lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type = "text", ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      "flex h-9 min-w-0 w-full rounded-md border border-border bg-card px-3 py-1 text-sm",
      "placeholder:text-muted-foreground",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
      "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-status-failed",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-20 min-w-0 w-full resize-y rounded-md border border-border bg-card px-3 py-2 text-sm",
      "placeholder:text-muted-foreground",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
      "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-status-failed",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

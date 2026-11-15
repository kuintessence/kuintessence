import * as React from "react";
import { cn } from "../../lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  presets?: readonly number[] | false;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", presets, ...props }, ref) => {
    const presetId = React.useId();
    const candidates =
      type === "number" && !props.list && presets !== false
        ? (presets ?? [1, 2, 4, 8, 16, 32, 64]).filter((value) => {
            const min = Number(props.min ?? 0);
            const max = Number(props.max ?? Number.POSITIVE_INFINITY);
            const step = props.step === "any" ? 0 : Number(props.step ?? 1);
            return (
              value >= min &&
              value <= max &&
              (!step || Math.abs((value - min) / step - Math.round((value - min) / step)) < 1e-8)
            );
          })
        : [];
    return (
      <>
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
          list={props.list ?? (candidates.length ? presetId : undefined)}
        />
        {candidates.length ? (
          <datalist id={presetId}>
            {candidates.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        ) : null}
      </>
    );
  },
);
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

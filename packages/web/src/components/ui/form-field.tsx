import { type ReactNode, useId } from "react";
import { cn } from "../../lib/utils";

interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

export function FormField({
  id,
  label,
  description,
  error,
  children,
  className,
}: {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  children: (props: FieldControlProps) => ReactNode;
  className?: string;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const describedBy = [description && `${controlId}-description`, error && `${controlId}-error`]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cn("grid min-w-0 content-start gap-1.5 text-sm", className)}>
      <label htmlFor={controlId}>{label}</label>
      {children({
        id: controlId,
        "aria-describedby": describedBy || undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {description ? (
        <p id={`${controlId}-description`} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={`${controlId}-error`} role="alert" className="text-xs text-status-failed">
          {error}
        </p>
      ) : null}
    </div>
  );
}

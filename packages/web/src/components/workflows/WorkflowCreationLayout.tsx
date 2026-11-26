import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";

// Editor panels are task surfaces; they retain their own visual boundary inside a flat page.
export const WorkflowPanel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-workflow-panel="true"
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border border-border bg-card text-card-foreground",
        className,
      )}
      {...props}
    />
  ),
);
WorkflowPanel.displayName = "WorkflowPanel";

export function WorkflowCreationLayout({
  header,
  steps,
  children,
}: {
  header: ReactNode;
  steps: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="workflow-creation space-y-5" data-testid="new-workflow-page">
      <WorkflowPanel>
        <div className="p-4 sm:p-5">{header}</div>
        {steps}
      </WorkflowPanel>
      {children}
    </div>
  );
}

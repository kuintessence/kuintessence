import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 px-0 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      default: "text-foreground",
      outline: "text-foreground",
      brand: "text-foreground",
      pending: "text-status-pending",
      running: "text-[var(--status-running)]",
      succeeded: "text-[var(--status-succeeded)]",
      failed: "text-[var(--status-failed)]",
      cancelled: "text-[var(--status-cancelled)]",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };

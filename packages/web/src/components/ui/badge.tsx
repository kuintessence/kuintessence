import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-transparent bg-muted text-foreground",
        outline: "border-border text-foreground",
        brand: "border-transparent bg-brand-soft text-foreground",
        pending: "border-transparent bg-muted text-foreground",
        running:
          "border-transparent bg-[color-mix(in_oklab,var(--status-running)_15%,transparent)] text-[var(--status-running)]",
        succeeded:
          "border-transparent bg-[color-mix(in_oklab,var(--status-succeeded)_15%,transparent)] text-[var(--status-succeeded)]",
        failed:
          "border-transparent bg-[color-mix(in_oklab,var(--status-failed)_15%,transparent)] text-[var(--status-failed)]",
        cancelled:
          "border-transparent bg-[color-mix(in_oklab,var(--status-cancelled)_15%,transparent)] text-[var(--status-cancelled)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };

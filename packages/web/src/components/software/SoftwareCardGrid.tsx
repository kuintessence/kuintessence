import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function SoftwareCardGrid({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(min(100%,17.5rem),1fr))] auto-rows-max content-start gap-2.5",
        className,
      )}
      {...props}
    />
  );
}

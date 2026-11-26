import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";
import { SurfaceBoundary, useInsideSurface } from "./surface";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => {
    const nested = useInsideSurface();
    return (
      <div
        ref={ref}
        data-kq-surface={nested ? "section" : "region"}
        className={cn(
          "min-w-0",
          !nested && "rounded-xl border border-border bg-card text-card-foreground",
          className,
          nested && "rounded-none border-x-0 border-t-0 bg-transparent shadow-none ring-0",
        )}
        {...props}
      >
        <SurfaceBoundary>{children}</SurfaceBoundary>
      </div>
    );
  },
);
Card.displayName = "Card";

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col gap-1 p-4 pb-2", className)} {...props} />
  ),
);
CardHeader.displayName = "CardHeader";

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn("break-words text-base font-semibold text-card-foreground", className)}
      {...props}
    />
  ),
);
CardTitle.displayName = "CardTitle";

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-4 pt-2", className)} {...props} />
  ),
);
CardContent.displayName = "CardContent";

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-4 pt-0", className)} {...props} />
  ),
);
CardFooter.displayName = "CardFooter";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";
import type { OverlayDismissPolicy } from "./dialog";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "kq-motion kq-motion--overlay kq-motion--sheet-overlay fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]",
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = "SheetOverlay";

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  dismissible?: boolean;
  dirty?: boolean;
  outsideDismissPolicy?: OverlayDismissPolicy;
  side?: "right" | "left";
  width?: string;
}

export const SheetContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(
  (
    {
      className,
      children,
      dismissible = true,
      dirty = false,
      onEscapeKeyDown,
      onInteractOutside,
      outsideDismissPolicy = "always",
      side = "right",
      width = "max-w-2xl",
      ...props
    },
    ref,
  ) => (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed top-0 z-50 flex h-full w-[calc(100vw-0.75rem)] flex-col border-l border-border bg-card/98 p-0 text-card-foreground shadow-2xl shadow-black/10 outline-none transition ease-out sm:w-full",
          "kq-motion kq-motion--sheet",
          side === "right" ? "right-0" : "left-0 border-l-0 border-r",
          width,
          className,
        )}
        onInteractOutside={(event) => {
          if (!dismissible) {
            event.preventDefault();
            return;
          }
          onInteractOutside?.(event);
          if (
            outsideDismissPolicy === "never" ||
            (outsideDismissPolicy === "when-pristine" && dirty)
          ) {
            event.preventDefault();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (!dismissible) {
            event.preventDefault();
            return;
          }
          onEscapeKeyDown?.(event);
        }}
        {...props}
        data-side={side}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Close"
          disabled={!dismissible}
          className="absolute right-2 top-2 flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground opacity-80 transition-colors hover:bg-muted hover:text-foreground hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-[var(--ring)] sm:right-3 sm:top-3"
        >
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </SheetPortal>
  ),
);
SheetContent.displayName = "SheetContent";

export function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "shrink-0 border-b border-border bg-card/95 py-4 pl-4 pr-[3.75rem] sm:pl-5 sm:pr-16",
        className,
      )}
      {...props}
    />
  );
}

export const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("min-w-0 text-base font-semibold leading-6 tracking-tight", className)}
    {...props}
  />
));
SheetTitle.displayName = "SheetTitle";

export const SheetDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("min-w-0 text-xs leading-5 text-muted-foreground", className)}
    {...props}
  />
));
SheetDescription.displayName = "SheetDescription";

export function SheetBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5", className)} {...props} />
  );
}

export function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "shrink-0 border-t border-border bg-card/95 px-4 py-3 backdrop-blur sm:px-5",
        className,
      )}
      {...props}
    />
  );
}

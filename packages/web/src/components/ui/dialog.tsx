import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "kq-motion kq-motion--overlay fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = "DialogOverlay";

export type OverlayDismissPolicy = "always" | "never" | "when-pristine";

interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  dismissible?: boolean;
  dirty?: boolean;
  outsideDismissPolicy?: OverlayDismissPolicy;
}

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
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
      ...props
    },
    ref,
  ) => (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-1.5rem)] w-[min(calc(100vw-1rem),42rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-2xl shadow-black/15 outline-none",
          "kq-motion kq-motion--dialog",
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
    </DialogPrimitive.Portal>
  ),
);
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "shrink-0 border-b border-border py-4 pl-4 pr-[3.75rem] sm:pl-5 sm:pr-16",
        className,
      )}
      {...props}
    />
  );
}

export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("min-w-0 text-base font-semibold leading-6 tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("min-w-0 text-xs leading-5 text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";

export function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5", className)} {...props} />
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
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

import type { LucideIcon } from "lucide-react";
import { Copy, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useMotionPresence } from "../../lib/use-motion-presence";
import { cn } from "../../lib/utils";

export type FileContextAction = "copy" | "delete";

export interface FileContextTarget {
  x: number;
  y: number;
  label: string;
  path: string;
  kind: "file" | "dir";
  resourceId?: string;
}

interface FileContextMenuProps {
  target: FileContextTarget | null;
  actions: readonly FileContextAction[];
  disabledActions?: Partial<Record<FileContextAction, boolean>>;
  onAction: (action: FileContextAction) => void;
  onClose: () => void;
  restoreFocusTo?: HTMLElement | null;
}

const ACTIONS: ReadonlyArray<{
  action: FileContextAction;
  icon: LucideIcon;
  labelKey: string;
}> = [
  { action: "copy", icon: Copy, labelKey: "files.context.copy" },
  { action: "delete", icon: Trash2, labelKey: "files.context.delete" },
];

export function FileContextMenu({
  target,
  actions,
  disabledActions = {},
  onAction,
  onClose,
  restoreFocusTo,
}: FileContextMenuProps) {
  const { t } = useTranslation();
  const { present, snapshot, state } = useMotionPresence(target, "--kq-motion-fast");
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!target || !present) return;
    const close = () => {
      onClose();
      restoreFocusTo?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [
        ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
      ].filter((item) => !item.disabled);
      if (items.length === 0) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? (current + 1 + items.length) % items.length
              : (current - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [target, present, onClose, restoreFocusTo]);

  if (!present || !snapshot) return null;

  const menuWidth = 176;
  const menuHeight = 44 + actions.length * 36 + 8;
  const viewportWidth = typeof window === "undefined" ? snapshot.x + menuWidth : window.innerWidth;
  const viewportHeight =
    typeof window === "undefined" ? snapshot.y + menuHeight : window.innerHeight;
  const left = Math.max(8, Math.min(snapshot.x, viewportWidth - menuWidth - 8));
  const top = Math.max(8, Math.min(snapshot.y, viewportHeight - menuHeight - 8));
  const visibleActions = ACTIONS.filter((item) => actions.includes(item.action));

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("files.context.menuLabel", { name: snapshot.label })}
      aria-hidden={target === null}
      data-state={state}
      className="kq-motion kq-motion--menu fixed z-50 w-44 overflow-hidden rounded-md border border-border bg-card p-1 text-card-foreground shadow-lg"
      style={{ left, top }}
      data-testid="files-context-menu"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="min-w-0 truncate px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
        {snapshot.label}
      </div>
      {visibleActions.map((item) => {
        const Icon = item.icon;
        const disabled = target === null || (disabledActions[item.action] ?? false);
        return (
          <button
            key={item.action}
            type="button"
            role="menuitem"
            disabled={disabled}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none",
              disabled
                ? "cursor-not-allowed text-muted-foreground opacity-60"
                : "hover:bg-muted/70 focus:bg-muted/70",
            )}
            data-testid={`files-context-${item.action}`}
            onClick={() => {
              if (disabled) return;
              onAction(item.action);
              restoreFocusTo?.focus();
            }}
          >
            <Icon className="h-4 w-4" />
            {t(item.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

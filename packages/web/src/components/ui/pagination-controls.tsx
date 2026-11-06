import type { HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Button, type ButtonProps } from "./button";

type PageButtonProps = Pick<ButtonProps, "onClick" | "disabled" | "children"> & {
  "data-testid"?: string;
};

interface PaginationControlsProps extends HTMLAttributes<HTMLDivElement> {
  previous: PageButtonProps;
  next: PageButtonProps;
}

export function PaginationControls({
  previous,
  next,
  children,
  className,
  ...props
}: PaginationControlsProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <Button type="button" variant="outline" size="sm" {...previous}>
        {previous.children ?? t("common.pagination.previous")}
      </Button>
      <Button type="button" variant="outline" size="sm" {...next}>
        {next.children ?? t("common.pagination.next")}
      </Button>
    </div>
  );
}

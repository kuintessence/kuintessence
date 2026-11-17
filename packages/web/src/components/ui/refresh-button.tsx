import { RefreshCw } from "lucide-react";
import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { Button, type ButtonProps } from "./button";

export const RefreshButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, "size"> & { label?: string }
>(function RefreshButton({ label, children, ...props }, ref) {
  const { t } = useTranslation();
  const accessibleLabel = label ?? t("common.refresh");
  return (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      {...props}
      size="icon"
      aria-label={accessibleLabel}
      title={props.title ?? accessibleLabel}
    >
      {children || <RefreshCw aria-hidden="true" />}
    </Button>
  );
});

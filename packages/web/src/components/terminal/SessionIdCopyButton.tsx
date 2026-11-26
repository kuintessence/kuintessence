import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "../ui/button";

export function SessionIdCopyButton({ id, iconOnly = false }: { id: string; iconOnly?: boolean }) {
  const { t } = useTranslation();
  async function copyId() {
    try {
      await navigator.clipboard.writeText(id);
      toast.message(t("terminal.copySessionIdSucceeded", { id: id.slice(0, 8) }));
    } catch {
      toast.error(t("terminal.copyIdFailed"));
    }
  }

  return (
    <Button
      variant={iconOnly ? "ghost" : "outline"}
      size={iconOnly ? "icon" : "sm"}
      aria-label={t("terminal.copySessionId")}
      data-testid={iconOnly ? "terminal-copy-id" : "terminal-audit-copy-id"}
      onClick={copyId}
    >
      <Copy />
      {iconOnly ? null : t("terminal.copySessionIdShort")}
    </Button>
  );
}

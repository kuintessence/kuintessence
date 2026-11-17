import { useTranslation } from "react-i18next";
import { LogViewer } from "../ui/log-viewer";

export function AuditLogPanel() {
  const { t } = useTranslation();
  return (
    <LogViewer
      endpoint="/audit-log"
      title={t("settings.operations.auditLog.title")}
      description={t("settings.operations.auditLog.description")}
    />
  );
}

import { useTranslation } from "react-i18next";

export function FederationSiteIdentity({ id, name }: { id: string; name?: string | null }) {
  const { t } = useTranslation();
  return (
    <span className="block min-w-0 space-y-1">
      <span className="block break-words text-sm">
        {name || t("federation.siteNameUnavailable")}
      </span>
      <span className="block break-all text-xs text-muted-foreground">{id}</span>
    </span>
  );
}

import { useTranslation } from "react-i18next";
import type { ApiOrganizationScope } from "../../lib/api-client";
import { Button } from "../ui/button";

export type MediaScope = ApiOrganizationScope & { localSiteId: string };
export function checkMediaScope<T extends { localOrgId: string; localSiteId: string }>(
  row: T,
  scope: MediaScope,
): T {
  if (row.localOrgId !== scope.organizationId || row.localSiteId !== scope.localSiteId)
    throw new Error("Media scope mismatch");
  return row;
}
export function MediaPagination({
  page,
  hasMore,
  busy,
  onChange,
}: {
  page: number;
  hasMore: boolean;
  busy: boolean;
  onChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  if (!page && !hasMore) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={!page || busy}
        onClick={() => onChange(page - 1)}
      >
        {t("federation.previous")}
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={!hasMore || busy}
        onClick={() => onChange(page + 1)}
      >
        {t("federation.next")}
      </Button>
    </div>
  );
}

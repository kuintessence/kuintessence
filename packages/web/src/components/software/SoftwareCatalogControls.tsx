import type { SoftwareAssetSummary } from "@kuintessence/shared/browser";
import { ChevronLeft, ChevronRight, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PaginationControls } from "../ui/pagination-controls";

export const WORKFLOW_TEMPLATE_PAGE_SIZE = 24;

export function favoriteKey(kind: "template" | "usecase" | "spack", id: string): string {
  return `${kind}:${id}`;
}

export function AssetStatusBadges({ asset }: { asset: SoftwareAssetSummary }) {
  const { t } = useTranslation();
  return (
    <>
      <Badge variant="outline">{t(`software.governance.kind.${asset.kind}`)}</Badge>
      <Badge variant="outline">{t(`software.governance.source.${asset.source}`)}</Badge>
      <Badge variant={asset.lifecycle === "published" ? "brand" : "outline"}>
        {t(`software.governance.lifecycle.${asset.lifecycle}`)}
      </Badge>
      <Badge variant="outline">{t(`software.governance.visibility.${asset.visibility}`)}</Badge>
    </>
  );
}

export function ServerPagination({
  hasNext,
  page,
  setPage,
  shown,
  total,
}: {
  hasNext: boolean;
  page: number;
  setPage: (value: number) => void;
  shown: number;
  total: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span>{t("software.pageResultCount", { shown, total })}</span>
      <PaginationControls
        previous={{
          disabled: page <= 1,
          onClick: () => setPage(Math.max(1, page - 1)),
          "data-testid": "software-template-previous-page",
          children: (
            <>
              <ChevronLeft />
              {t("software.manage.previousPage")}
            </>
          ),
        }}
        next={{
          disabled: !hasNext,
          onClick: () => setPage(page + 1),
          "data-testid": "software-template-next-page",
          children: (
            <>
              {t("software.manage.nextPage")}
              <ChevronRight />
            </>
          ),
        }}
      >
        <span className="font-mono text-[11px]">
          {t("software.manage.catalogPageStatus", {
            page,
            total: Math.max(1, Math.ceil(total / WORKFLOW_TEMPLATE_PAGE_SIZE)),
          })}
        </span>
      </PaginationControls>
    </div>
  );
}

export function FavoriteButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="ghost"
      className="aria-pressed:bg-brand-soft aria-pressed:font-semibold aria-pressed:text-brand"
      size="sm"
      onClick={onClick}
      aria-pressed={active}
      aria-label={active ? t("software.unfavorite") : t("software.favorite")}
    >
      <Star className={cn(active && "fill-current")} />
      <span className="sr-only">{active ? t("software.unfavorite") : t("software.favorite")}</span>
    </Button>
  );
}

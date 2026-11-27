import type { SoftwareAssetSummary } from "@kuintessence/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Boxes,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Eye,
  GitBranch,
  Loader2,
  Save,
  ShieldAlert,
  Trash2,
  Undo2,
} from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { getAuthState } from "../../lib/auth";
import {
  getSpackCatalogSource,
  type SpackCatalog,
  type SpackCatalogPackage,
  type SpackCatalogPackageUpdate,
} from "../../lib/software-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { FormField } from "../ui/form-field";
import { Input } from "../ui/input";
import { PaginationControls } from "../ui/pagination-controls";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { CatalogEmptyState } from "./CatalogEmptyState";
import {
  cardActionLayerClass,
  cardContentLayerClass,
  cardSurfaceLinkClass,
  clickableCardClass,
} from "./card-navigation";
import { SoftwareCardGrid } from "./SoftwareCardGrid";
import { AssetStatusBadges, FavoriteButton, favoriteKey } from "./SoftwareCatalogControls";
import { SpackSourceEditor } from "./SpackSourceEditor";
import { optionalText, parseTagInput, sourceLabel } from "./software-fields";
import { catalogPackageKey } from "./spack-catalog";

export function SpackSoftwarePanel({
  activeOrganizationId,
  canManage,
  canManagePlatform,
  canRequestAccess,
  canSubmitAssets,
  favorites,
  removeCatalogPackage,
  removeCatalogPackagePending,
  requestAccess,
  submitAsset,
  spackCatalog,
  spackCatalogPackages,
  setSpackCatalogPage,
  toggleFavorite,
  updateCatalogPackage,
  updateCatalogPackagePending,
}: {
  activeOrganizationId: string | null;
  canManage: boolean;
  canManagePlatform: boolean;
  canRequestAccess: boolean;
  canSubmitAssets: boolean;
  favorites: Set<string>;
  removeCatalogPackage: (id: string, onSuccess: () => void) => void;
  removeCatalogPackagePending: boolean;
  requestAccess: (asset: SoftwareAssetSummary) => void;
  submitAsset: (assetId: string) => void;
  spackCatalog: SpackCatalog | null;
  spackCatalogPackages: SpackCatalogPackage[];
  setSpackCatalogPage: (value: number) => void;
  toggleFavorite: (key: string) => void;
  updateCatalogPackage: (
    id: string,
    payload: SpackCatalogPackageUpdate,
    onSuccess: () => void,
  ) => void;
  updateCatalogPackagePending: boolean;
}) {
  const { t } = useTranslation();
  if (spackCatalog && spackCatalog.packageCount === 0 && spackCatalog.customCount === 0) {
    return (
      <CatalogEmptyState
        actionLabel={t("software.spackEmptyAction")}
        actionTo="/software/spack/new"
        description={t("software.spackEmptyDescription")}
        icon={<Boxes />}
        showAction={canManage}
        testId="software-spack-empty"
        title={t("software.spackEmptyTitle")}
      />
    );
  }
  return (
    <div className="grid gap-4">
      <SpackCatalogOptions catalog={spackCatalog} />
      <SpackCatalogSummary catalog={spackCatalog} />
      <SpackCatalogPackageList
        canManage={canManage}
        canManagePlatform={canManagePlatform}
        activeOrganizationId={activeOrganizationId}
        canRequestAccess={canRequestAccess}
        canSubmitAssets={canSubmitAssets}
        catalog={spackCatalog}
        favorites={favorites}
        packages={spackCatalogPackages}
        removePackage={removeCatalogPackage}
        removePackagePending={removeCatalogPackagePending}
        requestAccess={requestAccess}
        setPage={setSpackCatalogPage}
        submitAsset={submitAsset}
        toggleFavorite={toggleFavorite}
        updatePackage={updateCatalogPackage}
        updatePackagePending={updateCatalogPackagePending}
      />
    </div>
  );
}

function SpackCatalogSummary({ catalog }: { catalog: SpackCatalog | null }) {
  const { t } = useTranslation();
  if (!catalog) return null;
  return (
    <div data-testid="software-spack-catalog-summary">
      <div className=" border-border p-3 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">{t("software.manage.officialCatalog")}</div>
        <div className="mt-1 leading-5">
          {t("software.manage.catalogStats", {
            count: catalog.packageCount,
            custom: catalog.customCount,
            repo: catalog.sourceRepository,
            ref: catalog.sourceRef,
            upstream: catalog.upstreamCount,
            date: catalog.generatedAt,
          })}
        </div>
      </div>
    </div>
  );
}

function SpackCatalogPackageList({
  activeOrganizationId,
  canManage,
  canManagePlatform,
  canRequestAccess,
  canSubmitAssets,
  catalog,
  favorites,
  packages,
  removePackage,
  removePackagePending,
  requestAccess,
  setPage,
  submitAsset,
  toggleFavorite,
  updatePackage,
  updatePackagePending,
}: {
  activeOrganizationId: string | null;
  canManage: boolean;
  canManagePlatform: boolean;
  canRequestAccess: boolean;
  canSubmitAssets: boolean;
  catalog: SpackCatalog | null;
  favorites: Set<string>;
  packages: SpackCatalogPackage[];
  removePackage: (id: string, onSuccess: () => void) => void;
  removePackagePending: boolean;
  requestAccess: (asset: SoftwareAssetSummary) => void;
  setPage: (value: number) => void;
  submitAsset: (assetId: string) => void;
  toggleFavorite: (key: string) => void;
  updatePackage: (id: string, payload: SpackCatalogPackageUpdate, onSuccess: () => void) => void;
  updatePackagePending: boolean;
}) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const editingPackage = catalog?.packages.find((pkg) => pkg.id === editingId) ?? null;
  const deletingPackage = catalog?.packages.find((pkg) => pkg.id === deletingId) ?? null;
  if (!catalog) return null;
  return (
    <div className="grid min-w-0 content-start gap-3" data-testid="software-spack-list">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-medium text-foreground">
            {t("software.manage.catalogResults")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("software.manage.catalogResultCount", {
              shown: packages.length,
              total: catalog.totalCount,
            })}
          </div>
        </div>
        <PaginationControls
          previous={{
            disabled: !catalog.hasPrevious,
            onClick: () => setPage(Math.max(1, catalog.page - 1)),
            "data-testid": "software-spack-catalog-prev",
            children: (
              <>
                <ChevronLeft />
                {t("software.manage.previousPage")}
              </>
            ),
          }}
          next={{
            disabled: !catalog.hasNext,
            onClick: () => setPage(catalog.page + 1),
            "data-testid": "software-spack-catalog-next",
            children: (
              <>
                {t("software.manage.nextPage")}
                <ChevronRight />
              </>
            ),
          }}
        >
          <span className="font-mono text-[11px] text-muted-foreground">
            {t("software.manage.catalogPageStatus", {
              page: catalog.page,
              total: catalog.totalPages,
            })}
          </span>
        </PaginationControls>
      </div>
      <SoftwareCardGrid className="gap-3" data-testid="software-spack-catalog-list">
        {packages.length === 0 ? (
          <span className="text-muted-foreground">{t("software.manage.catalogNoMatches")}</span>
        ) : (
          packages.map((pkg) => {
            const key = favoriteKey("spack", catalogPackageKey(pkg));
            const asset = pkg.asset ?? null;
            const canManagePackage =
              pkg.source === "official"
                ? canManagePlatform
                : pkg.source === "vendor" &&
                  (canManagePlatform || (canManage && pkg.ownerOrgId === activeOrganizationId));
            return (
              <div
                key={`${pkg.source}:${pkg.id ?? pkg.name}`}
                className={`grid min-w-0 content-start gap-2 p-3 ${clickableCardClass}`}
                data-testid={`software-spack-catalog-package-${pkg.source}-${pkg.name}`}
              >
                <Link
                  to="/software/spack/$source/$name"
                  params={{ name: pkg.name, source: pkg.source }}
                  className={cardSurfaceLinkClass}
                  aria-label={`${t("software.manage.view")}: ${pkg.name}`}
                  data-testid={`software-spack-card-surface-${pkg.source}-${pkg.name}`}
                />
                <div className={`min-w-0 ${cardContentLayerClass}`}>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                    <div className="min-w-0">
                      <Link
                        to="/software/spack/$source/$name"
                        params={{ name: pkg.name, source: pkg.source }}
                        className={`block truncate font-mono text-sm font-semibold text-foreground hover:text-brand ${cardActionLayerClass}`}
                      >
                        {pkg.name}
                      </Link>
                      {pkg.ownerOrgId ? (
                        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                          {t("software.manage.ownerOrg")}: {pkg.ownerOrgId}
                        </div>
                      ) : null}
                    </div>
                    <div className={`flex shrink-0 items-center gap-1.5 ${cardActionLayerClass}`}>
                      <FavoriteButton
                        active={favorites.has(key)}
                        onClick={() => toggleFavorite(key)}
                      />
                      <Badge variant={pkg.source === "upstream" ? "outline" : "brand"}>
                        {sourceLabel(t, pkg.source)}
                      </Badge>
                    </div>
                  </div>
                  {pkg.asset ? (
                    <div
                      className="mt-2 flex flex-wrap gap-1"
                      data-testid={`software-spack-asset-status-${pkg.source}-${pkg.name}`}
                    >
                      <AssetStatusBadges asset={pkg.asset} />
                    </div>
                  ) : null}
                  {pkg.description ? (
                    <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                      {pkg.description}
                    </p>
                  ) : null}
                  <div className="mt-2 flex min-h-6 flex-wrap gap-1">
                    {pkg.metadata ? (
                      <>
                        <Badge variant="outline">
                          {t("software.manage.versionCount", {
                            count: pkg.metadata.versions.length,
                          })}
                        </Badge>
                        <Badge variant="outline">
                          {t("software.manage.variantCount", {
                            count: pkg.metadata.variants.length,
                          })}
                        </Badge>
                      </>
                    ) : null}
                    {pkg.tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className={`kq-fill-row gap-1 border-border pt-2 ${cardActionLayerClass}`}>
                  <Button
                    asChild
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`software-view-catalog-package-${pkg.source}-${pkg.name}`}
                  >
                    <Link
                      to="/software/spack/$source/$name"
                      params={{ name: pkg.name, source: pkg.source }}
                    >
                      <Eye />
                      {t("software.manage.view")}
                    </Link>
                  </Button>
                  {asset ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!canRequestAccess}
                      onClick={() => requestAccess(asset)}
                      data-testid={`software-request-catalog-package-${pkg.source}-${pkg.name}`}
                    >
                      <ShieldAlert />
                      {t("software.access.requestInstall")}
                    </Button>
                  ) : null}
                  {canManagePackage && pkg.id ? (
                    <>
                      {pkg.asset?.lifecycle === "draft" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!canSubmitAssets}
                          onClick={() => {
                            if (pkg.asset) submitAsset(pkg.asset.id);
                          }}
                          data-testid={`software-submit-catalog-package-${pkg.id}`}
                        >
                          <GitBranch />
                          {t("software.governance.submit")}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingId(pkg.id ?? null)}
                        data-testid={`software-edit-catalog-package-${pkg.id}`}
                      >
                        <Edit3 />
                        {t("software.manage.edit")}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => setDeletingId(pkg.id ?? null)}
                        data-testid={`software-delete-catalog-package-${pkg.id}`}
                      >
                        <Trash2 />
                        {t("software.manage.delete")}
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </SoftwareCardGrid>
      {editingPackage?.id ? (
        <Sheet
          open={true}
          onOpenChange={(open) => !open && !updatePackagePending && setEditingId(null)}
        >
          <SheetContent
            width="max-w-2xl"
            data-testid="software-spack-edit-sheet"
            dismissible={!updatePackagePending}
          >
            <SheetHeader>
              <SheetTitle>{t("software.manage.editSpack")}</SheetTitle>
              <SheetDescription>{editingPackage.name}</SheetDescription>
            </SheetHeader>
            <SheetBody>
              <SpackCatalogPackageEditForm
                key={`${editingPackage.id}-${activeOrganizationId}`}
                pkg={editingPackage}
                isPending={updatePackagePending}
                onCancel={() => setEditingId(null)}
                onSubmit={(payload) => {
                  updatePackage(editingPackage.id ?? "", payload, () => setEditingId(null));
                }}
              />
            </SheetBody>
          </SheetContent>
        </Sheet>
      ) : null}
      {deletingPackage?.id ? (
        <Dialog
          open={true}
          onOpenChange={(open) => !open && !removePackagePending && setDeletingId(null)}
        >
          <DialogContent
            data-testid="software-delete-catalog-package-dialog"
            dismissible={!removePackagePending}
          >
            <DialogHeader>
              <DialogTitle>{t("software.manage.deleteCatalogPackageTitle")}</DialogTitle>
              <DialogDescription>
                {t("software.manage.deleteCatalogPackageDescription", {
                  name: deletingPackage.name,
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                disabled={removePackagePending}
                onClick={() => setDeletingId(null)}
              >
                {t("software.manage.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={removePackagePending}
                onClick={() => removePackage(deletingPackage.id ?? "", () => setDeletingId(null))}
                data-testid="software-delete-catalog-package-confirm"
              >
                {removePackagePending ? <Loader2 className="animate-spin" /> : <Trash2 />}
                {t("software.manage.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function SpackCatalogOptions({ catalog }: { catalog: SpackCatalog | null }) {
  if (!catalog) return null;
  return (
    <datalist id="software-spack-package-catalog">
      {catalog.packages.map((pkg) => (
        <option key={`${pkg.source}:${pkg.id ?? pkg.name}`} value={pkg.name} />
      ))}
    </datalist>
  );
}

function SpackCatalogPackageEditForm({
  isPending,
  onCancel,
  onSubmit,
  pkg,
}: {
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (payload: SpackCatalogPackageUpdate) => void;
  pkg: SpackCatalogPackage;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState(pkg.name);
  const source = pkg.source === "vendor" ? "vendor" : "official";
  const orgId = useActiveOrganizationId();
  const recipe = useQuery({
    queryKey: ["spack-catalog-source", pkg.id, orgId, getAuthState().revision],
    queryFn: () => getSpackCatalogSource(pkg.id ?? ""),
    retry: false,
    gcTime: 0,
  });
  const [draft, setDraft] = useState<{
    packageFile: string;
    expectedSourceDigest: string | null;
  }>();
  const [description, setDescription] = useState(pkg.description ?? "");
  const [tags, setTags] = useState(pkg.tags.join(","));
  return (
    <form
      className="grid gap-3"
      data-testid={`software-spack-catalog-package-edit-form-${pkg.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSubmit({
          name: name.trim(),
          source,
          description: optionalText(description),
          tags: parseTagInput(tags),
          ...draft,
        });
      }}
    >
      <div className="grid gap-2 md:grid-cols-[1fr_150px]">
        <FormField id={`${id}-name`} label={t("software.manage.catalogPackageName")}>
          {(field) => <Input {...field} value={name} onChange={(e) => setName(e.target.value)} />}
        </FormField>
        <label htmlFor={`${id}-source`} className="grid min-w-0 gap-1.5 text-sm">
          <span>{t("software.manage.catalogPackageSource")}</span>
          <Input id={`${id}-source`} readOnly value={sourceLabel(t, source)} />
        </label>
      </div>
      <FormField id={`${id}-description`} label={t("software.manage.catalogPackageDescription")}>
        {(field) => (
          <Input {...field} value={description} onChange={(e) => setDescription(e.target.value)} />
        )}
      </FormField>
      <FormField id={`${id}-tags`} label={t("software.manage.catalogPackageTags")}>
        {(field) => <Input {...field} value={tags} onChange={(e) => setTags(e.target.value)} />}
      </FormField>
      {recipe.data && (
        <SpackSourceEditor
          value={draft?.packageFile ?? recipe.data.content ?? ""}
          onChange={(packageFile) => {
            const expectedSourceDigest = draft ? draft.expectedSourceDigest : recipe.data.digest;
            setDraft({ packageFile, expectedSourceDigest });
          }}
        />
      )}
      {recipe.isError && (
        <div role="alert">
          {toUserFacingError(recipe.error, t("software.unreachable"))}{" "}
          <Button type="button" variant="outline" onClick={() => void recipe.refetch()}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isPending}>
          <Undo2 />
          {t("software.manage.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={isPending}>
          <Save />
          {t("software.manage.save")}
        </Button>
      </div>
    </form>
  );
}

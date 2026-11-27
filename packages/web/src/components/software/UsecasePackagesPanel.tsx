import { Link } from "@tanstack/react-router";
import { Edit3, Eye, FlaskConical, Save, Undo2 } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  SpackCatalog,
  SpackCatalogPackage,
  SpackCatalogSourceFilter,
  UsecasePackage,
  UsecasePackageUpdate,
} from "../../lib/software-client";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { FormField } from "../ui/form-field";
import { Input } from "../ui/input";
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
import { SmallEmpty } from "./SmallEmpty";
import { SoftwareCardGrid } from "./SoftwareCardGrid";
import { FavoriteButton, favoriteKey, ServerPagination } from "./SoftwareCatalogControls";
import { CatalogPackagePickerField, SpackCatalogPickerDialog } from "./SpackCatalogPicker";
import { SpackSpecConfigSheet, SpackSpecPickerField } from "./SpackSpecPicker";
import { optionalText, suggestNextTemplateVersion } from "./software-fields";
import { catalogPackageKey } from "./spack-catalog";
import { makeUsecaseSpec } from "./spack-spec";

export function UsecasePackagesPanel({
  canManage,
  catalog,
  catalogSearch,
  catalogSource,
  favorites,
  hasFilter,
  page,
  hasNext,
  setCatalogPage,
  setCatalogSearch,
  setCatalogSource,
  setPage,
  toggleFavorite,
  total,
  updateUsecase,
  updateUsecasePending,
  usecases,
}: {
  canManage: boolean;
  catalog: SpackCatalog | null;
  catalogSearch: string;
  catalogSource: SpackCatalogSourceFilter;
  favorites: Set<string>;
  hasFilter: boolean;
  page: number;
  hasNext: boolean;
  setCatalogPage: (value: number) => void;
  setCatalogSearch: (value: string) => void;
  setCatalogSource: (value: SpackCatalogSourceFilter) => void;
  setPage: (value: number) => void;
  toggleFavorite: (key: string) => void;
  total: number;
  updateUsecase: (id: string, payload: UsecasePackageUpdate, onSuccess: () => void) => void;
  updateUsecasePending: boolean;
  usecases: UsecasePackage[];
}) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingUsecase = usecases.find((item) => item.id === editingId) ?? null;
  return (
    <div className="grid gap-4">
      <div className="grid min-w-0 content-start gap-3" data-testid="software-usecase-list">
        {usecases.length === 0 ? (
          hasFilter ? (
            <SmallEmpty icon={<FlaskConical />} text={t("software.noMatches")} />
          ) : (
            <CatalogEmptyState
              actionLabel={t("software.usecaseEmptyAction")}
              actionTo="/software/usecases/new"
              description={t("software.usecaseEmptyDescription")}
              icon={<FlaskConical />}
              showAction={canManage}
              testId="software-usecase-empty"
              title={t("software.usecaseEmptyTitle")}
            />
          )
        ) : (
          <>
            <ServerPagination
              hasNext={hasNext}
              page={page}
              setPage={setPage}
              shown={usecases.length}
              total={total}
            />
            <SoftwareCardGrid>
              {usecases.map((pkg) => {
                const key = favoriteKey("usecase", pkg.id);
                return (
                  <UsecaseCard
                    key={pkg.id}
                    favorite={favorites.has(key)}
                    onEdit={canManage ? () => setEditingId(pkg.id) : undefined}
                    onToggleFavorite={() => toggleFavorite(key)}
                    pkg={pkg}
                  />
                );
              })}
            </SoftwareCardGrid>
            <ServerPagination
              hasNext={hasNext}
              page={page}
              setPage={setPage}
              shown={usecases.length}
              total={total}
            />
          </>
        )}
      </div>
      {canManage && editingUsecase ? (
        <Sheet
          open={true}
          onOpenChange={(open) => !open && !updateUsecasePending && setEditingId(null)}
        >
          <SheetContent
            width="max-w-2xl"
            data-testid="software-usecase-edit-sheet"
            dismissible={!updateUsecasePending}
          >
            <SheetHeader>
              <SheetTitle>{t("software.manage.publishUsecaseVersion")}</SheetTitle>
              <SheetDescription>{editingUsecase.name}</SheetDescription>
            </SheetHeader>
            <SheetBody>
              <UsecasePackageEditForm
                catalog={catalog}
                catalogSearch={catalogSearch}
                catalogSource={catalogSource}
                isPending={updateUsecasePending}
                pkg={editingUsecase}
                onCancel={() => setEditingId(null)}
                onSubmit={(payload) => {
                  updateUsecase(editingUsecase.id, payload, () => setEditingId(null));
                }}
                setCatalogPage={setCatalogPage}
                setCatalogSearch={setCatalogSearch}
                setCatalogSource={setCatalogSource}
              />
            </SheetBody>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}

function UsecaseCard({
  favorite,
  onEdit,
  onToggleFavorite,
  pkg,
}: {
  favorite: boolean;
  onEdit?: () => void;
  onToggleFavorite: () => void;
  pkg: UsecasePackage;
}) {
  const { t } = useTranslation();
  const softwareLabel =
    pkg.spec.software.kind === "Spack"
      ? [pkg.spec.software.name, ...pkg.spec.software.argumentList].join(" ")
      : pkg.spec.software.kind === "Singularity"
        ? `${pkg.spec.software.image}:${pkg.spec.software.tag}`
        : "Bare";
  const moduleName = pkg.spec.software.kind === "Spack" ? pkg.spec.software.moduleName : null;
  const compiler = pkg.spec.software.kind === "Spack" ? pkg.spec.software.compiler : null;
  const variantRef = pkg.spec.software.kind === "Spack" ? pkg.spec.software.variantRef : null;
  return (
    <article
      className={`flex min-w-0 flex-col gap-2 p-3 ${clickableCardClass}`}
      data-testid={`software-usecase-card-${pkg.id}`}
    >
      <Link
        to="/software/usecases/$usecaseId"
        params={{ usecaseId: pkg.id }}
        className={cardSurfaceLinkClass}
        aria-label={`${t("software.manage.view")}: ${pkg.name}`}
        data-testid={`software-usecase-card-surface-${pkg.id}`}
      />
      <div className={`flex items-start justify-between gap-3 ${cardContentLayerClass}`}>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{pkg.name}</div>
        </div>
        <div className={`flex shrink-0 items-center gap-1 ${cardActionLayerClass}`}>
          <FavoriteButton active={favorite} onClick={onToggleFavorite} />
          <Badge variant="outline">v{pkg.version}</Badge>
        </div>
      </div>
      {pkg.description && (
        <p className={`line-clamp-2 text-xs text-muted-foreground ${cardContentLayerClass}`}>
          {pkg.description}
        </p>
      )}
      <div className={`grid grid-cols-2 gap-2 text-xs ${cardContentLayerClass}`}>
        <InfoTile label={t("software.manage.commandFile")} value={pkg.spec.usecase.commandFile} />
        <InfoTile label={t("software.manage.boundSoftware")} value={softwareLabel} />
        {compiler && <InfoTile label={t("software.manage.compiler")} value={compiler} />}
        {moduleName && <InfoTile label={t("software.manage.module")} value={moduleName} />}
        {variantRef && <InfoTile label={t("software.manage.variantRef")} value={variantRef} />}
      </div>
      <div className={`mt-auto flex flex-wrap gap-1.5 pt-1 ${cardActionLayerClass}`}>
        <Button asChild variant="outline" size="sm" data-testid={`software-view-usecase-${pkg.id}`}>
          <Link to="/software/usecases/$usecaseId" params={{ usecaseId: pkg.id }}>
            <Eye />
            {t("software.manage.view")}
          </Link>
        </Button>
        {onEdit ? (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Edit3 />
            {t("software.manage.edit")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function UsecasePackageEditForm({
  catalog,
  catalogSearch,
  catalogSource,
  isPending,
  onCancel,
  onSubmit,
  pkg,
  setCatalogPage,
  setCatalogSearch,
  setCatalogSource,
}: {
  catalog: SpackCatalog | null;
  catalogSearch: string;
  catalogSource: SpackCatalogSourceFilter;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (payload: UsecasePackageUpdate) => void;
  pkg: UsecasePackage;
  setCatalogPage: (value: number) => void;
  setCatalogSearch: (value: string) => void;
  setCatalogSource: (value: SpackCatalogSourceFilter) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const packages = catalog?.packages ?? [];
  const currentSoftware = pkg.spec.software;
  const initialPackage =
    currentSoftware.kind === "Spack" ? findCatalogPackage(packages, currentSoftware) : null;
  const [name, setName] = useState(pkg.name);
  const [version, setVersion] = useState(() => suggestNextTemplateVersion(pkg.version));
  const [description, setDescription] = useState(pkg.description ?? "");
  const [commandFile, setCommandFile] = useState(pkg.spec.usecase.commandFile);
  const [inputDescriptor, setInputDescriptor] = useState(pkg.spec.arguments[0]?.descriptor ?? "");
  const [argumentFormat, setArgumentFormat] = useState(pkg.spec.arguments[0]?.valueFormat ?? "{}");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [specOpen, setSpecOpen] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<SpackCatalogPackage | null>(
    initialPackage,
  );
  const [softwareVersion, setSoftwareVersion] = useState(
    currentSoftware.kind === "Spack" ? (currentSoftware.version ?? "") : "",
  );
  const [compiler, setCompiler] = useState(
    currentSoftware.kind === "Spack" ? (currentSoftware.compiler ?? "") : "",
  );
  const [moduleName, setModuleName] = useState(
    currentSoftware.kind === "Spack" ? (currentSoftware.moduleName ?? "") : "",
  );
  const [variants, setVariants] = useState(
    currentSoftware.kind === "Spack" ? currentSoftware.argumentList.join(" ") : "",
  );
  return (
    <form
      className="grid min-w-0 grid-cols-1 content-start gap-3"
      data-testid={`software-usecase-edit-form-${pkg.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !version.trim() || !commandFile.trim() || !selectedPackage) return;
        onSubmit({
          name: name.trim(),
          version: version.trim(),
          description: optionalText(description),
          spec: makeUsecaseSpec(
            commandFile.trim(),
            inputDescriptor.trim(),
            argumentFormat,
            selectedPackage,
            {
              compiler,
              moduleName,
              variants,
              version: softwareVersion,
            },
          ),
        });
      }}
    >
      <div className="grid gap-2 md:grid-cols-[1fr_120px]">
        <FormField id={`${id}-name`} label={t("software.manage.usecaseName")}>
          {(field) => <Input {...field} value={name} onChange={(e) => setName(e.target.value)} />}
        </FormField>
        <FormField id={`${id}-version`} label={t("software.manage.version")}>
          {(field) => (
            <Input {...field} value={version} onChange={(e) => setVersion(e.target.value)} />
          )}
        </FormField>
      </div>
      <FormField id={`${id}-description`} label={t("software.manage.description")}>
        {(field) => (
          <Input {...field} value={description} onChange={(e) => setDescription(e.target.value)} />
        )}
      </FormField>
      <FormField id={`${id}-commandFile`} label={t("software.manage.commandFile")}>
        {(field) => (
          <Input {...field} value={commandFile} onChange={(e) => setCommandFile(e.target.value)} />
        )}
      </FormField>
      <CatalogPackagePickerField selected={selectedPackage} onOpen={() => setPickerOpen(true)} />
      <SpackCatalogPickerDialog
        catalog={catalog}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={setSelectedPackage}
        search={catalogSearch}
        selected={selectedPackage}
        setPage={setCatalogPage}
        setSearch={setCatalogSearch}
        setSource={setCatalogSource}
        source={catalogSource}
      />
      <SpackSpecPickerField
        compiler={compiler}
        metadata={selectedPackage?.metadata}
        moduleName={moduleName}
        onOpen={() => setSpecOpen(true)}
        packageName={selectedPackage?.metadata?.name ?? selectedPackage?.name ?? null}
        defaultSpec={selectedPackage?.defaultSpec}
        softwareVersion={softwareVersion}
        variants={variants}
      />
      <SpackSpecConfigSheet
        compiler={compiler}
        metadata={selectedPackage?.metadata}
        moduleName={moduleName}
        onCompilerChange={setCompiler}
        onModuleNameChange={setModuleName}
        onOpenChange={setSpecOpen}
        onSoftwareVersionChange={setSoftwareVersion}
        onVariantsChange={setVariants}
        open={specOpen}
        packageName={selectedPackage?.metadata?.name ?? selectedPackage?.name ?? null}
        defaultSpec={selectedPackage?.defaultSpec}
        softwareVersion={softwareVersion}
        variants={variants}
      />
      <div className="grid gap-2 md:grid-cols-2">
        <FormField id={`${id}-inputDescriptor`} label={t("software.manage.inputDescriptor")}>
          {(field) => (
            <Input
              {...field}
              value={inputDescriptor}
              onChange={(e) => setInputDescriptor(e.target.value)}
            />
          )}
        </FormField>
        <FormField id={`${id}-argumentFormat`} label={t("software.manage.argumentFormat")}>
          {(field) => (
            <Input
              {...field}
              value={argumentFormat}
              onChange={(e) => setArgumentFormat(e.target.value)}
            />
          )}
        </FormField>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isPending}>
          <Undo2 />
          {t("software.manage.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={!selectedPackage || isPending}>
          <Save />
          {t("software.manage.publishUsecaseVersion")}
        </Button>
      </div>
    </form>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-xs" title={value}>
        {value}
      </div>
    </div>
  );
}

function spackPackageNameFromSpecName(name: string): string {
  return name.split(/[ @%]/)[0] ?? name;
}

function findCatalogPackage(
  packages: SpackCatalogPackage[],
  software: { name: string; variantRef?: string },
): SpackCatalogPackage | null {
  const byRef = software.variantRef
    ? packages.find((item) => catalogPackageKey(item) === software.variantRef)
    : undefined;
  if (byRef) return byRef;
  const packageName = spackPackageNameFromSpecName(software.name);
  const byName = packages.find((item) => item.name === packageName);
  if (byName) return byName;
  if (!packageName) return null;
  const refParts = software.variantRef?.split(":") ?? [];
  const source =
    refParts[0] === "catalog" &&
    (refParts[1] === "upstream" || refParts[1] === "official" || refParts[1] === "vendor")
      ? refParts[1]
      : "official";
  return {
    ...(software.variantRef && !software.variantRef.startsWith("catalog:")
      ? { id: software.variantRef }
      : {}),
    name: packageName,
    source,
    tags: [],
  };
}

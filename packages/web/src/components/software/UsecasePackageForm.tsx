import { CircleAlert, FlaskConical, PackagePlus } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  SpackCatalog,
  SpackCatalogPackage,
  SpackCatalogSourceFilter,
  UsecasePackageCreate,
} from "../../lib/software-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { FormField } from "../ui/form-field";
import { Input } from "../ui/input";
import { FormHeader } from "./FormHeader";
import { CatalogPackagePickerField, SpackCatalogPickerDialog } from "./SpackCatalogPicker";
import { SpackSpecConfigSheet, SpackSpecPickerField } from "./SpackSpecPicker";
import { optionalText } from "./software-fields";
import { makeUsecaseSpec } from "./spack-spec";

export function UsecasePackageForm({
  catalog,
  catalogError = null,
  catalogSearch,
  catalogSource,
  isPending = false,
  requiresActiveOrganization = false,
  onSubmit,
  setCatalogPage,
  setCatalogSearch,
  setCatalogSource,
}: {
  catalog: SpackCatalog | null;
  catalogError?: Error | null;
  catalogSearch: string;
  catalogSource: SpackCatalogSourceFilter;
  isPending?: boolean;
  requiresActiveOrganization?: boolean;
  onSubmit: (payload: UsecasePackageCreate) => void;
  setCatalogPage: (value: number) => void;
  setCatalogSearch: (value: string) => void;
  setCatalogSource: (value: SpackCatalogSourceFilter) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState("");
  const [version, setVersion] = useState("0.1.0");
  const [description, setDescription] = useState("");
  const [commandFile, setCommandFile] = useState("");
  const [inputDescriptor, setInputDescriptor] = useState("script");
  const [argumentFormat, setArgumentFormat] = useState("{}");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [specOpen, setSpecOpen] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<SpackCatalogPackage | null>(null);
  const [softwareVersion, setSoftwareVersion] = useState("");
  const [compiler, setCompiler] = useState("");
  const [moduleName, setModuleName] = useState("");
  const [variants, setVariants] = useState("");
  const catalogUnavailable = Boolean(catalogError);
  useEffect(() => {
    if (!catalogUnavailable) return;
    setSelectedPackage(null);
    setPickerOpen(false);
    setSpecOpen(false);
  }, [catalogUnavailable]);
  return (
    <form
      className="grid min-w-0 grid-cols-1 content-start gap-3 border-b border-border p-3"
      data-testid="software-usecase-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (
          catalogUnavailable ||
          !name.trim() ||
          !version.trim() ||
          !commandFile.trim() ||
          !selectedPackage
        ) {
          return;
        }
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
      <FormHeader icon={<FlaskConical />} title={t("software.manage.createUsecase")} />
      {catalogError ? (
        <div
          className="flex min-w-0 items-start gap-2 p-3 text-sm text-status-failed"
          data-testid="software-usecase-catalog-error"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">{t("common.error")}</div>
            <div className="break-words text-xs">
              {toUserFacingError(catalogError, t("software.unreachable"))}
            </div>
          </div>
        </div>
      ) : null}
      {requiresActiveOrganization ? (
        <div className="text-xs text-status-failed">
          {t("software.manage.activeOrganizationRequired")}
        </div>
      ) : null}
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
      <CatalogPackagePickerField
        disabled={catalogUnavailable}
        selected={selectedPackage}
        onOpen={() => {
          if (!catalogUnavailable) setPickerOpen(true);
        }}
      />
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
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          disabled={
            catalogUnavailable || !selectedPackage || isPending || requiresActiveOrganization
          }
        >
          <PackagePlus />
          {t("software.manage.create")}
        </Button>
      </div>
    </form>
  );
}

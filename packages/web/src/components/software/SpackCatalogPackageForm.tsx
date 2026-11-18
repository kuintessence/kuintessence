import { PackagePlus } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  parseSpackPackageFile,
  type SpackCatalogPackageCreate,
  type SpackPackageMetadata,
} from "../../lib/software-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { FormField } from "../ui/form-field";
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { optionalText, parseTagInput, sourceLabel } from "./software-fields";

export function SpackCatalogPackageForm({
  isPending = false,
  requiresActiveOrganizationForVendor = false,
  onSubmit,
}: {
  isPending?: boolean;
  requiresActiveOrganizationForVendor?: boolean;
  onSubmit: (payload: SpackCatalogPackageCreate) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState("");
  const [source, setSource] = useState<SpackCatalogPackageCreate["source"]>("official");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [packageFile, setPackageFile] = useState("");
  const [metadata, setMetadata] = useState<SpackPackageMetadata | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const currentParse = useRef<{
    nameEdited: boolean;
    descriptionEdited: boolean;
    tagsEdited: boolean;
  } | null>(null);
  useLayoutEffect(
    () => () => {
      currentParse.current = null;
    },
    [],
  );
  const parsePackage = async () => {
    const request = { nameEdited: false, descriptionEdited: false, tagsEdited: false };
    currentParse.current = request;
    setParseError(null);
    try {
      const parsed = await parseSpackPackageFile(packageFile);
      if (currentParse.current !== request) return;
      setMetadata(parsed);
      if (parsed.name && !request.nameEdited) setName(parsed.name);
      if (parsed.homepage && !request.descriptionEdited && !description.trim()) {
        setDescription(parsed.homepage);
      }
      const metadataTags = [
        ...parsed.provides.map((item) => `provides:${item}`),
        ...parsed.licenses.map((item) => `license:${item}`),
      ];
      if (metadataTags.length > 0 && !request.tagsEdited) setTags(metadataTags.join(","));
    } catch (err) {
      if (currentParse.current === request) {
        setParseError(toUserFacingError(err, t("software.unreachable")));
      }
    }
  };
  return (
    <form
      className="mt-3 grid gap-2 border-b border-border p-2"
      data-testid="software-spack-catalog-create-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSubmit({
          name: name.trim(),
          source,
          description: optionalText(description),
          tags: parseTagInput(tags),
          packageFile: optionalText(packageFile),
        });
      }}
    >
      <div className="grid gap-2 md:grid-cols-[1fr_150px]">
        <FormField id={`${id}-name`} label={t("software.manage.catalogPackageName")}>
          {(field) => (
            <Input
              {...field}
              value={name}
              onChange={(e) => {
                if (currentParse.current) currentParse.current.nameEdited = true;
                setName(e.target.value);
              }}
            />
          )}
        </FormField>
        <label htmlFor={`${id}-source`} className="grid min-w-0 gap-1.5 text-sm">
          <span>{t("software.manage.catalogPackageSource")}</span>
          <NativeSelect
            id={`${id}-source`}
            value={source}
            onChange={(e) => setSource(e.target.value as SpackCatalogPackageCreate["source"])}
            aria-label={t("software.manage.catalogPackageSource")}
          >
            <option value="official">{sourceLabel(t, "official")}</option>
            <option value="vendor">{sourceLabel(t, "vendor")}</option>
          </NativeSelect>
        </label>
      </div>
      {source === "vendor" && requiresActiveOrganizationForVendor ? (
        <div className="text-xs text-status-failed">
          {t("software.manage.activeOrganizationRequired")}
        </div>
      ) : null}
      <FormField id={`${id}-description`} label={t("software.manage.catalogPackageDescription")}>
        {(field) => (
          <Input
            {...field}
            value={description}
            onChange={(e) => {
              if (currentParse.current) currentParse.current.descriptionEdited = true;
              setDescription(e.target.value);
            }}
          />
        )}
      </FormField>
      <label htmlFor={`${id}-packageFile`} className="grid min-w-0 gap-1.5 text-sm">
        <span>package.py</span>
        <Textarea
          id={`${id}-packageFile`}
          value={packageFile}
          onChange={(e) => {
            currentParse.current = null;
            setPackageFile(e.target.value);
            setMetadata(null);
            setParseError(null);
          }}
          placeholder={t("software.manage.packageFilePlaceholder")}
          className="min-h-32 font-mono text-xs"
          data-testid="software-spack-package-file"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={parsePackage}
          disabled={!packageFile.trim()}
          data-testid="software-spack-parse-package-file"
        >
          {t("software.manage.parsePackageFile")}
        </Button>
        {parseError ? <span className="text-xs text-status-failed">{parseError}</span> : null}
      </div>
      {metadata ? <SpackPackageMetadataSummary metadata={metadata} /> : null}
      <div className="grid items-end gap-2 md:grid-cols-[1fr_auto]">
        <FormField id={`${id}-tags`} label={t("software.manage.catalogPackageTags")}>
          {(field) => (
            <Input
              {...field}
              value={tags}
              onChange={(e) => {
                if (currentParse.current) currentParse.current.tagsEdited = true;
                setTags(e.target.value);
              }}
            />
          )}
        </FormField>
        <Button
          type="submit"
          size="sm"
          disabled={isPending || (source === "vendor" && requiresActiveOrganizationForVendor)}
        >
          <PackagePlus />
          {t("software.manage.createCatalogPackage")}
        </Button>
      </div>
    </form>
  );
}

function SpackPackageMetadataSummary({ metadata }: { metadata: SpackPackageMetadata }) {
  const { t } = useTranslation();
  return (
    <div
      className="grid gap-2 border-border p-2 text-xs"
      data-testid="software-spack-package-metadata"
    >
      <div className="font-medium text-foreground">{t("software.manage.packageMetadata")}</div>
      <div className="flex flex-wrap gap-1">
        <Badge variant="outline">{metadata.name ?? "package.py"}</Badge>
        <Badge variant="outline">
          {t("software.manage.versionCount", { count: metadata.versions.length })}
        </Badge>
        <Badge variant="outline">
          {t("software.manage.variantCount", { count: metadata.variants.length })}
        </Badge>
        {metadata.licenses.map((license) => (
          <Badge key={license} variant="outline">
            license:{license}
          </Badge>
        ))}
      </div>
      {metadata.variants.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {metadata.variants.slice(0, 12).map((variant) => (
            <Badge key={variant.name} variant="outline">
              {variant.name}
              {variant.values.length > 0 ? `=${variant.values.join("|")}` : ""}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

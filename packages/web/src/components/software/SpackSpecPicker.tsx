import { Edit3, Save } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  parseSpackCompilers,
  type SpackCompilerMetadata,
  type SpackPackageMetadata,
  type SpackVariantMetadata,
} from "../../lib/software-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { FormField } from "../ui/form-field";
import { Input, Textarea } from "../ui/input";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { makeSpackSpecPreview } from "./spack-spec";

export function SpackSpecPickerField({
  defaultSpec,
  compiler,
  metadata,
  moduleName,
  onOpen,
  packageName,
  softwareVersion,
  variants,
}: {
  defaultSpec?: string;
  compiler: string;
  metadata?: SpackPackageMetadata;
  moduleName: string;
  onOpen: () => void;
  packageName: string | null;
  softwareVersion: string;
  variants: string;
}) {
  const { t } = useTranslation();
  const preview = packageName
    ? makeSpackSpecPreview(packageName, softwareVersion, compiler, variants, defaultSpec)
    : "";
  return (
    <div
      className="flex min-w-0 flex-col gap-2 border-border p-2 sm:flex-row sm:items-center sm:justify-between"
      data-testid="software-usecase-spec-field"
    >
      <div className="min-w-0">
        <div className="text-[11px] text-muted-foreground">
          {t("software.manage.selectedSpackSpec")}
        </div>
        {preview ? (
          <div className="mt-1 min-w-0 space-y-1">
            <div
              className="break-all font-mono text-sm font-semibold"
              data-testid="software-usecase-spack-spec-preview"
            >
              {preview}
            </div>
            <div className="text-xs text-muted-foreground">
              {[softwareVersion, compiler, moduleName, variants].filter(Boolean).join(" · ") ||
                t("software.manage.noSpecOptions")}
            </div>
            {metadata ? (
              <div className="mt-1 flex flex-wrap gap-1">
                <Badge variant="outline">
                  {t("software.manage.versionCount", { count: metadata.versions.length })}
                </Badge>
                <Badge variant="outline">
                  {t("software.manage.variantCount", { count: metadata.variants.length })}
                </Badge>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-1 text-sm text-muted-foreground">
            {t("software.manage.noSpackSpec")}
          </div>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onOpen}
        disabled={!packageName}
        data-testid="software-usecase-open-spec-picker"
      >
        <Edit3 />
        {t("software.manage.configureSpackSpec")}
      </Button>
    </div>
  );
}

export function SpackSpecConfigSheet({
  defaultSpec,
  compiler,
  metadata,
  moduleName,
  onCompilerChange,
  onModuleNameChange,
  onOpenChange,
  onSoftwareVersionChange,
  onVariantsChange,
  open,
  packageName,
  softwareVersion,
  variants,
}: {
  defaultSpec?: string;
  compiler: string;
  metadata?: SpackPackageMetadata;
  moduleName: string;
  onCompilerChange: (value: string) => void;
  onModuleNameChange: (value: string) => void;
  onOpenChange: (value: boolean) => void;
  onSoftwareVersionChange: (value: string) => void;
  onVariantsChange: (value: string) => void;
  open: boolean;
  packageName: string | null;
  softwareVersion: string;
  variants: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const preview = packageName
    ? makeSpackSpecPreview(packageName, softwareVersion, compiler, variants, defaultSpec)
    : "";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent width="max-w-2xl" data-testid="software-usecase-spec-picker">
        <SheetHeader>
          <SheetTitle>{t("software.manage.specPickerTitle")}</SheetTitle>
          <SheetDescription>{t("software.manage.specPickerDescription")}</SheetDescription>
        </SheetHeader>
        <SheetBody className="grid content-start gap-3">
          <div className=" border-border p-3">
            <div className="text-[11px] text-muted-foreground">
              {t("software.manage.spackSpec")}
            </div>
            <div className="mt-1 break-all font-mono text-sm font-semibold">
              {preview || t("software.manage.noSpackSpec")}
            </div>
          </div>
          {metadata ? (
            <SpackMetadataChoices
              metadata={metadata}
              onSoftwareVersionChange={onSoftwareVersionChange}
              onVariantsChange={onVariantsChange}
              variants={variants}
            />
          ) : null}
          <CompilerParseBox onCompilerChange={onCompilerChange} />
          <div className="grid gap-2 md:grid-cols-2">
            <FormField id={`${id}-softwareVersion`} label={t("software.manage.softwareVersion")}>
              {(field) => (
                <Input
                  {...field}
                  value={softwareVersion}
                  onChange={(e) => onSoftwareVersionChange(e.target.value)}
                  data-testid="software-usecase-spec-version"
                />
              )}
            </FormField>
            <FormField id={`${id}-compiler`} label={t("software.manage.compiler")}>
              {(field) => (
                <Input
                  {...field}
                  value={compiler}
                  onChange={(e) => onCompilerChange(e.target.value)}
                  data-testid="software-usecase-spec-compiler"
                />
              )}
            </FormField>
            <FormField id={`${id}-moduleName`} label={t("software.manage.module")}>
              {(field) => (
                <Input
                  {...field}
                  value={moduleName}
                  onChange={(e) => onModuleNameChange(e.target.value)}
                  data-testid="software-usecase-spec-module"
                />
              )}
            </FormField>
            <FormField id={`${id}-variants`} label={t("software.manage.variants")}>
              {(field) => (
                <Input
                  {...field}
                  value={variants}
                  onChange={(e) => onVariantsChange(e.target.value)}
                  data-testid="software-usecase-spec-variants"
                />
              )}
            </FormField>
          </div>
        </SheetBody>
        <SheetFooter className="flex justify-end">
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            <Save />
            {t("software.manage.applySpec")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function SpackMetadataChoices({
  metadata,
  onSoftwareVersionChange,
  onVariantsChange,
  variants,
}: {
  metadata: SpackPackageMetadata;
  onSoftwareVersionChange: (value: string) => void;
  onVariantsChange: (value: string) => void;
  variants: string;
}) {
  const { t } = useTranslation();
  const visibleVersions = metadata.versions.slice(0, 10);
  return (
    <div className="grid gap-3 border-border p-3">
      <div className="text-xs font-medium text-foreground">
        {t("software.manage.packageMetadata")}
      </div>
      {visibleVersions.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground">{t("software.manage.versions")}</div>
          <div className="kq-fill-row gap-1.5">
            {visibleVersions.map((version) => (
              <Button
                key={version}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onSoftwareVersionChange(version)}
              >
                {version}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {metadata.variants.length > 0 ? (
        <div className="space-y-2">
          <div className="text-[11px] text-muted-foreground">{t("software.manage.variants")}</div>
          {metadata.variants.map((variant) => (
            <VariantChoice
              key={variant.name}
              onVariantsChange={onVariantsChange}
              variant={variant}
              variants={variants}
            />
          ))}
        </div>
      ) : null}
      {metadata.provides.length > 0 || metadata.dependencies.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {[
            ...metadata.provides.map((item) => `provides:${item}`),
            ...metadata.dependencies.map((item) => `dep:${item}`),
          ].map((item) => (
            <Badge key={item} variant="outline">
              {item}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function VariantChoice({
  onVariantsChange,
  variant,
  variants,
}: {
  onVariantsChange: (value: string) => void;
  variant: SpackVariantMetadata;
  variants: string;
}) {
  const values = variant.values.length > 0 ? variant.values : ["+", "~"];
  return (
    <div className=" border-border p-2">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold">{variant.name}</div>
          {variant.description ? (
            <div className="mt-1 text-[11px] text-muted-foreground">{variant.description}</div>
          ) : null}
        </div>
        {variant.default ? <Badge variant="outline">default:{variant.default}</Badge> : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {values.map((value) => {
          const token =
            value === "+" || value === "~" ? `${value}${variant.name}` : `${variant.name}=${value}`;
          return (
            <Button
              key={token}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onVariantsChange(setVariantToken(variants, variant.name, token))}
            >
              {token}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function CompilerParseBox({ onCompilerChange }: { onCompilerChange: (value: string) => void }) {
  const { t } = useTranslation();
  const [source, setSource] = useState("");
  const [compilers, setCompilers] = useState<SpackCompilerMetadata[]>([]);
  const [error, setError] = useState<string | null>(null);
  const currentParse = useRef<symbol | null>(null);
  useLayoutEffect(
    () => () => {
      currentParse.current = null;
    },
    [],
  );
  const parse = async () => {
    const request = Symbol();
    currentParse.current = request;
    setError(null);
    try {
      const parsed = await parseSpackCompilers(source);
      if (currentParse.current === request) setCompilers(parsed);
    } catch (err) {
      if (currentParse.current === request) {
        setError(toUserFacingError(err, t("software.unreachable")));
      }
    }
  };
  return (
    <div className="grid gap-2 border-border p-3">
      <div className="text-xs font-medium text-foreground">
        {t("software.manage.compilerParser")}
      </div>
      <Textarea
        value={source}
        onChange={(e) => {
          currentParse.current = null;
          setSource(e.target.value);
          setCompilers([]);
          setError(null);
        }}
        placeholder={t("software.manage.compilerParserPlaceholder")}
        className="min-h-20 font-mono text-xs"
        data-testid="software-usecase-compiler-source"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={parse} disabled={!source.trim()}>
          {t("software.manage.parseCompiler")}
        </Button>
        {error ? <span className="text-xs text-status-failed">{error}</span> : null}
      </div>
      {compilers.length > 0 ? (
        <div className="kq-fill-row gap-1.5" data-testid="software-usecase-compiler-options">
          {compilers.map((compiler) => (
            <Button
              key={compiler.spec}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onCompilerChange(compiler.spec)}
            >
              {compiler.spec}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function setVariantToken(current: string, variantName: string, token: string): string {
  const tokens = current
    .split(/\s+/)
    .filter((item) => item.length > 0)
    .filter(
      (item) =>
        item !== `+${variantName}` &&
        item !== `~${variantName}` &&
        !item.startsWith(`${variantName}=`),
    );
  return [...tokens, token].join(" ");
}

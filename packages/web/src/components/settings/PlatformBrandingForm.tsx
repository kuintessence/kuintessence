import {
  type BrandingLang,
  EMPTY_PLATFORM_BRANDING,
  type PlatformBranding,
  type PlatformBrandingLocale,
  PlatformBrandingSchema,
  type PlatformBrandingView,
} from "@kuintessence/shared/browser";
import { Image, Loader2, Palette, Save } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import defaultLogoUrl from "../../assets/logo.svg";
import { api } from "../../lib/api-client";
import { resolveImageSource } from "../../lib/platform-branding";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

const LANGUAGE_ROWS: ReadonlyArray<{ code: BrandingLang; labelKey: string }> = [
  { code: "zh", labelKey: "settings.branding.languages.zh" },
  { code: "en", labelKey: "settings.branding.languages.en" },
];

type LocaleField = keyof PlatformBrandingLocale;

const LOCALE_FIELDS: ReadonlyArray<{ key: LocaleField; labelKey: string; placeholderKey: string }> =
  [
    {
      key: "name",
      labelKey: "settings.branding.name",
      placeholderKey: "settings.branding.namePlaceholder",
    },
    {
      key: "title",
      labelKey: "settings.branding.title",
      placeholderKey: "settings.branding.titlePlaceholder",
    },
    {
      key: "subtitle",
      labelKey: "settings.branding.subtitle",
      placeholderKey: "settings.branding.subtitlePlaceholder",
    },
    {
      key: "welcome",
      labelKey: "settings.branding.welcome",
      placeholderKey: "settings.branding.welcomePlaceholder",
    },
  ];

function toForm(value: unknown): PlatformBranding {
  const parsed = PlatformBrandingSchema.safeParse(value);
  return parsed.success ? parsed.data : structuredClone(EMPTY_PLATFORM_BRANDING);
}

export function PlatformBrandingForm() {
  const { t } = useTranslation();
  const [state, setState] = useState<PlatformBranding | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<PlatformBrandingView>("/admin/branding")
      .then((view) => {
        if (!cancelled) setState(toForm(view));
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            toUserFacingError(
              error,
              t("settings.branding.loadFailed", {
                defaultValue: "暂时无法加载平台 branding 配置，请稍后重试。",
              }),
            ),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  if (loadError) {
    return (
      <Card data-testid="platform-branding-form">
        <CardHeader>
          <CardTitle>
            {t("settings.branding.titleCard", { defaultValue: "平台 Branding" })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-status-failed" data-testid="platform-branding-load-error">
            {loadError}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!state) {
    return (
      <Card data-testid="platform-branding-form">
        <CardHeader>
          <CardTitle>
            {t("settings.branding.titleCard", { defaultValue: "Platform branding" })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common.loading", { defaultValue: "Loading…" })}
          </div>
        </CardContent>
      </Card>
    );
  }

  function updateLocale(language: BrandingLang, field: LocaleField, value: string) {
    setState((previous) =>
      previous
        ? {
            ...previous,
            locales: {
              ...previous.locales,
              [language]: { ...previous.locales[language], [field]: value },
            },
          }
        : previous,
    );
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (!state) return;
    const parsed = PlatformBrandingSchema.safeParse(state);
    if (!parsed.success) {
      toast.error(
        t("settings.branding.invalid", {
          defaultValue: "请检查 branding 文案和图片 URL。",
        }),
      );
      return;
    }
    setSaving(true);
    try {
      const saved = await api.put<PlatformBrandingView>("/admin/branding", parsed.data);
      setState(toForm(saved));
      toast.success(t("settings.branding.saved", { defaultValue: "平台 branding 已保存。" }));
    } catch (error) {
      toast.error(
        toUserFacingError(
          error,
          t("settings.branding.saveFailed", {
            defaultValue: "保存平台 branding 失败，请稍后重试。",
          }),
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  const previewLogo = resolveImageSource(state.logoUrl, defaultLogoUrl);
  const previewFavicon = resolveImageSource(state.faviconUrl || state.logoUrl, defaultLogoUrl);

  return (
    <Card data-testid="platform-branding-form">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted/35">
            <Palette className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <CardTitle>
              {t("settings.branding.titleCard", { defaultValue: "平台 Branding" })}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("settings.branding.description", {
                defaultValue:
                  "按支持的语言配置平台名称、登录展示文案与图片资源。留空会回退到系统默认值。",
              })}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={onSave}>
          <div className="grid gap-5 lg:grid-cols-2">
            {LANGUAGE_ROWS.map(({ code, labelKey }) => (
              <section key={code} className="space-y-3 rounded-lg border border-border p-4">
                <h3 className="text-sm font-semibold">{t(labelKey)}</h3>
                {LOCALE_FIELDS.map(({ key, labelKey: fieldLabelKey, placeholderKey }) => (
                  <div key={key} className="space-y-1.5">
                    <label
                      htmlFor={`platform-branding-${code}-${key}`}
                      className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      {t(fieldLabelKey)}
                    </label>
                    <Input
                      id={`platform-branding-${code}-${key}`}
                      value={state.locales[code][key]}
                      onChange={(event) => updateLocale(code, key, event.target.value)}
                      placeholder={t(placeholderKey)}
                      maxLength={key === "name" ? 80 : key === "title" ? 120 : 240}
                      data-testid={`platform-branding-${code}-${key}`}
                    />
                  </div>
                ))}
              </section>
            ))}
          </div>

          <section className="space-y-3 rounded-lg border border-border p-4">
            <div>
              <h3 className="text-sm font-semibold">{t("settings.branding.assetsTitle")}</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("settings.branding.assetsDescription")}
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="platform-branding-logo-url"
                  className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {t("settings.branding.logoUrl")}
                </label>
                <Input
                  id="platform-branding-logo-url"
                  value={state.logoUrl}
                  onChange={(event) => setState({ ...state, logoUrl: event.target.value })}
                  placeholder={t("settings.branding.imagePlaceholder")}
                  data-testid="platform-branding-logo-url"
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="platform-branding-favicon-url"
                  className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {t("settings.branding.faviconUrl")}
                </label>
                <Input
                  id="platform-branding-favicon-url"
                  value={state.faviconUrl}
                  onChange={(event) => setState({ ...state, faviconUrl: event.target.value })}
                  placeholder={t("settings.branding.imagePlaceholder")}
                  data-testid="platform-branding-favicon-url"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 rounded-md bg-muted/25 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="flex h-10 w-10 items-center justify-center rounded-md border bg-background">
                  <img src={previewLogo} alt="" className="max-h-7 max-w-7" />
                </span>
                <span>{t("settings.branding.logoPreview")}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="flex h-10 w-10 items-center justify-center rounded-md border bg-background">
                  <img src={previewFavicon} alt="" className="max-h-5 max-w-5" />
                </span>
                <span>{t("settings.branding.faviconPreview")}</span>
              </div>
              <Image className="ml-auto h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </div>
          </section>

          <div className="flex justify-end">
            <Button type="submit" disabled={saving} data-testid="platform-branding-save">
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              {saving ? t("common.saving", { defaultValue: "Saving…" }) : t("common.save")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

import type { PlatformBranding, ResolvedPlatformBranding } from "@kuintessence/shared/browser";
import {
  EMPTY_PLATFORM_BRANDING,
  PlatformBrandingSchema,
  resolvePlatformBranding,
} from "@kuintessence/shared/browser";
import { useEffect, useState } from "react";
import { api } from "./api-client";

export function normalizePlatformBranding(value: unknown): PlatformBranding {
  const parsed = PlatformBrandingSchema.safeParse(value);
  return parsed.success ? parsed.data : structuredClone(EMPTY_PLATFORM_BRANDING);
}

export function resolveBrandingForLanguage(
  branding: PlatformBranding,
  language: string,
): ResolvedPlatformBranding {
  return resolvePlatformBranding(branding, language);
}

export function resolveImageSource(value: string, fallback: string): string {
  const candidate = value.trim();
  if (!candidate) return fallback;
  return PlatformBrandingSchema.shape.logoUrl.safeParse(candidate).success ? candidate : fallback;
}

export function usePlatformBranding(enabled: boolean): PlatformBranding {
  const [branding, setBranding] = useState<PlatformBranding>(() =>
    structuredClone(EMPTY_PLATFORM_BRANDING),
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .get<unknown>("/branding")
      .then((value) => {
        if (!cancelled) setBranding(normalizePlatformBranding(value));
      })
      .catch(() => {
        // Branding is enhancement-only; a missing or legacy public endpoint
        // must leave the bundled defaults usable.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return branding;
}

export function applyPlatformBrandingDocument(
  branding: PlatformBranding,
  language: string,
  fallbackLogo: string,
): void {
  const resolved = resolveBrandingForLanguage(branding, language);
  const requestedTitle = language.toLowerCase().startsWith("en")
    ? branding.locales.en.title
    : branding.locales.zh.title;
  document.title = requestedTitle || branding.locales.zh.title || resolved.name;
  const favicon = resolveImageSource(resolved.faviconUrl || resolved.logoUrl, fallbackLogo);
  let link = document.head.querySelector<HTMLLinkElement>('link[data-kq-platform-favicon="true"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.dataset.kqPlatformFavicon = "true";
    document.head.appendChild(link);
  }
  link.href = favicon;
}

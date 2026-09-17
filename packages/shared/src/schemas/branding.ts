import { z } from "zod";

export const BRANDING_LANGS = ["zh", "en"] as const;
export type BrandingLang = (typeof BRANDING_LANGS)[number];

/**
 * Stable same-origin assets shipped by every production Web image. Custom
 * assets must use an HTTPS URL; accepting arbitrary local paths would let an
 * administrator save a URL that is not present after a Vite production build.
 */
export const PLATFORM_BRANDING_ASSET_PATHS = {
  logo: "/branding/logo.svg",
  favicon: "/branding/favicon.svg",
} as const;

const SUPPORTED_SAME_ORIGIN_IMAGE_SOURCES: ReadonlySet<string> = new Set(
  Object.values(PLATFORM_BRANDING_ASSET_PATHS),
);

const EMPTY_LOCALE = {
  name: "",
  title: "",
  subtitle: "",
  welcome: "",
};

export const PlatformBrandingLocaleSchema = z.object({
  /** Short product name used in the sidebar and image alt text. */
  name: z.string().trim().max(80).default(""),
  /** Login heading and browser document title. */
  title: z.string().trim().max(120).default(""),
  /** Supporting text shown below the login heading. */
  subtitle: z.string().trim().max(240).default(""),
  /** Optional message shown below the login controls. */
  welcome: z.string().trim().max(240).default(""),
});
export type PlatformBrandingLocale = z.infer<typeof PlatformBrandingLocaleSchema>;

export const PlatformBrandingLocalesSchema = z.object({
  zh: PlatformBrandingLocaleSchema.default(EMPTY_LOCALE),
  en: PlatformBrandingLocaleSchema.default(EMPTY_LOCALE),
});
export type PlatformBrandingLocales = z.infer<typeof PlatformBrandingLocalesSchema>;

/**
 * Image references are deliberately URL-only configuration. Only the stable
 * same-origin assets shipped by the Web image are accepted locally; HTTPS
 * URLs work for a separately hosted asset store. Script, data, blob,
 * protocol-relative, and credential-bearing URLs are rejected before they
 * reach an <img> or <link>.
 */
export function isSafeImageSource(value: string): boolean {
  const candidate = value.trim();
  if (candidate.length === 0) return true;
  if (
    candidate.length > 2048 ||
    [...candidate].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return false;
  }
  if (candidate.includes("\\")) return false;
  if (candidate.startsWith("/") && !candidate.startsWith("//")) {
    return SUPPORTED_SAME_ORIGIN_IMAGE_SOURCES.has(candidate);
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.hash.length === 0
  );
}

export const SafeImageSourceSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(isSafeImageSource, "Image URL must be a bundled /branding path or a safe HTTPS URL");

export const PlatformBrandingSchema = z.object({
  locales: PlatformBrandingLocalesSchema.default({
    zh: EMPTY_LOCALE,
    en: EMPTY_LOCALE,
  }),
  logoUrl: SafeImageSourceSchema.default(""),
  faviconUrl: SafeImageSourceSchema.default(""),
});
export type PlatformBranding = z.infer<typeof PlatformBrandingSchema>;

export const PlatformBrandingViewSchema = PlatformBrandingSchema.extend({
  updatedAt: z.string().datetime().nullable(),
  updatedBy: z.string().nullable(),
});
export type PlatformBrandingView = z.infer<typeof PlatformBrandingViewSchema>;

/**
 * Empty persisted values intentionally mean "use this built-in default".
 * Keeping defaults outside the database makes an older deployment's missing
 * row and a newly migrated empty row behave identically.
 */
export const DEFAULT_PLATFORM_BRANDING_LOCALES: Record<BrandingLang, PlatformBrandingLocale> = {
  zh: {
    name: "Kuintessence",
    title: "登录 Kuintessence",
    subtitle: "联邦 HPC 控制台",
    welcome: "欢迎使用 Kuintessence 算力网络平台",
  },
  en: {
    name: "Kuintessence",
    title: "Sign in to Kuintessence",
    subtitle: "Federated HPC console",
    welcome: "Welcome to the Kuintessence computing network platform",
  },
};

export const EMPTY_PLATFORM_BRANDING: PlatformBranding = {
  locales: {
    zh: { ...EMPTY_LOCALE },
    en: { ...EMPTY_LOCALE },
  },
  logoUrl: "",
  faviconUrl: "",
};

export interface ResolvedPlatformBranding extends PlatformBrandingLocale {
  logoUrl: string;
  faviconUrl: string;
}

export function resolvePlatformBranding(
  branding: PlatformBranding,
  language: string,
): ResolvedPlatformBranding {
  const requested: BrandingLang = language.toLowerCase().startsWith("en") ? "en" : "zh";
  const primary = branding.locales[requested];
  const fallback = branding.locales.zh;
  const defaults = DEFAULT_PLATFORM_BRANDING_LOCALES[requested];
  return {
    name: primary.name || fallback.name || defaults.name,
    title: primary.title || fallback.title || defaults.title,
    subtitle: primary.subtitle || fallback.subtitle || defaults.subtitle,
    welcome: primary.welcome || fallback.welcome || defaults.welcome,
    logoUrl: branding.logoUrl,
    faviconUrl: branding.faviconUrl,
  };
}

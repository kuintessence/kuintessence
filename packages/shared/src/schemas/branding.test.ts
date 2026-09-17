import { describe, expect, test } from "bun:test";
import {
  EMPTY_PLATFORM_BRANDING,
  PLATFORM_BRANDING_ASSET_PATHS,
  PlatformBrandingSchema,
  resolvePlatformBranding,
  SafeImageSourceSchema,
} from "./branding";

describe("platform branding schema", () => {
  test("accepts same-origin and HTTPS image references", () => {
    expect(SafeImageSourceSchema.parse(PLATFORM_BRANDING_ASSET_PATHS.logo)).toBe(
      PLATFORM_BRANDING_ASSET_PATHS.logo,
    );
    expect(SafeImageSourceSchema.parse(PLATFORM_BRANDING_ASSET_PATHS.favicon)).toBe(
      PLATFORM_BRANDING_ASSET_PATHS.favicon,
    );
    expect(SafeImageSourceSchema.parse("https://cdn.example.com/logo.png")).toBe(
      "https://cdn.example.com/logo.png",
    );
  });

  test("rejects unsupported local paths and executable or credential-bearing references", () => {
    for (const value of [
      "/assets/logo.svg",
      "/branding/unknown.svg",
      "javascript:alert(1)",
      "data:image/svg+xml,<svg>",
      "blob:https://example.com/id",
      "//cdn.example.com/logo.png",
      "https://user:password@example.com/logo.png",
      "http://10.0.0.2/logo.png",
      "http://localhost:3000/logo.png",
    ]) {
      expect(() => SafeImageSourceSchema.parse(value)).toThrow();
    }
  });

  test("uses the requested language, then Chinese, then built-in defaults", () => {
    const branding = PlatformBrandingSchema.parse({
      locales: {
        zh: { name: "科研平台", title: "科研平台", subtitle: "", welcome: "" },
        en: { name: "", title: "", subtitle: "", welcome: "" },
      },
    });
    expect(resolvePlatformBranding(branding, "en-US")).toMatchObject({
      name: "科研平台",
      title: "科研平台",
      subtitle: "Federated HPC console",
      welcome: "Welcome to the Kuintessence computing network platform",
    });
    expect(resolvePlatformBranding(EMPTY_PLATFORM_BRANDING, "fr")).toMatchObject({
      name: "Kuintessence",
      title: "登录 Kuintessence",
    });
  });
});

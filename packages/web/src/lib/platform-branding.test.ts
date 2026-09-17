import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  applyPlatformBrandingDocument,
  normalizePlatformBranding,
  resolveBrandingForLanguage,
  resolveImageSource,
} from "./platform-branding";

const STABLE_BRANDING_ASSET_PATHS = ["/branding/logo.svg", "/branding/favicon.svg"] as const;

describe("platform branding browser helpers", () => {
  test("ships both stable same-origin branding assets in the Web public tree", () => {
    for (const assetPath of STABLE_BRANDING_ASSET_PATHS) {
      const assetFile = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../public",
        assetPath.slice(1),
      );
      expect(existsSync(assetFile), assetFile).toBe(true);
    }
  });

  test("normalizes legacy or malformed public payloads to built-in defaults", () => {
    const branding = normalizePlatformBranding({
      locales: { zh: { name: "科研平台" } },
      logoUrl: "javascript:alert(1)",
    });

    expect(resolveBrandingForLanguage(branding, "en-US")).toMatchObject({
      name: "Kuintessence",
      title: "Sign in to Kuintessence",
      logoUrl: "",
    });
  });

  test("resolves configured language and uses the safe fallback for an image", () => {
    const branding = normalizePlatformBranding({
      locales: {
        zh: { name: "科研平台", title: "登录科研平台" },
        en: { name: "Research Platform", title: "Sign in to Research Platform" },
      },
      logoUrl: "https://assets.example.test/logo.svg",
    });

    expect(resolveBrandingForLanguage(branding, "en-US")).toMatchObject({
      name: "Research Platform",
      title: "Sign in to Research Platform",
      logoUrl: "https://assets.example.test/logo.svg",
    });
    expect(resolveImageSource("javascript:alert(1)", STABLE_BRANDING_ASSET_PATHS[0])).toBe(
      STABLE_BRANDING_ASSET_PATHS[0],
    );
  });

  test("updates one managed favicon link and the browser title", () => {
    document.head.innerHTML = "";
    const branding = normalizePlatformBranding({
      locales: { en: { title: "Research Platform" } },
      faviconUrl: "/branding/favicon.svg",
    });

    applyPlatformBrandingDocument(branding, "en-US", STABLE_BRANDING_ASSET_PATHS[0]);
    applyPlatformBrandingDocument(branding, "en-US", STABLE_BRANDING_ASSET_PATHS[0]);

    expect(document.title).toBe("Research Platform");
    expect(document.head.querySelectorAll('link[data-kq-platform-favicon="true"]')).toHaveLength(1);
    expect(
      document.head.querySelector('link[data-kq-platform-favicon="true"]')?.getAttribute("href"),
    ).toBe("/branding/favicon.svg");
  });

  test("keeps the platform name as the document-title fallback", () => {
    document.head.innerHTML = "";
    applyPlatformBrandingDocument(
      normalizePlatformBranding({}),
      "en-US",
      STABLE_BRANDING_ASSET_PATHS[0],
    );

    expect(document.title).toBe("Kuintessence");
  });
});

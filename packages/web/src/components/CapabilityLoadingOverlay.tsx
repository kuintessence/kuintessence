import { EMPTY_PLATFORM_BRANDING, type PlatformBranding } from "@kuintessence/shared/browser";
import { LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import defaultLogoUrl from "../assets/logo.svg";
import { resolveBrandingForLanguage, resolveImageSource } from "../lib/platform-branding";
import type { CapabilityLoadState } from "../lib/platform-capabilities";
import { Button } from "./ui/button";

const MIN_VISIBLE_MS = 320;
const EXIT_MS = 180;

export function CapabilityLoadingOverlay({
  state,
  branding = EMPTY_PLATFORM_BRANDING,
  onRetry,
}: {
  state: CapabilityLoadState;
  branding?: PlatformBranding;
  onRetry: () => void;
}) {
  const { i18n, t } = useTranslation();
  const brandingLanguage = i18n?.resolvedLanguage ?? i18n?.language ?? "zh";
  const localizedBranding = resolveBrandingForLanguage(branding, brandingLanguage);
  const overlayLogo = resolveImageSource(localizedBranding.logoUrl, defaultLogoUrl);
  const [mounted, setMounted] = useState(state.status !== "idle");
  const [visible, setVisible] = useState(state.status !== "idle");
  const [shownAt, setShownAt] = useState(() => Date.now());

  useEffect(() => {
    if (state.status === "loading" || state.status === "error") {
      setMounted(true);
      setVisible(true);
      setShownAt(Date.now());
      return;
    }
    if (!mounted) return;
    const remaining = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt));
    const fadeTimer = window.setTimeout(() => setVisible(false), remaining);
    const unmountTimer = window.setTimeout(() => setMounted(false), remaining + EXIT_MS);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(unmountTimer);
    };
  }, [mounted, shownAt, state.status]);

  if (!mounted) return null;
  const failed = state.status === "error";
  return (
    <div
      data-testid="capability-loading-overlay"
      role={failed ? "alert" : "status"}
      aria-live="polite"
      aria-busy={!failed}
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-background/95 px-6 backdrop-blur-md transition-opacity duration-200 motion-reduce:transition-none ${
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="relative mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border bg-card shadow-lg">
          <img src={overlayLogo} alt="" className="h-9 w-9" />
          {!failed ? (
            <span className="absolute -bottom-2 -right-2 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
              <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            </span>
          ) : null}
        </div>
        <h1 className="text-lg font-semibold">
          {failed ? t("workspace.capabilitiesFailed") : t("workspace.preparingWorkspace")}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {failed
            ? t("workspace.capabilitiesFailedDescription")
            : t("workspace.preparingWorkspaceDescription")}
        </p>
        {failed ? (
          <Button className="mt-5" onClick={onRetry}>
            <RefreshCw />
            {t("workspace.retryCapabilities")}
          </Button>
        ) : (
          <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-primary" />
            {t("workspace.verifyingAccess")}
          </div>
        )}
      </div>
    </div>
  );
}

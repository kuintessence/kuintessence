type Translate = (key: string, options?: { defaultValue?: string }) => string;

const EXACT_REASON_KEYS: Record<string, string> = {
  "agent control channel is offline": "offline",
  "asset use permission denied": "usePermission",
  "blocked by provider deny list": "providerDenyList",
  "blocked by usecase deny list": "usecaseDenyList",
  "installable availability was not requested": "installNotRequested",
  "not present in provider allow list while lock is enabled": "providerAllowList",
  "principal lacks install permission": "installPermission",
  "provider policy only allows preinstalled software": "preinstalledOnly",
  "usecase is not allowed by provider usecase policy": "usecasePolicy",
};

export function softwareAvailabilityReason(reason: string, t: Translate): string {
  const key = EXACT_REASON_KEYS[reason];
  if (key) return t(`software.availabilityReason.${key}`);
  if (/^asset lifecycle '.+' blocks scheduling$/.test(reason)) {
    return t("software.availabilityReason.lifecycle");
  }
  if (/^(LICENSE|RUNTIME)_[A-Z0-9_]+:/.test(reason)) {
    return t("software.availabilityReason.governance");
  }
  return t("software.availabilityReason.generic");
}

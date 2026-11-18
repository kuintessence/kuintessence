import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PolicyOverlayInput } from "../../lib/cp-client";
import { Badge } from "../ui/badge";

export function StatusBadge({
  status,
  runtimeStatus,
  lastHeartbeat,
}: {
  status: string;
  runtimeStatus?: string;
  lastHeartbeat?: string | null;
}) {
  const { t } = useTranslation();
  const visibleStatus = runtimeStatus ?? status;
  const variant =
    visibleStatus === "online" ? "succeeded" : visibleStatus === "unhealthy" ? "failed" : "outline";
  return (
    <Badge
      variant={variant}
      title={t("cp.software.agent.statusTooltip", {
        dbStatus: status,
        lastHeartbeat: lastHeartbeat ?? "-",
      })}
    >
      {visibleStatus}
    </Badge>
  );
}

export function ControlChannelBadge({ online }: { online: boolean }) {
  const { t } = useTranslation();
  return (
    <Badge variant={online ? "succeeded" : "failed"}>
      {online
        ? t("cp.software.agent.controlChannelOnline")
        : t("cp.software.agent.controlChannelOffline")}
    </Badge>
  );
}

export function PolicyDigest({ policy }: { policy: PolicyOverlayInput }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
      <DigestCell label={t("cp.software.col.installMode")}>
        {t(`cp.software.installMode.${policy.installMode}`)}
      </DigestCell>
      <DigestCell label={t("cp.software.col.locked")}>
        {policy.lockEnabled ? t("cp.common.yes") : t("cp.common.no")}
      </DigestCell>
      <DigestCell label={t("cp.software.col.whitelist")}>{policy.allowList.length}</DigestCell>
      <DigestCell label={t("cp.software.col.blacklist")}>{policy.denyList.length}</DigestCell>
      <DigestCell label={t("cp.software.policy.mirrors")}>{policy.mirrors.length}</DigestCell>
      <DigestCell label={t("cp.software.policy.preinstallList")}>
        {policy.preinstallList.length}
      </DigestCell>
      <DigestCell label={t("cp.software.policy.trustedAutoInstall")}>
        {policy.trustedPublicAutoInstall ? t("cp.common.yes") : t("cp.common.no")}
      </DigestCell>
      <DigestCell label={t("cp.software.usecase.strategy")}>
        {usecaseStrategyLabel(t, policy)}
      </DigestCell>
      <DigestCell label={t("cp.software.usecase.allowList")}>
        {policy.usecaseAllowList.length}
      </DigestCell>
      <DigestCell label={t("cp.software.usecase.denyList")}>
        {policy.usecaseDenyList.length}
      </DigestCell>
    </div>
  );
}

function DigestCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-2 border-border px-3 py-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="shrink-0 text-sm font-semibold tabular-nums">{children}</div>
    </div>
  );
}

export function usecaseStrategyLabel(
  t: (key: string) => string,
  policy: PolicyOverlayInput,
): string {
  if (policy.usecaseDenyList.length > 0 && policy.usecaseDefaultAllow) {
    return t("cp.software.usecase.strategyDefaultAllowWithBlacklist");
  }
  if (policy.usecaseDefaultAllow) {
    return t("cp.software.usecase.strategyDefaultAllow");
  }
  if (policy.usecaseAllowList.length > 0) {
    return t("cp.software.usecase.strategyWhitelist");
  }
  return t("cp.software.usecase.strategyAuthorization");
}

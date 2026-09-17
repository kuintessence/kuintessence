import type {
  FileTransferAuditConfigView,
  FileTransferDownloadEvidenceMode,
} from "@kuintessence/shared/browser";
import { AlertTriangle, Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

interface FormState {
  userPlatformRetentionDays: string;
  platformClusterRetentionDays: string;
  downloadEvidenceMode: FileTransferDownloadEvidenceMode;
  changeReason: string;
}

function toForm(config: FileTransferAuditConfigView): FormState {
  return {
    userPlatformRetentionDays: String(config.userPlatformRetentionDays),
    platformClusterRetentionDays: String(config.platformClusterRetentionDays),
    downloadEvidenceMode: config.downloadEvidenceMode,
    changeReason: "",
  };
}

function parseRetentionDays(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650 ? parsed : null;
}

export function FileTransferAuditConfigPanel({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<FileTransferAuditConfigView | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<FileTransferAuditConfigView>("/admin/file-transfer-audit/config")
      .then((loaded) => {
        if (cancelled) return;
        setConfig(loaded);
        setForm(toForm(loaded));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(
          toUserFacingError(error, t("settings.operations.fileTransferAudit.loadFailed")),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  if (loadError) {
    return (
      <Card data-testid="file-transfer-audit-config">
        <CardHeader>
          <CardTitle>{t("settings.operations.fileTransferAudit.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-status-failed" data-testid="file-transfer-audit-load-error">
            {loadError}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!config || !form) {
    return (
      <Card data-testid="file-transfer-audit-config">
        <CardHeader>
          <CardTitle>{t("settings.operations.fileTransferAudit.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("common.loading")}
        </CardContent>
      </Card>
    );
  }

  async function save() {
    if (!form) return;
    const userPlatformRetentionDays = parseRetentionDays(form.userPlatformRetentionDays);
    const platformClusterRetentionDays = parseRetentionDays(form.platformClusterRetentionDays);
    if (userPlatformRetentionDays === null || platformClusterRetentionDays === null) {
      toast.error(t("settings.operations.fileTransferAudit.invalidRetention"));
      return;
    }
    const changeReason = form.changeReason.trim();
    if (changeReason.length < 3) {
      toast.error(t("settings.operations.fileTransferAudit.invalidReason"));
      return;
    }

    setSaving(true);
    try {
      const updated = await api.put<FileTransferAuditConfigView>(
        "/admin/file-transfer-audit/config",
        {
          userPlatformRetentionDays,
          platformClusterRetentionDays,
          downloadEvidenceMode: form.downloadEvidenceMode,
          changeReason,
        },
      );
      setConfig(updated);
      setForm(toForm(updated));
      toast.success(t("settings.operations.fileTransferAudit.saved"));
    } catch (error) {
      toast.error(toUserFacingError(error, t("settings.operations.fileTransferAudit.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="file-transfer-audit-config">
      <CardHeader>
        <CardTitle>{t("settings.operations.fileTransferAudit.title")}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t("settings.operations.fileTransferAudit.description")}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <RetentionField
            id="user-platform-retention-days"
            label={t("settings.operations.fileTransferAudit.userRetention")}
            value={form.userPlatformRetentionDays}
            disabled={!canManage || saving}
            onChange={(value) =>
              setForm((current) =>
                current ? { ...current, userPlatformRetentionDays: value } : current,
              )
            }
          />
          <RetentionField
            id="platform-cluster-retention-days"
            label={t("settings.operations.fileTransferAudit.clusterRetention")}
            value={form.platformClusterRetentionDays}
            disabled={!canManage || saving}
            onChange={(value) =>
              setForm((current) =>
                current ? { ...current, platformClusterRetentionDays: value } : current,
              )
            }
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.operations.fileTransferAudit.retentionHelp")}
        </p>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="download-evidence-mode">
            {t("settings.operations.fileTransferAudit.mode")}
          </label>
          <select
            id="download-evidence-mode"
            data-testid="download-evidence-mode"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            value={form.downloadEvidenceMode}
            disabled={!canManage || saving}
            onChange={(event) =>
              setForm((current) =>
                current
                  ? {
                      ...current,
                      downloadEvidenceMode: event.target.value as FileTransferDownloadEvidenceMode,
                    }
                  : current,
              )
            }
          >
            <option value="controlled_gateway">
              {t("settings.operations.fileTransferAudit.controlledGateway")}
            </option>
            <option value="direct_authorization_only">
              {t("settings.operations.fileTransferAudit.directAuthorizationOnly")}
            </option>
          </select>
          <p className="text-xs text-muted-foreground">
            {t("settings.operations.fileTransferAudit.modeHelp")}
          </p>
        </div>

        {form.downloadEvidenceMode === "direct_authorization_only" ? (
          <div
            className="flex gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-sm"
            data-testid="direct-authorization-warning"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" />
            <span>{t("settings.operations.fileTransferAudit.directWarning")}</span>
          </div>
        ) : null}

        {canManage ? (
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="file-transfer-audit-change-reason">
              {t("settings.operations.fileTransferAudit.reason")}
            </label>
            <textarea
              id="file-transfer-audit-change-reason"
              data-testid="file-transfer-audit-change-reason"
              className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              maxLength={500}
              value={form.changeReason}
              disabled={saving}
              placeholder={t("settings.operations.fileTransferAudit.reasonPlaceholder")}
              onChange={(event) =>
                setForm((current) =>
                  current ? { ...current, changeReason: event.target.value } : current,
                )
              }
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("settings.operations.fileTransferAudit.readOnly")}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">
            {t("settings.operations.fileTransferAudit.policyVersion", {
              version: config.policyVersion,
            })}
          </span>
          {canManage ? (
            <Button
              type="button"
              onClick={save}
              disabled={saving}
              data-testid="file-transfer-audit-save"
            >
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              {t("settings.operations.fileTransferAudit.save")}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function RetentionField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        data-testid={id}
        type="number"
        min={1}
        max={3650}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

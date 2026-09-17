import { Copy, Loader2, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

type RuleScope = "global" | "provider" | "cluster";
type RuleAction = "passthrough" | "hash" | "alias" | "redact" | "hide";

interface DesensitizeRule {
  id: string;
  scope: RuleScope;
  scopeId: string | null;
  fieldPath: string;
  action: RuleAction;
}

interface DesensitizeConfigView {
  globalEnabled: boolean;
  rules: Array<DesensitizeRule & { updatedAt: string }>;
  exportEnabled: boolean;
}

const SCOPES: RuleScope[] = ["global", "provider", "cluster"];
const ACTIONS: RuleAction[] = ["passthrough", "hash", "alias", "redact", "hide"];
let draftSequence = 0;

export function DesensitizeAdminPanel() {
  const { t } = useTranslation();
  const [globalEnabled, setGlobalEnabled] = useState(false);
  const [rules, setRules] = useState<DesensitizeRule[]>([]);
  const [exportEnabled, setExportEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aliasIds, setAliasIds] = useState("");
  const [exporting, setExporting] = useState(false);
  const [envelope, setEnvelope] = useState<{
    token: string;
    expiresIn: number;
    expiresAt: number;
  } | null>(null);

  const applyConfig = useCallback((config: DesensitizeConfigView) => {
    setGlobalEnabled(config.globalEnabled);
    setRules(
      config.rules.map(({ updatedAt: _updatedAt, ...rule }) => ({
        ...rule,
        scopeId: rule.scopeId ?? null,
      })),
    );
    setExportEnabled(config.exportEnabled);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      applyConfig(await api.get<DesensitizeConfigView>("/admin/desensitize/config"));
      setLoadError(null);
    } catch (error) {
      setLoadError(toUserFacingError(error, t("settings.desensitize.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [applyConfig, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!envelope) return;
    const timeout = window.setTimeout(
      () => setEnvelope(null),
      Math.max(0, envelope.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [envelope]);

  const saveReady = rules.every(
    (rule) =>
      rule.fieldPath.trim() !== "" && (rule.scope === "global" || rule.scopeId?.trim() !== ""),
  );
  const exportIds = Array.from(
    new Set(
      aliasIds
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );

  function updateRule(id: string, update: Partial<DesensitizeRule>) {
    setRules((current) => current.map((rule) => (rule.id === id ? { ...rule, ...update } : rule)));
  }

  async function save() {
    setSaving(true);
    try {
      const config = await api.put<DesensitizeConfigView>("/admin/desensitize/config", {
        globalEnabled,
        rules: rules.map(({ id: _id, ...rule }) => ({
          ...rule,
          fieldPath: rule.fieldPath.trim(),
          scopeId: rule.scope === "global" ? null : rule.scopeId?.trim() || null,
        })),
      });
      applyConfig(config);
      toast.success(t("settings.desensitize.saved"));
    } catch (error) {
      toast.error(toUserFacingError(error, t("settings.desensitize.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function exportAliases() {
    setExporting(true);
    setEnvelope(null);
    try {
      const result = await api.post<{ token: string; expiresIn: number }>(
        "/admin/desensitize/export",
        { aliasIds: exportIds },
      );
      setEnvelope({ ...result, expiresAt: Date.now() + result.expiresIn * 1_000 });
      toast.success(t("settings.desensitize.exported"));
    } catch (error) {
      toast.error(toUserFacingError(error, t("settings.desensitize.exportFailed")));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card data-testid="desensitize-admin-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          {t("settings.desensitize.title")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("settings.desensitize.description")}</p>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common.loading")}
          </div>
        ) : loadError ? (
          <div className="space-y-3" data-testid="desensitize-load-error">
            <div className="text-sm text-status-failed">{loadError}</div>
            <Button type="button" variant="outline" onClick={() => void refresh()}>
              {t("common.refresh")}
            </Button>
          </div>
        ) : (
          <>
            <label className="flex items-center justify-between gap-4 rounded-md border p-3 text-sm">
              <span>{t("settings.desensitize.globalEnabled")}</span>
              <input
                type="checkbox"
                checked={globalEnabled}
                onChange={(event) => setGlobalEnabled(event.target.checked)}
                data-testid="desensitize-global-enabled"
              />
            </label>

            <div className="space-y-2" data-testid="desensitize-rules">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="grid gap-2 rounded-md border p-3 md:grid-cols-[130px_1fr_1fr_140px_36px]"
                  data-testid={`desensitize-rule-${rule.id}`}
                >
                  <select
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                    value={rule.scope}
                    aria-label={t("settings.desensitize.scope")}
                    onChange={(event) => {
                      const scope = event.target.value as RuleScope;
                      updateRule(rule.id, { scope, scopeId: scope === "global" ? null : "" });
                    }}
                  >
                    {SCOPES.map((scope) => (
                      <option key={scope} value={scope}>
                        {t(`settings.desensitize.scopes.${scope}`)}
                      </option>
                    ))}
                  </select>
                  <Input
                    value={rule.scopeId ?? ""}
                    disabled={rule.scope === "global"}
                    placeholder={t("settings.desensitize.scopeId")}
                    aria-label={t("settings.desensitize.scopeId")}
                    onChange={(event) => updateRule(rule.id, { scopeId: event.target.value })}
                  />
                  <Input
                    value={rule.fieldPath}
                    placeholder={t("settings.desensitize.fieldPath")}
                    aria-label={t("settings.desensitize.fieldPath")}
                    onChange={(event) => updateRule(rule.id, { fieldPath: event.target.value })}
                  />
                  <select
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                    value={rule.action}
                    aria-label={t("settings.desensitize.action")}
                    onChange={(event) =>
                      updateRule(rule.id, { action: event.target.value as RuleAction })
                    }
                  >
                    {ACTIONS.map((action) => (
                      <option key={action} value={action}>
                        {action}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                    onClick={() =>
                      setRules((current) => current.filter((row) => row.id !== rule.id))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {rules.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  {t("settings.desensitize.empty")}
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  draftSequence += 1;
                  setRules((current) => [
                    ...current,
                    {
                      id: `draft-${draftSequence}`,
                      scope: "global",
                      scopeId: null,
                      fieldPath: "",
                      action: "redact",
                    },
                  ]);
                }}
                data-testid="desensitize-add-rule"
              >
                <Plus className="h-4 w-4" />
                {t("settings.desensitize.addRule")}
              </Button>
              <Button
                type="button"
                disabled={!saveReady || saving}
                onClick={() => void save()}
                data-testid="desensitize-save"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {t("common.save")}
              </Button>
            </div>

            <div className="space-y-3 border-t pt-5">
              <div>
                <div className="text-sm font-medium">{t("settings.desensitize.exportTitle")}</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settings.desensitize.exportDescription")}
                </p>
              </div>
              <textarea
                className="min-h-20 w-full resize-y rounded-md border bg-background p-3 font-mono text-xs"
                value={aliasIds}
                onChange={(event) => {
                  setAliasIds(event.target.value);
                  setEnvelope(null);
                }}
                placeholder={t("settings.desensitize.aliasIds")}
                data-testid="desensitize-alias-ids"
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!exportEnabled || exportIds.length === 0 || exporting}
                  onClick={() => void exportAliases()}
                  data-testid="desensitize-export"
                >
                  {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t("settings.desensitize.export")}
                </Button>
              </div>
              {!exportEnabled ? (
                <p className="text-xs text-status-failed" data-testid="desensitize-export-disabled">
                  {t("settings.desensitize.exportDisabled")}
                </p>
              ) : null}
              {envelope ? (
                <div className="space-y-2" data-testid="desensitize-envelope">
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {t("settings.desensitize.expiresIn", { seconds: envelope.expiresIn })}
                    </span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      title={t("common.copy")}
                      aria-label={t("common.copy")}
                      onClick={async () => {
                        await navigator.clipboard.writeText(envelope.token);
                        toast.success(t("common.copied"));
                      }}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <textarea
                    readOnly
                    className="min-h-24 w-full resize-y rounded-md border bg-muted/35 p-3 font-mono text-xs"
                    value={envelope.token}
                  />
                </div>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

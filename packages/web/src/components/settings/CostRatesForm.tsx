import type { PreferenceSpec } from "@kuintessence/shared/browser";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

/**
 * Platform-wide per-cluster cost-rate editor (PreferenceSpec.costRates).
 *
 * Visible only to super_admin (PUT /api/preferences/global is super_admin-only;
 * the parent SettingsPage gates on the resolved role). Read-modify-write: the
 * full loaded spec is held in state so a save preserves hardLimits / sitePolicy
 * / softWeights and replaces only costRates.
 */

interface RateRow {
  cluster: string;
  rate: string;
}

function specToRows(spec: PreferenceSpec | null): RateRow[] {
  const rates = spec?.costRates;
  if (!rates) return [];
  return Object.entries(rates).map(([cluster, rate]) => ({
    cluster,
    rate: String(rate),
  }));
}

export function CostRatesForm() {
  const { t } = useTranslation();
  const [spec, setSpec] = useState<PreferenceSpec | null>(null);
  const [rows, setRows] = useState<RateRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ spec: PreferenceSpec | null }>("/preferences/global")
      .then((res) => {
        if (cancelled) return;
        setSpec(res.spec);
        setRows(specToRows(res.spec));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          toUserFacingError(
            err,
            t("settings.costRates.loadFailed", { defaultValue: "暂时无法加载费率，请稍后重试。" }),
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  if (loadError) {
    return (
      <Card data-testid="cost-rates-form">
        <CardHeader>
          <CardTitle>
            {t("settings.costRates.title", { defaultValue: "Cluster cost rates" })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-status-failed" data-testid="cost-rates-load-error">
            {loadError}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (rows === null) {
    return (
      <Card data-testid="cost-rates-form">
        <CardHeader>
          <CardTitle>
            {t("settings.costRates.title", { defaultValue: "Cluster cost rates" })}
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

  function updateRow(idx: number, patch: Partial<RateRow>) {
    setRows((prev) =>
      prev ? prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)) : prev,
    );
  }

  function addRow() {
    setRows((prev) => (prev ? [...prev, { cluster: "", rate: "" }] : prev));
  }

  function removeRow(idx: number) {
    setRows((prev) => (prev ? prev.filter((_, i) => i !== idx) : prev));
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!rows) return;

    const costRates: Record<string, number> = {};
    for (const row of rows) {
      const cluster = row.cluster.trim();
      if (cluster.length === 0) {
        toast.error(
          t("settings.costRates.errorEmptyCluster", {
            defaultValue: "Cluster name cannot be empty",
          }),
        );
        return;
      }
      if (cluster in costRates) {
        toast.error(
          t("settings.costRates.errorDuplicateCluster", {
            defaultValue: "Duplicate cluster name: {{cluster}}",
            cluster,
          }),
        );
        return;
      }
      const rate = Number(row.rate);
      if (Number.isNaN(rate) || rate < 0) {
        toast.error(
          t("settings.costRates.errorInvalidRate", {
            defaultValue: "Rate for {{cluster}} must be a non-negative number",
            cluster,
          }),
        );
        return;
      }
      costRates[cluster] = rate;
    }

    const merged: PreferenceSpec = { ...spec, costRates };
    setSaving(true);
    try {
      const res = await api.put<{ spec: PreferenceSpec | null }>("/preferences/global", merged);
      setSpec(res.spec);
      setRows(specToRows(res.spec));
      toast.success(t("settings.costRates.saved", { defaultValue: "Cost rates saved" }));
    } catch (err) {
      toast.error(
        toUserFacingError(
          err,
          t("settings.costRates.saveFailed", { defaultValue: "保存费率失败，请稍后重试。" }),
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="cost-rates-form">
      <CardHeader>
        <CardTitle>
          {t("settings.costRates.title", { defaultValue: "Cluster cost rates" })}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("settings.costRates.description", {
            defaultValue:
              "Per-cluster cost per CPU-hour. Feeds the scheduler's cost scorer. Applies platform-wide.",
          })}
        </p>
        <form className="space-y-3" onSubmit={onSave}>
          {rows.length === 0 ? (
            <p className="text-[11px] text-muted-foreground" data-testid="cost-rates-empty">
              {t("settings.costRates.empty", {
                defaultValue: "No cluster rates configured yet.",
              })}
            </p>
          ) : null}
          {rows.map((row, idx) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are list-like, no animation, no stable id available
              key={`row-${idx}`}
              data-testid={`cost-rates-row-${idx}`}
              className="flex items-center gap-2"
            >
              <Input
                data-testid={`cost-rates-cluster-${idx}`}
                value={row.cluster}
                onChange={(e) => updateRow(idx, { cluster: e.target.value })}
                placeholder={t("settings.costRates.clusterPlaceholder", {
                  defaultValue: "cluster-name",
                })}
                className="flex-1"
              />
              <Input
                data-testid={`cost-rates-rate-${idx}`}
                type="text"
                inputMode="decimal"
                value={row.rate}
                onChange={(e) => updateRow(idx, { rate: e.target.value })}
                placeholder={t("settings.costRates.ratePlaceholder", {
                  defaultValue: "0.00",
                })}
                className="w-32"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid={`cost-rates-remove-${idx}`}
                onClick={() => removeRow(idx)}
                aria-label={t("common.remove", { defaultValue: "Remove" })}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="cost-rates-add"
              onClick={addRow}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("settings.costRates.addRow", { defaultValue: "Add cluster" })}
            </Button>
            <Button type="submit" size="sm" data-testid="cost-rates-save" disabled={saving}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {t("settings.costRates.save", { defaultValue: "Save" })}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

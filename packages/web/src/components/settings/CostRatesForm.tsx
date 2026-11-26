import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { ResourceSelectField } from "../ui/resource-select-field";

interface CostRateDirectory {
  clusters: Array<{ id: string; organizationName: string; zoneName: string; clusterName: string }>;
  rates: Record<string, number>;
  legacyRates: Record<string, number>;
}

interface RateRow {
  id: string;
  cluster: string;
  rate: string;
}

function rateRows(rates: Record<string, number>): RateRow[] {
  return Object.entries(rates).map(([cluster, rate]) => ({
    id: cluster,
    cluster,
    rate: String(rate),
  }));
}

export function CostRatesForm({ organizationId }: { organizationId?: string } = {}) {
  const { t } = useTranslation();
  const path = organizationId
    ? `/preferences/org/${organizationId}/cost-rates`
    : "/preferences/global/cost-rates";
  const mobileReadOnly = useMobileMutationBlocked(path);
  const [directory, setDirectory] = useState<CostRateDirectory | null>(null);
  const [rows, setRows] = useState<RateRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadFailedLabel = t("settings.costRates.loadFailed", {
    defaultValue: "暂时无法加载费率，请稍后重试。",
  });
  useEffect(() => {
    if (loadError) return;
    let cancelled = false;
    setRows(null);
    api
      .get<CostRateDirectory>(path)
      .then((res) => {
        if (cancelled) return;
        setDirectory(res);
        setRows(rateRows(res.rates));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(toUserFacingError(err, loadFailedLabel));
      });
    return () => {
      cancelled = true;
    };
  }, [loadFailedLabel, loadError, path]);

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
          <Button className="mt-3" variant="outline" onClick={() => setLoadError(null)}>
            {t("common.retry")}
          </Button>
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

  const clusterLabel = (id: string) => {
    const cluster = directory?.clusters.find((item) => item.id === id);
    return cluster
      ? `${cluster.organizationName} – ${cluster.zoneName} – ${cluster.clusterName}`
      : id;
  };

  function updateRow(idx: number, patch: Partial<RateRow>) {
    setRows((prev) =>
      prev ? prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)) : prev,
    );
  }

  function addRow() {
    setRows((prev) =>
      prev ? [...prev, { id: crypto.randomUUID(), cluster: "", rate: "" }] : prev,
    );
  }

  function removeRow(idx: number) {
    setRows((prev) => (prev ? prev.filter((_, i) => i !== idx) : prev));
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!rows || !directory || saving || mobileReadOnly) return;

    const costRates: Record<string, number> = {};
    for (const row of rows) {
      const cluster = row.cluster.trim();
      if (!directory.clusters.some((item) => item.id === cluster)) {
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
            cluster: clusterLabel(cluster),
          }),
        );
        return;
      }
      const rate = Number(row.rate);
      if (!row.rate.trim() || !Number.isFinite(rate) || rate < 0) {
        toast.error(
          t("settings.costRates.errorInvalidRate", {
            defaultValue: "Rate for {{cluster}} must be a non-negative number",
            cluster: clusterLabel(cluster),
          }),
        );
        return;
      }
      costRates[cluster] = rate;
    }

    setSaving(true);
    try {
      const res = await api.put<CostRateDirectory>(
        path,
        costRates,
        organizationId ? { organizationId, authRevision: getAuthState().revision } : undefined,
      );
      setDirectory(res);
      setRows(rateRows(res.rates));
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
          {t(
            organizationId
              ? "settings.costRates.providerDescription"
              : "settings.costRates.description",
          )}
        </p>
        {directory && Object.keys(directory.legacyRates).length > 0 && (
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">{t("settings.costRates.legacyRates")}</summary>
            <dl className="divide-y divide-border">
              {Object.entries(directory.legacyRates).map(([label, rate]) => (
                <div className="flex justify-between gap-2 py-1" key={label}>
                  <dt>{label}</dt>
                  <dd>{rate}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
        <form className="space-y-3" onSubmit={onSave}>
          {mobileReadOnly && (
            <p className="text-sm text-muted-foreground">{t("settings.desktopManage")}</p>
          )}
          <fieldset disabled={saving || mobileReadOnly} className="space-y-3">
            {rows.length === 0 ? (
              <p className="text-[11px] text-muted-foreground" data-testid="cost-rates-empty">
                {t("settings.costRates.empty", {
                  defaultValue: "No cluster rates configured yet.",
                })}
              </p>
            ) : null}
            {rows.map((row, idx) => (
              <div
                key={row.id}
                data-testid={`cost-rates-row-${idx}`}
                className="flex items-center gap-2"
              >
                <ResourceSelectField
                  resourceType="clusters"
                  data-testid={`cost-rates-cluster-${idx}`}
                  aria-label={t("settings.costRates.clusterPlaceholder")}
                  value={row.cluster}
                  onChange={(event) => updateRow(idx, { cluster: event.target.value })}
                  className="min-w-0 flex-1"
                  disabled={saving || mobileReadOnly}
                >
                  <option value="">{t("settings.costRates.clusterPlaceholder")}</option>
                  {row.cluster && !directory?.clusters.some((item) => item.id === row.cluster) && (
                    <option value={row.cluster}>
                      {t("settings.costRates.unavailableCluster", { id: row.cluster })}
                    </option>
                  )}
                  {directory?.clusters.map(({ id }) => (
                    <option
                      key={id}
                      value={id}
                      disabled={row.cluster !== id && rows.some((entry) => entry.cluster === id)}
                    >
                      {clusterLabel(id)}
                    </option>
                  ))}
                </ResourceSelectField>
                <Input
                  data-testid={`cost-rates-rate-${idx}`}
                  aria-label={t("settings.costRates.rateLabel")}
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
          </fieldset>
        </form>
      </CardContent>
    </Card>
  );
}

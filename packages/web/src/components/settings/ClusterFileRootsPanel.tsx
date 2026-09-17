import type {
  ClusterFileRootCheckResponse,
  ClusterFileRootView,
} from "@kuintessence/shared/browser";
import { Activity, FolderTree, HardDrive, Loader2, Plus, RefreshCw, Save } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { ClusterStoragePolicyEditor } from "./ClusterStoragePolicyEditor";

interface ClusterFileRootsResponse {
  roots: ClusterFileRootView[];
}

interface RootDraft {
  id: string;
  label: string;
  providerOrgId: string;
  agentId: string;
  path: string;
  capacityGb: string;
  visibleOrgIdsText: string;
  enabled: boolean;
}

interface NewRootDraft {
  label: string;
  providerOrgId: string;
  agentId: string;
  path: string;
  capacityGb: string;
  visibleOrgIdsText: string;
  enabled: boolean;
}

function rootToDraft(root: ClusterFileRootView): RootDraft {
  return {
    id: root.id,
    label: root.label,
    providerOrgId: root.providerOrgId,
    agentId: root.agentId ?? "",
    path: root.path,
    capacityGb: root.capacityBytes == null ? "" : `${root.capacityBytes / 1024 ** 3}`,
    visibleOrgIdsText: root.visibleOrgIds.join(", "),
    enabled: root.enabled,
  };
}

function parseVisibleOrgIds(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function formatError(err: unknown, fallback: string): string {
  return toUserFacingError(err, fallback);
}

const EMPTY_NEW_ROOT: NewRootDraft = {
  label: "",
  providerOrgId: "",
  agentId: "",
  path: "",
  capacityGb: "",
  visibleOrgIdsText: "",
  enabled: true,
};

export function ClusterFileRootsPanel() {
  const { t } = useTranslation();
  const [roots, setRoots] = useState<ClusterFileRootView[]>([]);
  const [drafts, setDrafts] = useState<Record<string, RootDraft>>({});
  const [newRoot, setNewRoot] = useState<NewRootDraft>(EMPTY_NEW_ROOT);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, ClusterFileRootCheckResponse>>({});
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [expandedPolicyRootIds, setExpandedPolicyRootIds] = useState<Set<string>>(new Set());
  const loadFailedLabel = t("settings.clusterFileRoots.loadFailed");

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<ClusterFileRootsResponse>("/admin/cluster-file-roots");
      setRoots(res.roots);
      setDrafts(Object.fromEntries(res.roots.map((root) => [root.id, rootToDraft(root)])));
    } catch (err) {
      setRoots([]);
      setDrafts({});
      setChecks({});
      setLoadError(formatError(err, loadFailedLabel));
    } finally {
      setLoading(false);
    }
  }, [loadFailedLabel]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enabledCount = useMemo(() => roots.filter((root) => root.enabled).length, [roots]);

  const updateDraft = <K extends keyof RootDraft>(id: string, key: K, value: RootDraft[K]) => {
    setDrafts((prev) => {
      const current = prev[id];
      if (!current) return prev;
      return { ...prev, [id]: { ...current, [key]: value } };
    });
  };

  const togglePolicy = (rootId: string) => {
    setExpandedPolicyRootIds((current) => {
      const next = new Set(current);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  };

  const saveRoot = async (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    if (!draft.path.trim().startsWith("/")) {
      toast.error(t("settings.clusterFileRoots.pathMustBeAbsolute"));
      return;
    }
    setSavingId(id);
    try {
      const updated = await api.patch<ClusterFileRootView>(`/admin/cluster-file-roots/${id}`, {
        label: draft.label.trim(),
        agentId: draft.agentId.trim() || null,
        path: draft.path.trim(),
        capacityBytes: parseCapacityBytes(draft.capacityGb),
        visibleOrgIds: parseVisibleOrgIds(draft.visibleOrgIdsText),
        enabled: draft.enabled,
      });
      setRoots((prev) => prev.map((root) => (root.id === id ? updated : root)));
      setDrafts((prev) => ({ ...prev, [id]: rootToDraft(updated) }));
      toast.success(t("settings.clusterFileRoots.saved"));
    } catch (err) {
      toast.error(`${t("settings.clusterFileRoots.saveFailed")}: ${formatError(err, "")}`);
    } finally {
      setSavingId(null);
    }
  };

  const checkRoot = async (id: string) => {
    setCheckingId(id);
    try {
      const result = await api.post<ClusterFileRootCheckResponse>(
        `/admin/cluster-file-roots/${id}/check`,
        {},
      );
      setChecks((prev) => ({ ...prev, [id]: result }));
      toast.success(t("settings.clusterFileRoots.checkComplete"));
    } catch (err) {
      toast.error(`${t("settings.clusterFileRoots.checkFailed")}: ${formatError(err, "")}`);
    } finally {
      setCheckingId(null);
    }
  };

  const createRoot = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newRoot.path.trim().startsWith("/")) {
      toast.error(t("settings.clusterFileRoots.pathMustBeAbsolute"));
      return;
    }
    setCreating(true);
    try {
      const created = await api.post<ClusterFileRootView>("/admin/cluster-file-roots", {
        label: newRoot.label.trim(),
        ...(newRoot.providerOrgId.trim() ? { providerOrgId: newRoot.providerOrgId.trim() } : {}),
        agentId: newRoot.agentId.trim() || null,
        path: newRoot.path.trim(),
        ...(newRoot.capacityGb ? { capacityBytes: parseCapacityBytes(newRoot.capacityGb) } : {}),
        visibleOrgIds: parseVisibleOrgIds(newRoot.visibleOrgIdsText),
        enabled: newRoot.enabled,
      });
      setRoots((prev) => [...prev, created]);
      setDrafts((prev) => ({ ...prev, [created.id]: rootToDraft(created) }));
      setNewRoot(EMPTY_NEW_ROOT);
      toast.success(t("settings.clusterFileRoots.created"));
    } catch (err) {
      toast.error(`${t("settings.clusterFileRoots.createFailed")}: ${formatError(err, "")}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Card data-testid="cluster-file-roots-panel">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FolderTree className="h-4 w-4" />
            {t("settings.clusterFileRoots.title")}
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("settings.clusterFileRoots.description")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw />}
          {t("common.refresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <div
            className="rounded-md border border-status-failed/40 p-3 text-sm text-status-failed"
            data-testid="cluster-file-roots-error"
          >
            {loadError}
          </div>
        ) : null}
        {!loadError ? (
          <>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">
                {t("settings.clusterFileRoots.total", { count: roots.length })}
              </Badge>
              <Badge variant="brand">
                {t("settings.clusterFileRoots.enabled", { count: enabledCount })}
              </Badge>
            </div>

            <form
              className="grid gap-2 rounded-md border border-border p-3 md:grid-cols-2 xl:grid-cols-[1fr_160px_160px_1fr_140px_1fr_auto]"
              onSubmit={createRoot}
              data-testid="cluster-file-root-create-form"
            >
              <Input
                value={newRoot.label}
                placeholder={t("settings.clusterFileRoots.label")}
                onChange={(event) => setNewRoot((prev) => ({ ...prev, label: event.target.value }))}
                data-testid="cluster-file-root-new-label"
                required
              />
              <Input
                value={newRoot.providerOrgId}
                placeholder={t("settings.clusterFileRoots.providerOrgId")}
                onChange={(event) =>
                  setNewRoot((prev) => ({ ...prev, providerOrgId: event.target.value }))
                }
                data-testid="cluster-file-root-new-provider"
              />
              <Input
                value={newRoot.agentId}
                placeholder={t("settings.clusterFileRoots.agentId")}
                onChange={(event) =>
                  setNewRoot((prev) => ({ ...prev, agentId: event.target.value }))
                }
                data-testid="cluster-file-root-new-agent"
              />
              <Input
                value={newRoot.path}
                placeholder="/scratch/project"
                onChange={(event) => setNewRoot((prev) => ({ ...prev, path: event.target.value }))}
                data-testid="cluster-file-root-new-path"
                required
              />
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={newRoot.capacityGb}
                placeholder={t("settings.clusterFileRoots.capacityGb")}
                onChange={(event) =>
                  setNewRoot((prev) => ({ ...prev, capacityGb: event.target.value }))
                }
                data-testid="cluster-file-root-new-capacity"
              />
              <Input
                value={newRoot.visibleOrgIdsText}
                placeholder={t("settings.clusterFileRoots.visibleOrgIds")}
                onChange={(event) =>
                  setNewRoot((prev) => ({ ...prev, visibleOrgIdsText: event.target.value }))
                }
                data-testid="cluster-file-root-new-visible-orgs"
              />
              <Button type="submit" disabled={creating}>
                {creating ? <Loader2 className="animate-spin" /> : <Plus />}
                {t("settings.clusterFileRoots.create")}
              </Button>
            </form>

            {roots.length === 0 && !loading ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                {t("settings.clusterFileRoots.empty")}
              </div>
            ) : null}
            <div className="space-y-2">
              {roots.map((root) => {
                const draft = drafts[root.id] ?? rootToDraft(root);
                return (
                  <div key={root.id} className="space-y-2">
                    <div
                      className="grid gap-2 rounded-md border border-border p-3 md:grid-cols-2 xl:grid-cols-[1fr_150px_150px_1fr_130px_1fr_150px_auto]"
                      data-testid={`cluster-file-root-row-${root.id}`}
                    >
                      <Input
                        value={draft.label}
                        onChange={(event) => updateDraft(root.id, "label", event.target.value)}
                        data-testid={`cluster-file-root-label-${root.id}`}
                      />
                      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs">
                        {root.providerOrgId}
                      </div>
                      <Input
                        value={draft.agentId}
                        onChange={(event) => updateDraft(root.id, "agentId", event.target.value)}
                        placeholder={t("settings.clusterFileRoots.allAgents")}
                        data-testid={`cluster-file-root-agent-${root.id}`}
                      />
                      <Input
                        value={draft.path}
                        onChange={(event) => updateDraft(root.id, "path", event.target.value)}
                        className="font-mono text-xs"
                        data-testid={`cluster-file-root-path-${root.id}`}
                      />
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={draft.capacityGb}
                        onChange={(event) => updateDraft(root.id, "capacityGb", event.target.value)}
                        placeholder={t("settings.clusterFileRoots.capacityGb")}
                        data-testid={`cluster-file-root-capacity-${root.id}`}
                      />
                      <Input
                        value={draft.visibleOrgIdsText}
                        onChange={(event) =>
                          updateDraft(root.id, "visibleOrgIdsText", event.target.value)
                        }
                        placeholder={t("settings.clusterFileRoots.visibleOrgIds")}
                        data-testid={`cluster-file-root-visible-orgs-${root.id}`}
                      />
                      <RootCheckBadge check={checks[root.id]} />
                      <div className="flex items-center justify-end gap-2">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={draft.enabled}
                            onChange={(event) =>
                              updateDraft(root.id, "enabled", event.target.checked)
                            }
                            data-testid={`cluster-file-root-enabled-${root.id}`}
                          />
                          {t("settings.clusterFileRoots.enabledToggle")}
                        </label>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => togglePolicy(root.id)}
                          aria-expanded={expandedPolicyRootIds.has(root.id)}
                        >
                          <HardDrive />
                          配额策略
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => checkRoot(root.id)}
                          disabled={checkingId === root.id}
                          data-testid={`cluster-file-root-check-${root.id}`}
                        >
                          {checkingId === root.id ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Activity />
                          )}
                          {t("settings.clusterFileRoots.check")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => saveRoot(root.id)}
                          disabled={savingId === root.id}
                          data-testid={`cluster-file-root-save-${root.id}`}
                        >
                          {savingId === root.id ? <Loader2 className="animate-spin" /> : <Save />}
                          {t("settings.clusterFileRoots.save")}
                        </Button>
                      </div>
                    </div>
                    {expandedPolicyRootIds.has(root.id) ? (
                      <ClusterStoragePolicyEditor rootId={root.id} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function parseCapacityBytes(value: string): number | null {
  if (!value.trim()) return null;
  const capacityGb = Number(value);
  if (!Number.isFinite(capacityGb) || capacityGb <= 0) return null;
  return Math.round(capacityGb * 1024 ** 3);
}

function RootCheckBadge({ check }: { check?: ClusterFileRootCheckResponse }) {
  const { t } = useTranslation();
  if (!check) {
    return (
      <Badge variant="outline" data-testid="cluster-file-root-check-idle">
        {t("settings.clusterFileRoots.checkIdle")}
      </Badge>
    );
  }
  const failed = check.status !== "ok";
  return (
    <Badge
      variant={failed ? "failed" : "succeeded"}
      title={`${check.path} ${check.checkedAt}`}
      data-testid={`cluster-file-root-check-status-${check.rootId}`}
    >
      {t(`settings.clusterFileRoots.checkStatus.${check.status}`)}
    </Badge>
  );
}

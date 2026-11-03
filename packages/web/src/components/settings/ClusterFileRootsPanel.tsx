import type {
  ClusterFileRootCheckResponse,
  ClusterFileRootView,
} from "@kuintessence/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { Activity, FolderTree, HardDrive, Loader2, Plus, RefreshCw, Save } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  type ActiveOrganizationContext,
  getActiveOrganizationContext,
} from "../../lib/active-organization";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import {
  listSandboxAgentSecurityViews,
  type SandboxAgentSecurityView,
} from "../../lib/sandbox-client";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
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
  const directory = useQuery({
    queryKey: ["cluster-root-directory", getAuthState().revision],
    queryFn: async () => {
      const [context, agents] = await Promise.all([
        getActiveOrganizationContext(),
        listSandboxAgentSecurityViews(),
      ]);
      return { organizations: context.organizations, agents };
    },
    retry: false,
  });
  const organizations = directory.data?.organizations ?? [];
  const agents = directory.data?.agents ?? [];
  const directoryUnavailable = directory.isPending || !!directory.error;
  const organizationName = (id: string) =>
    organizations.find((org) => org.orgId === id)?.name ?? id;
  const { t } = useTranslation();
  const mobileReadOnly = useMobileMutationBlocked("/admin/cluster-file-roots");
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
    if (!draft || mobileReadOnly) return;
    if (draft.capacityGb.trim() && parseCapacityBytes(draft.capacityGb) === null) {
      toast.error(t("settings.clusterFileRoots.invalidCapacity"));
      return;
    }
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
    if (
      mobileReadOnly ||
      directoryUnavailable ||
      !organizations.some((org) => org.orgId === newRoot.providerOrgId)
    )
      return;
    if (newRoot.capacityGb.trim() && parseCapacityBytes(newRoot.capacityGb) === null) {
      toast.error(t("settings.clusterFileRoots.invalidCapacity"));
      return;
    }
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
        {mobileReadOnly && (
          <p className="text-sm text-muted-foreground">{t("settings.desktopManage")}</p>
        )}
        {directory.error ? (
          <div role="alert" className="space-y-2 text-sm">
            <p>{t("settings.clusterFileRoots.directoryFailed")}</p>
            <Button variant="outline" onClick={() => void directory.refetch()}>
              {t("common.retry")}
            </Button>
          </div>
        ) : directory.isPending ? (
          <p role="status">{t("common.loading")}</p>
        ) : null}
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

            {!mobileReadOnly && (
              <form
                className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] gap-2 rounded-md border border-border p-3"
                onSubmit={createRoot}
                data-testid="cluster-file-root-create-form"
              >
                <RootField
                  id="cluster-file-root-new-label"
                  label={t("settings.clusterFileRoots.label")}
                >
                  <Input
                    value={newRoot.label}
                    placeholder={t("settings.clusterFileRoots.label")}
                    onChange={(event) =>
                      setNewRoot((prev) => ({ ...prev, label: event.target.value }))
                    }
                    id="cluster-file-root-new-label"
                    data-testid="cluster-file-root-new-label"
                    required
                  />
                </RootField>
                <RootField
                  id="cluster-file-root-new-provider"
                  label={t("settings.clusterFileRoots.providerOrgId")}
                >
                  <select
                    aria-label={t("settings.clusterFileRoots.providerOrgId")}
                    className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm"
                    value={newRoot.providerOrgId}
                    required
                    disabled={directoryUnavailable || creating}
                    onChange={(event) =>
                      setNewRoot((prev) => ({
                        ...prev,
                        providerOrgId: event.target.value,
                        agentId: "",
                      }))
                    }
                    id="cluster-file-root-new-provider"
                    data-testid="cluster-file-root-new-provider"
                  >
                    <option value="">{t("settings.clusterFileRoots.selectProvider")}</option>
                    {organizations.map((org) => (
                      <option key={org.orgId} value={org.orgId}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </RootField>
                <RootAgentSelect
                  agents={agents}
                  providerOrgId={newRoot.providerOrgId}
                  value={newRoot.agentId}
                  disabled={directoryUnavailable || creating || !newRoot.providerOrgId}
                  onChange={(agentId) => setNewRoot((prev) => ({ ...prev, agentId }))}
                  testId="cluster-file-root-new-agent"
                />
                <RootField
                  id="cluster-file-root-new-path"
                  label={t("settings.clusterFileRoots.path")}
                >
                  <Input
                    value={newRoot.path}
                    placeholder="/scratch/project"
                    onChange={(event) =>
                      setNewRoot((prev) => ({ ...prev, path: event.target.value }))
                    }
                    id="cluster-file-root-new-path"
                    data-testid="cluster-file-root-new-path"
                    required
                  />
                </RootField>
                <RootField
                  id="cluster-file-root-new-capacity"
                  label={t("settings.clusterFileRoots.capacityGb")}
                >
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={newRoot.capacityGb}
                    placeholder={t("settings.clusterFileRoots.capacityGb")}
                    onChange={(event) =>
                      setNewRoot((prev) => ({ ...prev, capacityGb: event.target.value }))
                    }
                    id="cluster-file-root-new-capacity"
                    data-testid="cluster-file-root-new-capacity"
                  />
                </RootField>
                <RootOrganizationSelection
                  organizations={organizations}
                  value={newRoot.visibleOrgIdsText}
                  disabled={directoryUnavailable || creating}
                  onChange={(visibleOrgIdsText) =>
                    setNewRoot((prev) => ({ ...prev, visibleOrgIdsText }))
                  }
                  testId="cluster-file-root-new-visible-orgs"
                />
                <Button
                  type="submit"
                  disabled={creating || directoryUnavailable || !newRoot.providerOrgId}
                >
                  {creating ? <Loader2 className="animate-spin" /> : <Plus />}
                  {t("settings.clusterFileRoots.create")}
                </Button>
              </form>
            )}

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
                      className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] gap-2 rounded-md border border-border p-3"
                      data-testid={`cluster-file-root-row-${root.id}`}
                    >
                      <RootField
                        id={`cluster-file-root-label-${root.id}`}
                        label={t("settings.clusterFileRoots.label")}
                      >
                        <Input
                          disabled={mobileReadOnly}
                          value={draft.label}
                          onChange={(event) => updateDraft(root.id, "label", event.target.value)}
                          id={`cluster-file-root-label-${root.id}`}
                          data-testid={`cluster-file-root-label-${root.id}`}
                        />
                      </RootField>
                      <div
                        className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
                        title={root.providerOrgId}
                      >
                        {organizationName(root.providerOrgId)}
                      </div>
                      <RootAgentSelect
                        agents={agents}
                        providerOrgId={root.providerOrgId}
                        value={draft.agentId}
                        disabled={directoryUnavailable || mobileReadOnly}
                        onChange={(agentId) => updateDraft(root.id, "agentId", agentId)}
                        testId={`cluster-file-root-agent-${root.id}`}
                      />
                      <RootField
                        id={`cluster-file-root-path-${root.id}`}
                        label={t("settings.clusterFileRoots.path")}
                      >
                        <Input
                          disabled={mobileReadOnly}
                          value={draft.path}
                          onChange={(event) => updateDraft(root.id, "path", event.target.value)}
                          className="font-mono text-xs"
                          id={`cluster-file-root-path-${root.id}`}
                          data-testid={`cluster-file-root-path-${root.id}`}
                        />
                      </RootField>
                      <RootField
                        id={`cluster-file-root-capacity-${root.id}`}
                        label={t("settings.clusterFileRoots.capacityGb")}
                      >
                        <Input
                          disabled={mobileReadOnly}
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={draft.capacityGb}
                          onChange={(event) =>
                            updateDraft(root.id, "capacityGb", event.target.value)
                          }
                          placeholder={t("settings.clusterFileRoots.capacityGb")}
                          id={`cluster-file-root-capacity-${root.id}`}
                          data-testid={`cluster-file-root-capacity-${root.id}`}
                        />
                      </RootField>
                      <RootOrganizationSelection
                        organizations={organizations}
                        value={draft.visibleOrgIdsText}
                        disabled={directoryUnavailable || mobileReadOnly}
                        onChange={(value) => updateDraft(root.id, "visibleOrgIdsText", value)}
                        testId={`cluster-file-root-visible-orgs-${root.id}`}
                      />
                      <RootCheckBadge check={checks[root.id]} />
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            disabled={mobileReadOnly}
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
                          disabled={mobileReadOnly || checkingId === root.id}
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
                          disabled={mobileReadOnly || savingId === root.id}
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

function RootAgentSelect({
  agents,
  providerOrgId,
  value,
  disabled,
  onChange,
  testId,
}: {
  agents: SandboxAgentSecurityView[];
  providerOrgId: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const choices = agents.filter((agent) => agent.providerOrgId === providerOrgId);
  return (
    <RootField id={testId} label={t("settings.clusterFileRoots.agentId")}>
      <select
        aria-label={t("settings.clusterFileRoots.agentId")}
        id={testId}
        data-testid={testId}
        className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("settings.clusterFileRoots.allAgents")}</option>
        {value && !choices.some((agent) => agent.agentId === value) && (
          <option value={value}>{value}</option>
        )}
        {choices.map((agent) => (
          <option key={agent.agentId} value={agent.agentId}>
            {agent.siteName} · {agent.agentId}
          </option>
        ))}
      </select>
    </RootField>
  );
}

function RootOrganizationSelection({
  organizations,
  value,
  disabled,
  onChange,
  testId,
}: {
  organizations: ActiveOrganizationContext["organizations"];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const selected = parseVisibleOrgIds(value);
  const choices = [
    ...organizations,
    ...selected
      .filter((id) => !organizations.some((org) => org.orgId === id))
      .map((orgId) => ({ orgId, name: orgId, role: "unknown" })),
  ];
  return (
    <details
      className="min-w-0 rounded-md border border-input bg-background p-2 text-sm"
      data-testid={testId}
    >
      <summary className="cursor-pointer break-words">
        {t("settings.clusterFileRoots.sharedWith")}:{" "}
        {selected.length
          ? selected.map((id) => choices.find((org) => org.orgId === id)?.name ?? id).join(", ")
          : t("settings.clusterFileRoots.noSharing")}
      </summary>
      <Input
        className="mt-2"
        aria-label={t("settings.clusterFileRoots.searchOrganizations")}
        value={search}
        placeholder={t("settings.clusterFileRoots.organizationSearchPlaceholder")}
        onChange={(event) => setSearch(event.target.value)}
      />
      <fieldset disabled={disabled} className="mt-2 max-h-40 space-y-2 overflow-y-auto">
        {/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search.trim()) &&
          !choices.some((org) => org.orgId.toLowerCase() === search.trim().toLowerCase()) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onChange([...selected, search.trim().toLowerCase()].join(", "));
                setSearch("");
              }}
            >
              {t("settings.clusterFileRoots.addOrganizationId")}
            </Button>
          )}
        {choices
          .filter((org) => org.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
          .map((org) => (
            <label key={org.orgId} className="flex items-start gap-2 break-words">
              <input
                type="checkbox"
                checked={selected.includes(org.orgId)}
                onChange={(event) =>
                  onChange(
                    (event.target.checked
                      ? [...selected, org.orgId]
                      : selected.filter((id) => id !== org.orgId)
                    ).join(", "),
                  )
                }
              />
              {org.name}
            </label>
          ))}
      </fieldset>
    </details>
  );
}

function RootField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1 text-xs">
      <label htmlFor={id} className="text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

import type { ClusterFileRootCheckResponse } from "@kuintessence/shared/browser";
import { Activity, ExternalLink, FileKey2, FolderTree, Loader2, ShieldX } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import type { CpAgentCert } from "../../lib/cp-client";
import {
  useCpAgentCerts,
  useCpAgentClusterFileRoots,
  useCpAgents,
  useRevokeCpAgentCert,
} from "../../lib/use-cp-agents";
import { toUserFacingError } from "../../lib/user-facing-error";
import { AgentCertRevokeDialog } from "../agent/AgentCertRevokeDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

function statusVariant(status: string): "running" | "cancelled" | "failed" | "default" {
  const s = status.toLowerCase();
  if (s === "online" || s === "healthy") return "running";
  if (s === "offline" || s === "draining") return "cancelled";
  if (s === "sick" || s === "unhealthy") return "failed";
  return "default";
}

export function CpAgentsTable() {
  const { t } = useTranslation();
  const q = useCpAgents();
  const items = q.data ?? [];
  const [certAgentId, setCertAgentId] = useState<string | null>(null);
  const [rootsAgentId, setRootsAgentId] = useState<string | null>(null);

  useEffect(() => {
    if (!q.error) return;
    setCertAgentId(null);
    setRootsAgentId(null);
  }, [q.error]);

  return (
    <div className="space-y-4" data-testid="cp-agents-table">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{t("cp.agents.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("cp.agents.subtitle")}</p>
        </div>
      </div>

      {q.error ? (
        <div
          className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
          data-testid="cp-agents-error"
        >
          {toUserFacingError(q.error, t("cp.dashboard.loadFailed"))}
        </div>
      ) : null}

      {q.error ? null : q.isLoading ? (
        <div className="text-sm text-muted-foreground">{t("cp.common.loading")}</div>
      ) : items.length === 0 ? (
        <div
          className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground"
          data-testid="cp-agents-empty"
        >
          {t("cp.agents.empty")}
        </div>
      ) : (
        <div
          className="rounded-md border border-border sm:overflow-x-auto sm:overscroll-x-contain"
          data-testid="cp-agents-table-scroll"
        >
          <table className="w-full text-sm sm:min-w-[48rem]">
            <thead className="sr-only bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground sm:not-sr-only sm:table-header-group">
              <tr>
                <th className="px-3 py-2 font-medium">{t("cp.agents.col.id")}</th>
                <th className="px-3 py-2 font-medium">{t("cp.agents.col.hostname")}</th>
                <th className="px-3 py-2 font-medium">{t("cp.agents.col.site")}</th>
                <th className="px-3 py-2 font-medium">{t("cp.agents.col.status")}</th>
                <th className="px-3 py-2 font-medium">{t("cp.agents.col.actions")}</th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-border sm:table-row-group sm:divide-y-0">
              {items.map((a) => (
                <Fragment key={a.id}>
                  <tr
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 p-4 sm:table-row sm:border-t sm:border-border sm:p-0"
                    data-testid={`cp-agents-row-${a.id}`}
                  >
                    <td className="order-3 col-span-2 min-w-0 font-mono text-xs text-muted-foreground sm:table-cell sm:px-3 sm:py-2 sm:text-foreground">
                      <span className="mr-2 font-sans text-muted-foreground sm:hidden">
                        {t("cp.agents.col.id")}
                      </span>
                      <span className="break-all sm:break-normal">{a.id}</span>
                    </td>
                    <td className="order-1 min-w-0 font-mono text-sm font-medium sm:table-cell sm:px-3 sm:py-2 sm:text-xs sm:font-normal">
                      <span className="break-all sm:break-normal">{a.hostname}</span>
                    </td>
                    <td className="order-2 col-span-2 min-w-0 font-mono text-xs text-muted-foreground sm:table-cell sm:px-3 sm:py-2 sm:text-foreground">
                      <span className="mr-2 font-sans text-muted-foreground sm:hidden">
                        {t("cp.agents.col.site")}
                      </span>
                      <span className="break-all sm:break-normal">{a.siteId}</span>
                    </td>
                    <td className="order-1 sm:table-cell sm:px-3 sm:py-2">
                      <Badge variant={statusVariant(a.status)}>
                        <span>
                          {t(`cp.common.agentStatus.${a.status.toLowerCase()}`, {
                            defaultValue: a.status,
                          })}
                        </span>
                        <code className="ml-1 text-[10px] opacity-75">{a.status}</code>
                      </Badge>
                    </td>
                    <td className="order-4 col-span-2 sm:table-cell sm:px-3 sm:py-2">
                      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11 sm:min-h-8"
                          aria-expanded={rootsAgentId === a.id}
                          aria-controls={
                            rootsAgentId === a.id ? `cp-agent-roots-detail-${a.id}` : undefined
                          }
                          onClick={() => {
                            setRootsAgentId((current) => (current === a.id ? null : a.id));
                            setCertAgentId(null);
                          }}
                          data-testid={`cp-agent-roots-toggle-${a.id}`}
                        >
                          <FolderTree className="h-3.5 w-3.5" />
                          {t("cp.agents.roots.button")}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11 sm:min-h-8"
                          aria-expanded={certAgentId === a.id}
                          aria-controls={
                            certAgentId === a.id ? `cp-agent-certs-detail-${a.id}` : undefined
                          }
                          onClick={() => {
                            setCertAgentId((current) => (current === a.id ? null : a.id));
                            setRootsAgentId(null);
                          }}
                          data-testid={`cp-agent-certs-toggle-${a.id}`}
                        >
                          <FileKey2 className="h-3.5 w-3.5" />
                          {t("cp.agents.certs.button")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {rootsAgentId === a.id ? (
                    <tr
                      id={`cp-agent-roots-detail-${a.id}`}
                      className="block bg-muted/20 sm:table-row sm:border-t sm:border-border"
                    >
                      <td colSpan={5} className="block px-4 py-3 sm:table-cell sm:px-3">
                        <CpAgentClusterFileRoots agentId={a.id} />
                      </td>
                    </tr>
                  ) : null}
                  {certAgentId === a.id ? (
                    <tr
                      id={`cp-agent-certs-detail-${a.id}`}
                      className="block bg-muted/20 sm:table-row sm:border-t sm:border-border"
                    >
                      <td colSpan={5} className="block px-4 py-3 sm:table-cell sm:px-3">
                        <CpAgentCerts agentId={a.id} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CpAgentClusterFileRoots({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const role = getAuthState().role;
  const canManagePlatform = role === "platform_admin" || role === "super_admin";
  const roots = useCpAgentClusterFileRoots(agentId);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, ClusterFileRootCheckResponse>>({});

  async function checkRoot(rootId: string) {
    setCheckingId(rootId);
    try {
      const result = await api.post<ClusterFileRootCheckResponse>(
        `/admin/cluster-file-roots/${rootId}/check`,
        {},
      );
      setChecks((prev) => ({ ...prev, [rootId]: result }));
      toast.success(t("cp.agents.roots.checkComplete"));
    } catch (err) {
      toast.error(toUserFacingError(err, t("cp.agents.roots.checkFailed")));
    } finally {
      setCheckingId(null);
    }
  }

  if (roots.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("cp.common.loading")}
      </div>
    );
  }
  if (roots.error) {
    return (
      <div className="text-xs text-status-failed" data-testid={`cp-agent-roots-error-${agentId}`}>
        {toUserFacingError(roots.error, t("cp.agents.roots.loadFailed"))}
      </div>
    );
  }
  const rows = roots.data ?? [];
  return (
    <div className="space-y-3" data-testid={`cp-agent-roots-${agentId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-medium">{t("cp.agents.roots.title")}</div>
          <div className="text-xs text-muted-foreground">{t("cp.agents.roots.subtitle")}</div>
        </div>
        {canManagePlatform ? (
          <Button type="button" variant="outline" size="sm" asChild>
            <a href="/settings#infrastructure/cluster-file-roots">
              <ExternalLink className="h-3.5 w-3.5" />
              {t("cp.agents.roots.manage")}
            </a>
          </Button>
        ) : (
          <p
            className="text-xs text-muted-foreground"
            data-testid={`cp-agent-roots-manage-restricted-${agentId}`}
          >
            {t("cp.agents.roots.manageRestricted")}
          </p>
        )}
      </div>
      {rows.length === 0 ? (
        <div
          className="text-xs text-muted-foreground"
          data-testid={`cp-agent-roots-empty-${agentId}`}
        >
          {t("cp.agents.roots.empty")}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((root) => (
            <div
              key={root.id}
              className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between"
              data-testid={`cp-agent-root-row-${root.id}`}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all">{root.path}</code>
                  <Badge variant={root.enabled ? "running" : "outline"}>
                    {root.enabled ? t("cp.agents.roots.enabled") : t("cp.agents.roots.disabled")}
                  </Badge>
                  <Badge variant="outline">
                    {root.agentId === null
                      ? t("cp.agents.roots.allAgents")
                      : t("cp.agents.roots.thisAgent")}
                  </Badge>
                </div>
                <div className="text-muted-foreground">
                  {root.label} ·{" "}
                  {t("cp.agents.roots.visibleOrgCount", {
                    count: root.visibleOrgIds.length,
                  })}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                <CpAgentRootCheckBadge check={checks[root.id]} />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => checkRoot(root.id)}
                  disabled={checkingId === root.id}
                  data-testid={`cp-agent-root-check-${root.id}`}
                >
                  {checkingId === root.id ? <Loader2 className="animate-spin" /> : <Activity />}
                  {t("cp.agents.roots.check")}
                </Button>
                <code className="text-[10px] text-muted-foreground">{root.providerOrgId}</code>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CpAgentRootCheckBadge({ check }: { check?: ClusterFileRootCheckResponse }) {
  const { t } = useTranslation();
  if (!check) {
    return <Badge variant="outline">{t("cp.agents.roots.checkIdle")}</Badge>;
  }
  return (
    <Badge
      variant={check.status === "ok" ? "succeeded" : "failed"}
      title={`${check.path} ${check.checkedAt}`}
      data-testid={`cp-agent-root-check-status-${check.rootId}`}
    >
      {t(`cp.agents.roots.checkStatus.${check.status}`)}
    </Badge>
  );
}

function certStatus(cert: CpAgentCert): "active" | "expired" | "revoked" {
  if (cert.revokedAt) return "revoked";
  if (new Date(cert.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

function CpAgentCerts({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const certs = useCpAgentCerts(agentId);
  const revoke = useRevokeCpAgentCert();
  const [revokeTarget, setRevokeTarget] = useState<CpAgentCert | null>(null);

  async function onConfirmRevoke(reason?: string) {
    if (!revokeTarget) return;
    try {
      await revoke.mutateAsync({
        agentId,
        fingerprintSha256: revokeTarget.fingerprintSha256,
        reason,
      });
      setRevokeTarget(null);
      toast.success(t("cp.agents.certs.revoked"));
    } catch (err) {
      toast.error(toUserFacingError(err, t("cp.agents.certs.revokeFailed")));
    }
  }

  if (certs.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("cp.common.loading")}
      </div>
    );
  }
  if (certs.error) {
    return (
      <div className="text-xs text-status-failed" data-testid={`cp-agent-certs-error-${agentId}`}>
        {toUserFacingError(certs.error, t("cp.agents.certs.loadFailed"))}
      </div>
    );
  }
  const rows = certs.data ?? [];
  if (rows.length === 0) {
    return (
      <div
        className="text-xs text-muted-foreground"
        data-testid={`cp-agent-certs-empty-${agentId}`}
      >
        {t("cp.agents.certs.empty")}
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid={`cp-agent-certs-${agentId}`}>
      {rows.map((cert) => {
        const status = certStatus(cert);
        const revocable = status === "active";
        return (
          <div
            key={cert.fingerprintSha256}
            className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between"
            data-testid={`cp-agent-cert-row-${cert.fingerprintSha256}`}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <code
                  className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
                  title={cert.fingerprintSha256}
                >
                  {cert.fingerprintSha256}
                </code>
                <Badge variant={status === "active" ? "default" : "outline"}>
                  {t(`cp.agents.certs.status.${status}`)}
                </Badge>
              </div>
              <div className="text-muted-foreground">
                {new Date(cert.issuedAt).toLocaleString()} →{" "}
                {new Date(cert.expiresAt).toLocaleString()}
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!revocable || revoke.isPending}
              onClick={() => setRevokeTarget(cert)}
              data-testid={`cp-agent-cert-revoke-${cert.fingerprintSha256}`}
            >
              {revoke.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldX className="h-3.5 w-3.5" />
              )}
              {t("cp.agents.certs.revoke")}
            </Button>
          </div>
        );
      })}
      <AgentCertRevokeDialog
        open={revokeTarget !== null}
        fingerprintSha256={revokeTarget?.fingerprintSha256 ?? null}
        pending={revoke.isPending}
        copy={{
          title: t("cp.agents.certs.revokeDialog.title"),
          description: t("cp.agents.certs.revokeDialog.description"),
          fingerprintLabel: t("cp.agents.certs.revokeDialog.fingerprint"),
          reasonLabel: t("cp.agents.certs.revokeDialog.reason"),
          reasonPlaceholder: t("cp.agents.certs.revokeDialog.reasonPlaceholder"),
          cancel: t("cp.common.cancel"),
          confirm: t("cp.agents.certs.revoke"),
        }}
        testIdPrefix="cp-agent-cert-revoke"
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        onConfirm={(reason) => void onConfirmRevoke(reason)}
      />
    </div>
  );
}

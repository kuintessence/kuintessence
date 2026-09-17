import { Loader2, RefreshCcw, ShieldX } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { AgentCertRevokeDialog } from "../agent/AgentCertRevokeDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

interface AgentCertView {
  id: string;
  fingerprintSha256: string;
  subjectCn: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  issuedBy: string | null;
}

function certStatus(cert: AgentCertView): "revoked" | "expired" | "active" {
  if (cert.revokedAt) return "revoked";
  if (new Date(cert.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

export function AgentCertsPanel() {
  const { t } = useTranslation();
  const [agentId, setAgentId] = useState("");
  const [loadedAgentId, setLoadedAgentId] = useState("");
  const [certs, setCerts] = useState<AgentCertView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AgentCertView | null>(null);

  const refresh = useCallback(
    async (targetAgentId = loadedAgentId) => {
      const normalized = targetAgentId.trim();
      if (!normalized) return;
      setLoading(true);
      try {
        const res = await api.get<{ certs: AgentCertView[] }>(
          `/admin/agents/${encodeURIComponent(normalized)}/certs`,
        );
        setLoadedAgentId(normalized);
        setAgentId(normalized);
        setCerts(res.certs);
        setLoadError(null);
      } catch (err) {
        setCerts(null);
        setLoadError(toUserFacingError(err, "暂时无法加载 Agent 证书，请稍后重试。"));
      } finally {
        setLoading(false);
      }
    },
    [loadedAgentId],
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void refresh(agentId);
  };

  async function revoke(cert: AgentCertView, reason?: string) {
    if (!loadedAgentId) return;
    setRevoking(cert.fingerprintSha256);
    try {
      await api.post<{ success: true }>(
        `/admin/agents/${encodeURIComponent(loadedAgentId)}/cert/${encodeURIComponent(
          cert.fingerprintSha256,
        )}/revoke`,
        reason ? { reason } : {},
      );
      setRevokeTarget(null);
      toast.success(t("settings.agentCerts.revoked"));
      await refresh(loadedAgentId);
    } catch (err) {
      toast.error(
        toUserFacingError(
          err,
          t("settings.agentCerts.revokeFailed", {
            defaultValue: "撤销 Agent 证书失败，请稍后重试。",
          }),
        ),
      );
    } finally {
      setRevoking(null);
    }
  }

  return (
    <Card data-testid="agent-certs-panel">
      <CardHeader>
        <CardTitle>{t("settings.agentCerts.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submit}>
          <Input
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            placeholder={t("settings.agentCerts.agentPlaceholder")}
            data-testid="agent-certs-agent-id"
          />
          <Button
            type="submit"
            variant="outline"
            disabled={loading || agentId.trim() === ""}
            data-testid="agent-certs-load"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t("common.refresh", { defaultValue: "Refresh" })}
          </Button>
        </form>

        <p className="text-[11px] text-muted-foreground">{t("settings.agentCerts.description")}</p>

        {loadError ? (
          <div className="text-sm text-status-failed" data-testid="agent-certs-error">
            {loadError}
          </div>
        ) : null}

        {certs === null ? (
          loadError ? null : (
            <p className="text-[11px] text-muted-foreground" data-testid="agent-certs-idle">
              {t("settings.agentCerts.idle")}
            </p>
          )
        ) : certs.length === 0 ? (
          <p className="text-[11px] text-muted-foreground" data-testid="agent-certs-empty">
            {t("settings.agentCerts.empty")}
          </p>
        ) : (
          <div className="space-y-2">
            {certs.map((cert) => {
              const status = certStatus(cert);
              const revocable = status === "active";
              return (
                <div
                  key={cert.fingerprintSha256}
                  className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between"
                  data-testid={`agent-cert-row-${cert.fingerprintSha256}`}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code
                        className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
                        title={cert.fingerprintSha256}
                      >
                        {cert.fingerprintSha256}
                      </code>
                      <Badge variant={status === "active" ? "default" : "outline"}>
                        {t(`settings.agentCerts.status.${status}`)}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground">
                      {cert.subjectCn} · {new Date(cert.issuedAt).toLocaleString()} →{" "}
                      {new Date(cert.expiresAt).toLocaleString()}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!revocable || revoking === cert.fingerprintSha256}
                    onClick={() => setRevokeTarget(cert)}
                    data-testid={`agent-cert-revoke-${cert.fingerprintSha256}`}
                  >
                    {revoking === cert.fingerprintSha256 ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ShieldX className="h-3.5 w-3.5" />
                    )}
                    {t("settings.agentCerts.revoke")}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <AgentCertRevokeDialog
          open={revokeTarget !== null}
          fingerprintSha256={revokeTarget?.fingerprintSha256 ?? null}
          pending={revoking === revokeTarget?.fingerprintSha256}
          copy={{
            title: t("settings.agentCerts.revokeDialog.title"),
            description: t("settings.agentCerts.revokeDialog.description"),
            fingerprintLabel: t("settings.agentCerts.revokeDialog.fingerprint"),
            reasonLabel: t("settings.agentCerts.revokeDialog.reason"),
            reasonPlaceholder: t("settings.agentCerts.revokeDialog.reasonPlaceholder"),
            cancel: t("common.cancel", { defaultValue: "Cancel" }),
            confirm: t("settings.agentCerts.revoke"),
          }}
          testIdPrefix="agent-cert-revoke"
          onOpenChange={(open) => {
            if (!open) setRevokeTarget(null);
          }}
          onConfirm={(reason) => {
            if (revokeTarget) void revoke(revokeTarget, reason);
          }}
        />

        {certs !== null ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading || !loadedAgentId}
            onClick={() => void refresh(loadedAgentId)}
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            {t("common.refresh", { defaultValue: "Refresh" })}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

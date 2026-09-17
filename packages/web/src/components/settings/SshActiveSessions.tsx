import { Loader2, Power, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

/**
 * live SSH session monitoring (PRD F17).
 *
 * platform_admin sees who currently holds an SSH session and can force-close
 * any of them. Metadata only — no secrets or transcript bytes.
 */

interface SshSessionSummary {
  sessionId: string;
  agentId: string;
  user: string;
  sourceIp?: string;
  openedAtMs: number;
  durationMs: number;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m === 0 ? `${s}s` : `${m}m ${s % 60}s`;
}

export function SshActiveSessions() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SshSessionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [killing, setKilling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ sessions: SshSessionSummary[] }>("/admin/ssh-sessions");
      setSessions(res.sessions);
      setLoadError(null);
    } catch (err) {
      setLoadError(toUserFacingError(err, "暂时无法加载 SSH 会话，请稍后重试。"));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onKill(sessionId: string) {
    setKilling(sessionId);
    try {
      await api.delete(`/admin/ssh-sessions/${encodeURIComponent(sessionId)}`);
      toast.success(t("settings.sshSess.closed", { defaultValue: "Session force-closed" }));
      await refresh();
    } catch (err) {
      toast.error(
        toUserFacingError(
          err,
          t("settings.sshSess.closeFailed", { defaultValue: "断开 SSH 会话失败，请稍后重试。" }),
        ),
      );
    } finally {
      setKilling(null);
    }
  }

  return (
    <Card data-testid="ssh-active-sessions">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>
          {t("settings.sshSess.title", { defaultValue: "Active SSH sessions" })}
        </CardTitle>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="ssh-sess-refresh"
          onClick={() => void refresh()}
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          {t("common.refresh", { defaultValue: "Refresh" })}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {loadError ? (
          <div className="text-sm text-status-failed" data-testid="ssh-sess-error">
            {loadError}
          </div>
        ) : null}
        {sessions === null && !loadError ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common.loading", { defaultValue: "Loading…" })}
          </div>
        ) : sessions?.length === 0 && !loadError ? (
          <p className="text-[11px] text-muted-foreground" data-testid="ssh-sess-empty">
            {t("settings.sshSess.empty", { defaultValue: "No active SSH sessions." })}
          </p>
        ) : sessions && sessions.length > 0 ? (
          sessions.map((s) => (
            <div
              key={s.sessionId}
              data-testid={`ssh-sess-row-${s.sessionId}`}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"
            >
              <div className="min-w-0">
                <div className="font-medium text-foreground">
                  {s.user} → {s.agentId}
                </div>
                <div className="truncate text-muted-foreground">
                  {s.sourceIp ? `${s.sourceIp} · ` : ""}
                  {fmtDuration(s.durationMs)} ·{" "}
                  <span className="font-mono">{s.sessionId.slice(0, 8)}</span>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`ssh-sess-kill-${s.sessionId}`}
                disabled={Boolean(loadError) || killing === s.sessionId}
                onClick={() => onKill(s.sessionId)}
              >
                {killing === s.sessionId ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Power className="h-3.5 w-3.5" />
                )}
                {t("settings.sshSess.kill", { defaultValue: "Disconnect" })}
              </Button>
            </div>
          ))
        ) : null}
      </CardContent>
    </Card>
  );
}

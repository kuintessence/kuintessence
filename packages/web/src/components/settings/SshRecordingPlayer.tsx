import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Loader2, Play, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

/**
 * SSH session recording playback (PRD F17).
 *
 * platform_admin enters (agentId, sessionId) — both visible in the
 * `ssh.session_*` audit rows — and the player fetches a short-lived presigned
 * URL from the Server, downloads the asciinema cast, and replays the terminal
 * output into an xterm instance at the recorded timing.
 */

export interface ParsedCast {
  width: number;
  height: number;
  events: Array<{ tSec: number; data: string }>;
}

/** Parse an asciinema v2 cast: a JSON header line then `[tSec,"o",text]` lines. */
export function parseCast(text: string): ParsedCast {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const header = lines.length > 0 ? (JSON.parse(lines[0] ?? "{}") as Record<string, unknown>) : {};
  const events: ParsedCast["events"] = [];
  for (let i = 1; i < lines.length; i++) {
    const parsed = JSON.parse(lines[i] ?? "null");
    if (Array.isArray(parsed) && parsed[1] === "o" && typeof parsed[0] === "number") {
      events.push({ tSec: parsed[0], data: String(parsed[2] ?? "") });
    }
  }
  return {
    width: typeof header.width === "number" ? header.width : 80,
    height: typeof header.height === "number" ? header.height : 24,
    events,
  };
}

interface RecordingRow {
  agentId: string;
  sessionId: string;
  user: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  sizeBytes: number;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m === 0 ? `${s}s` : `${m}m ${s % 60}s`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type Status = "idle" | "loading" | "playing" | "error";

export function SshRecordingPlayer() {
  const { t } = useTranslation();
  const [agentId, setAgentId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [played, setPlayed] = useState<{ agentId: string; sessionId: string } | null>(null);
  const [list, setList] = useState<RecordingRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const refreshList = useCallback(async () => {
    try {
      const res = await api.get<{ enabled?: boolean; recordings: RecordingRow[] }>(
        "/admin/ssh-recordings",
      );
      setList(res.recordings);
      setEnabled(res.enabled !== false);
      setListError(null);
    } catch (err) {
      setList(null);
      setListError(toUserFacingError(err, "暂时无法加载 SSH 录制列表，请稍后重试。"));
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  function clearTimers() {
    for (const id of timersRef.current) clearTimeout(id);
    timersRef.current = [];
  }

  // Tear down xterm + any pending replay timers on unmount. Reads the refs at
  // cleanup time (refs are stable, so this mount-once effect needs no deps).
  useEffect(() => {
    return () => {
      for (const id of timersRef.current) clearTimeout(id);
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, []);

  async function play(a: string, s: string) {
    if (!a || !s) return;
    setAgentId(a);
    setSessionId(s);
    setStatus("loading");
    setError(null);
    clearTimers();
    try {
      const { url } = await api.get<{ url: string }>(
        `/admin/ssh-recordings/${encodeURIComponent(a)}/${encodeURIComponent(s)}`,
      );
      const res = await fetch(url);
      if (!res.ok) throw new Error("recording download failed");
      const cast = parseCast(await res.text());

      termRef.current?.dispose();
      const term = new Terminal({
        convertEol: true,
        scrollback: 10_000,
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: 12,
        cols: cast.width,
        rows: cast.height,
      });
      if (containerRef.current) term.open(containerRef.current);
      termRef.current = term;

      // Replay each output chunk at its recorded offset.
      for (const ev of cast.events) {
        timersRef.current.push(setTimeout(() => term.write(ev.data), Math.max(0, ev.tSec * 1000)));
      }
      setStatus("playing");
      setPlayed({ agentId: a, sessionId: s });
    } catch (err) {
      setError(
        toUserFacingError(
          err,
          t("settings.sshRec.playbackFailed", {
            defaultValue: "无法播放该 SSH 录制，请稍后重试。",
          }),
        ),
      );
      setStatus("error");
    }
  }

  function onPlay(e: FormEvent) {
    e.preventDefault();
    void play(agentId.trim(), sessionId.trim());
  }

  async function onDelete() {
    if (!played) return;
    try {
      await api.delete(
        `/admin/ssh-recordings/${encodeURIComponent(played.agentId)}/${encodeURIComponent(played.sessionId)}`,
      );
      clearTimers();
      termRef.current?.dispose();
      termRef.current = null;
      setPlayed(null);
      setStatus("idle");
      await refreshList();
      toast.success(t("settings.sshRec.deleted", { defaultValue: "Recording deleted" }));
    } catch (err) {
      toast.error(
        toUserFacingError(
          err,
          t("settings.sshRec.deleteFailed", { defaultValue: "删除 SSH 录制失败，请稍后重试。" }),
        ),
      );
    }
  }

  return (
    <Card data-testid="ssh-recording-player">
      <CardHeader>
        <CardTitle>
          {t("settings.sshRec.title", { defaultValue: "SSH session playback" })}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Browsable index of recorded sessions (when recording is enabled). */}
        {listError ? (
          <div className="text-xs text-status-failed" data-testid="ssh-rec-list-error">
            {listError}
          </div>
        ) : null}

        {list && list.length > 0 ? (
          <div className="space-y-1.5" data-testid="ssh-rec-list">
            {list.map((rec) => (
              <button
                type="button"
                key={`${rec.agentId}/${rec.sessionId}`}
                data-testid={`ssh-rec-list-row-${rec.sessionId}`}
                onClick={() => void play(rec.agentId, rec.sessionId)}
                className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-left text-xs hover:bg-muted/60"
              >
                <span className="min-w-0">
                  <span className="font-medium text-foreground">
                    {rec.user} → {rec.agentId}
                  </span>
                  <span className="block truncate text-muted-foreground">
                    {fmtDuration(rec.durationMs)} · {fmtBytes(rec.sizeBytes)} ·{" "}
                    {new Date(rec.endedAt).toLocaleString()}
                  </span>
                </span>
                <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        ) : null}

        {!enabled ? (
          <div
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
            data-testid="ssh-rec-disabled"
          >
            {t("settings.sshRec.disabled", {
              defaultValue: "SSH session recording is not enabled on this platform.",
            })}
          </div>
        ) : null}

        {enabled ? (
          <form className="flex flex-wrap items-end gap-2" onSubmit={onPlay}>
            <div className="space-y-1.5">
              <label
                htmlFor="ssh-rec-agent"
                className="block text-xs uppercase tracking-wide text-muted-foreground"
              >
                {t("settings.sshRec.agentId", { defaultValue: "Agent ID" })}
              </label>
              <Input
                id="ssh-rec-agent"
                data-testid="ssh-rec-agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="ssh-rec-session"
                className="block text-xs uppercase tracking-wide text-muted-foreground"
              >
                {t("settings.sshRec.sessionId", { defaultValue: "Session ID" })}
              </label>
              <Input
                id="ssh-rec-session"
                data-testid="ssh-rec-session"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              data-testid="ssh-rec-play"
              disabled={status === "loading" || agentId.trim() === "" || sessionId.trim() === ""}
            >
              {status === "loading" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {t("settings.sshRec.play", { defaultValue: "Play" })}
            </Button>
            {played ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="ssh-rec-delete"
                onClick={onDelete}
                disabled={listError !== null}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("settings.sshRec.delete", { defaultValue: "Delete recording" })}
              </Button>
            ) : null}
          </form>
        ) : null}

        {error ? (
          <div className="text-xs text-status-failed" data-testid="ssh-rec-error">
            {error}
          </div>
        ) : null}

        {enabled ? (
          <div
            ref={containerRef}
            data-testid="ssh-rec-viewport"
            className="h-[40vh] w-full overflow-hidden rounded-md border border-border bg-card"
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

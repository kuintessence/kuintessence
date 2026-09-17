import { Loader2, Save, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api-client";
import { platformApiUrl } from "../../lib/platform-paths";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

/**
 * admin SSH credential vault form (PRD F17).
 *
 * Visible only to platform_admin (the parent SettingsPage gates on role).
 * Lists configured agents (GET /api/admin/ssh-credentials, secret-free) and
 * sets/rotates/deletes per-agent credentials. The secret material (password /
 * private key) is write-only — the list shows only whether a secret is set.
 */

interface SshCredentialView {
  agentId: string;
  host: string;
  port: number;
  username: string;
  hasSecret: boolean;
  hostKeySha256: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface FormState {
  agentId: string;
  host: string;
  port: string;
  username: string;
  password: string;
  privateKey: string;
  passphrase: string;
  hostKeySha256: string;
}

const EMPTY_FORM: FormState = {
  agentId: "",
  host: "",
  port: "22",
  username: "",
  password: "",
  privateKey: "",
  passphrase: "",
  hostKeySha256: "",
};

export function SshCredentialsForm() {
  const { t } = useTranslation();
  const [list, setList] = useState<SshCredentialView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ credentials: SshCredentialView[] }>("/admin/ssh-credentials");
      setList(res.credentials);
      setLoadError(null);
    } catch (err) {
      setLoadError(toUserFacingError(err, "暂时无法加载 SSH 凭据，请稍后重试。"));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function editAgent(row: SshCredentialView) {
    if (loadError) return;
    setForm({
      agentId: row.agentId,
      host: row.host,
      port: String(row.port),
      username: row.username,
      password: "",
      privateKey: "",
      passphrase: "",
      hostKeySha256: row.hostKeySha256,
    });
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (loadError) return;
    const agentId = form.agentId.trim();
    if (!agentId) {
      toast.error(t("settings.ssh.needAgent", { defaultValue: "Agent ID is required" }));
      return;
    }
    setSaving(true);
    try {
      const tok = typeof localStorage !== "undefined" ? localStorage.getItem("kq_token") : null;
      const body: Record<string, unknown> = {
        host: form.host,
        port: Number.parseInt(form.port, 10) || 22,
        username: form.username,
      };
      if (form.password) body.password = form.password;
      if (form.privateKey) body.privateKey = form.privateKey;
      if (form.passphrase) body.passphrase = form.passphrase;
      body.hostKeySha256 = form.hostKeySha256; // sent verbatim ("" clears the pin)
      const res = await fetch(
        platformApiUrl(`/admin/ssh-credentials/${encodeURIComponent(agentId)}`),
        {
          credentials: "same-origin",
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as {
          error?: string | { code?: string; message?: string; details?: unknown };
        };
        const detail = typeof b.error === "object" ? b.error : undefined;
        const message = typeof b.error === "string" ? b.error : detail?.message;
        throw new ApiError(
          res.status,
          detail?.code ?? "SSH_CREDENTIALS_REQUEST_FAILED",
          message ?? res.statusText,
          detail?.details,
        );
      }
      toast.success(t("settings.ssh.saved", { defaultValue: "SSH credentials saved" }));
      setForm(EMPTY_FORM);
      await refresh();
    } catch (err) {
      toast.error(
        toUserFacingError(
          err,
          t("settings.ssh.saveFailed", { defaultValue: "保存 SSH 凭据失败，请检查配置后重试。" }),
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(agentId: string) {
    if (loadError) return;
    try {
      await api.delete(`/admin/ssh-credentials/${encodeURIComponent(agentId)}`);
      toast.success(t("settings.ssh.deleted", { defaultValue: "Credentials removed" }));
      await refresh();
    } catch (err) {
      toast.error(
        toUserFacingError(
          err,
          t("settings.ssh.deleteFailed", { defaultValue: "删除 SSH 凭据失败，请稍后重试。" }),
        ),
      );
    }
  }

  return (
    <Card data-testid="ssh-credentials-form">
      <CardHeader>
        <CardTitle>{t("settings.ssh.title", { defaultValue: "SSH credential vault" })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <div className="text-sm text-status-failed" data-testid="ssh-load-error">
            {loadError}
          </div>
        ) : null}

        {/* Configured agents */}
        <div className="space-y-2" data-testid="ssh-cred-list">
          {list === null && !loadError ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("common.loading", { defaultValue: "Loading…" })}
            </div>
          ) : list?.length === 0 && !loadError ? (
            <p className="text-[11px] text-muted-foreground" data-testid="ssh-cred-empty">
              {t("settings.ssh.empty", { defaultValue: "No agents have SSH credentials yet." })}
            </p>
          ) : list && list.length > 0 ? (
            list.map((row) => (
              <div
                key={row.agentId}
                data-testid={`ssh-cred-row-${row.agentId}`}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{row.agentId}</div>
                  <div className="truncate text-muted-foreground">
                    {row.username}@{row.host}:{row.port} ·{" "}
                    {row.hasSecret
                      ? t("settings.ssh.secretSet", { defaultValue: "secret set" })
                      : t("settings.ssh.noSecret", { defaultValue: "no secret" })}
                    {row.hostKeySha256
                      ? ` · ${t("settings.ssh.pinned", { defaultValue: "host-key pinned" })}`
                      : ""}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`ssh-cred-edit-${row.agentId}`}
                    disabled={Boolean(loadError)}
                    onClick={() => editAgent(row)}
                  >
                    {t("settings.ssh.rotate", { defaultValue: "Rotate" })}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-testid={`ssh-cred-delete-${row.agentId}`}
                    aria-label={t("common.remove", { defaultValue: "Remove" })}
                    disabled={Boolean(loadError)}
                    onClick={() => onDelete(row.agentId)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))
          ) : null}
        </div>

        {/* Set / rotate form */}
        <form className="space-y-3 border-t border-border pt-3" onSubmit={onSave}>
          <div className="grid grid-cols-2 gap-2">
            <LabeledInput
              id="ssh-agent-id"
              label={t("settings.ssh.agentId", { defaultValue: "Agent ID" })}
              value={form.agentId}
              onChange={(v) => update("agentId", v)}
            />
            <LabeledInput
              id="ssh-username"
              label={t("settings.ssh.username", { defaultValue: "Username" })}
              value={form.username}
              onChange={(v) => update("username", v)}
            />
            <LabeledInput
              id="ssh-host"
              label={t("settings.ssh.host", { defaultValue: "Host" })}
              value={form.host}
              onChange={(v) => update("host", v)}
            />
            <LabeledInput
              id="ssh-port"
              label={t("settings.ssh.port", { defaultValue: "Port" })}
              value={form.port}
              onChange={(v) => update("port", v)}
            />
          </div>
          <LabeledInput
            id="ssh-password"
            label={t("settings.ssh.password", { defaultValue: "Password (or use a key)" })}
            type="password"
            value={form.password}
            onChange={(v) => update("password", v)}
            autoComplete="new-password"
          />
          <div className="space-y-1.5">
            <label
              htmlFor="ssh-private-key"
              className="block text-xs uppercase tracking-wide text-muted-foreground"
            >
              {t("settings.ssh.privateKey", { defaultValue: "Private key (PEM)" })}
            </label>
            <textarea
              id="ssh-private-key"
              data-testid="ssh-private-key"
              value={form.privateKey}
              onChange={(e) => update("privateKey", e.target.value)}
              rows={3}
              className="w-full rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[11px]"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              autoComplete="off"
            />
          </div>
          <LabeledInput
            id="ssh-passphrase"
            label={t("settings.ssh.passphrase", { defaultValue: "Key passphrase (optional)" })}
            type="password"
            value={form.passphrase}
            onChange={(v) => update("passphrase", v)}
            autoComplete="new-password"
          />
          <p className="text-[11px] text-muted-foreground">
            {t("settings.ssh.secretHelp", {
              defaultValue: "Auth material is encrypted at rest and never read back.",
            })}
          </p>
          <LabeledInput
            id="ssh-host-key"
            label={t("settings.ssh.hostKey", { defaultValue: "Host-key pin (base64 SHA-256)" })}
            value={form.hostKeySha256}
            onChange={(v) => update("hostKeySha256", v)}
          />
          <p className="text-[11px] text-muted-foreground">
            {t("settings.ssh.hostKeyHelp", {
              defaultValue:
                "Optional. When set, the agent rejects a mismatched host key (MITM defense). Empty = unverified.",
            })}
          </p>
          <Button
            type="submit"
            size="sm"
            data-testid="ssh-cred-save"
            disabled={saving || Boolean(loadError)}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {t("settings.ssh.save", { defaultValue: "Save credentials" })}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

interface LabeledInputProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
}

function LabeledInput({ id, label, value, onChange, type, autoComplete }: LabeledInputProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        data-testid={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
      />
    </div>
  );
}

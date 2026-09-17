import { Loader2, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { platformApiUrl } from "../../lib/platform-paths";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

/**
 * admin SSO configuration form (PRD F1.1).
 *
 * Visible only to platform_admin (the parent SettingsPage gates on the
 * resolved role). The form mirrors the wire shape of GET / PUT
 * /api/admin/sso/config:
 *
 *   - enabled toggle
 *   - provider type (only `oidc` is supported)
 *   - issuer URL, client ID
 *   - client secret as password input; when an existing secret is set the
 *     placeholder reads "(unchanged — re-enter to rotate)" and the field
 *     remains empty
 *   - computed read-only redirect URI (origin + /platform/api/auth/oidc/callback)
 *   - group→role mapping editor (rows of (group name, role select))
 *   - autoCreateUsers toggle
 *
 * Two action buttons: "Test connection" hits POST /admin/sso/test and shows
 * a banner with discovered endpoints; "Save" persists the form via PUT and
 * toasts on success/failure.
 */

const REDACTED = "__redacted__";
const PROVIDER_TYPES = ["oidc", "saml", "ldap"] as const;
type ProviderType = (typeof PROVIDER_TYPES)[number];
const ROLES = ["super_admin", "platform_admin", "operator", "org_admin", "user", "guest"] as const;
type Role = (typeof ROLES)[number];

interface SsoConfigView {
  enabled: boolean;
  providerType: ProviderType;
  providerDisplayName: string;
  loginWelcomeZh: string;
  loginWelcomeEn: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: typeof REDACTED | "";
  redirectUri: string;
  groupMapping: Record<string, Role>;
  autoCreateUsers: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface FormState {
  enabled: boolean;
  providerType: ProviderType;
  providerDisplayName: string;
  loginWelcomeZh: string;
  loginWelcomeEn: string;
  issuerUrl: string;
  clientId: string;
  /** "" → keep existing secret; non-empty → rotate. Never displays the real value. */
  clientSecret: string;
  /** Hidden indicator: was a secret already saved on the server? */
  hasStoredSecret: boolean;
  redirectUri: string;
  groupMappingRows: Array<{ key: string; value: Role }>;
  autoCreateUsers: boolean;
}

interface TestResult {
  success: boolean;
  issuer: string | null;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  userinfoEndpoint: string | null;
  jwksUri: string | null;
  error: string | null;
}

function viewToForm(v: SsoConfigView): FormState {
  return {
    enabled: v.enabled,
    providerType: v.providerType,
    providerDisplayName: v.providerDisplayName ?? "",
    loginWelcomeZh: v.loginWelcomeZh ?? "",
    loginWelcomeEn: v.loginWelcomeEn ?? "",
    issuerUrl: v.issuerUrl,
    clientId: v.clientId,
    clientSecret: "",
    hasStoredSecret: v.clientSecret === REDACTED,
    redirectUri:
      v.redirectUri && v.redirectUri.length > 0 ? v.redirectUri : computeDefaultRedirect(),
    groupMappingRows: Object.entries(v.groupMapping).map(([key, value]) => ({
      key,
      value: value as Role,
    })),
    autoCreateUsers: v.autoCreateUsers,
  };
}

function computeDefaultRedirect(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}${platformApiUrl("/auth/oidc/callback")}`;
}

function formToWire(state: FormState): {
  enabled: boolean;
  providerType: ProviderType;
  providerDisplayName: string;
  loginWelcomeZh: string;
  loginWelcomeEn: string;
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  groupMapping: Record<string, Role>;
  autoCreateUsers: boolean;
} {
  const groupMapping: Record<string, Role> = {};
  for (const row of state.groupMappingRows) {
    const k = row.key.trim();
    if (k.length === 0) continue;
    groupMapping[k] = row.value;
  }
  const out: ReturnType<typeof formToWire> = {
    enabled: state.enabled,
    providerType: state.providerType,
    providerDisplayName: state.providerDisplayName,
    loginWelcomeZh: state.loginWelcomeZh,
    loginWelcomeEn: state.loginWelcomeEn,
    issuerUrl: state.issuerUrl,
    clientId: state.clientId,
    redirectUri: state.redirectUri,
    groupMapping,
    autoCreateUsers: state.autoCreateUsers,
  };
  // Only include clientSecret if the operator typed something. An empty
  // string MEANS "keep existing"; sending the field at all would cause the
  // backend to clear when there's no stored secret.
  if (state.clientSecret.length > 0) {
    out.clientSecret = state.clientSecret;
  }
  return out;
}

export function SSOConfigForm() {
  const { t } = useTranslation();
  const [state, setState] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<SsoConfigView>("/admin/sso/config")
      .then((view) => {
        if (cancelled) return;
        setState(viewToForm(view));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(toUserFacingError(err, "暂时无法加载 SSO 配置，请稍后重试。"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <Card data-testid="sso-config-form">
        <CardHeader>
          <CardTitle>
            {t("settings.sso.title", { defaultValue: "Single Sign-On (OIDC)" })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-status-failed" data-testid="sso-load-error">
            {loadError}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!state) {
    return (
      <Card data-testid="sso-config-form">
        <CardHeader>
          <CardTitle>
            {t("settings.sso.title", { defaultValue: "Single Sign-On (OIDC)" })}
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

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function addGroupRow() {
    setState((prev) =>
      prev
        ? { ...prev, groupMappingRows: [...prev.groupMappingRows, { key: "", value: "user" }] }
        : prev,
    );
  }

  function removeGroupRow(idx: number) {
    setState((prev) =>
      prev
        ? {
            ...prev,
            groupMappingRows: prev.groupMappingRows.filter((_, i) => i !== idx),
          }
        : prev,
    );
  }

  function updateGroupRow(idx: number, key: string, value: Role) {
    setState((prev) =>
      prev
        ? {
            ...prev,
            groupMappingRows: prev.groupMappingRows.map((row, i) =>
              i === idx ? { key, value } : row,
            ),
          }
        : prev,
    );
  }

  async function onTest() {
    if (!state) return;
    setTesting(true);
    setTestResult(null);
    try {
      const body: { issuerUrl: string; clientId: string; clientSecret?: string } = {
        issuerUrl: state.issuerUrl,
        clientId: state.clientId,
      };
      if (state.clientSecret.length > 0) {
        body.clientSecret = state.clientSecret;
      }
      const result = await api.post<TestResult>("/admin/sso/test", body);
      setTestResult(result);
    } catch (err) {
      const message = toUserFacingError(
        err,
        t("settings.sso.testFailed", { defaultValue: "连接测试失败，请稍后重试。" }),
      );
      setTestResult({
        success: false,
        issuer: null,
        authorizationEndpoint: null,
        tokenEndpoint: null,
        userinfoEndpoint: null,
        jwksUri: null,
        error: message,
      });
    } finally {
      setTesting(false);
    }
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!state) return;
    setSaving(true);
    try {
      const view = await api.put<SsoConfigView>("/admin/sso/config", formToWire(state));
      setState(viewToForm(view));
      toast.success(t("settings.sso.saved", { defaultValue: "SSO configuration saved" }));
    } catch (err) {
      toast.error(
        toUserFacingError(
          err,
          t("settings.sso.saveFailed", { defaultValue: "保存 SSO 配置失败，请稍后重试。" }),
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="sso-config-form">
      <CardHeader>
        <CardTitle>{t("settings.sso.title", { defaultValue: "Single Sign-On (OIDC)" })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="space-y-4" onSubmit={onSave}>
          {/* Enabled toggle */}
          <label className="flex items-center gap-2 text-sm" data-testid="sso-enabled-row">
            <input
              type="checkbox"
              checked={state.enabled}
              onChange={(e) => update("enabled", e.target.checked)}
              data-testid="sso-enabled"
            />
            <span>
              {t("settings.sso.enabled", { defaultValue: "Enable SSO for this platform" })}
            </span>
          </label>

          <div className="grid gap-4 rounded-md border border-border bg-muted/20 p-4">
            <div>
              <div className="text-sm font-medium">{t("settings.sso.loginDisplayTitle")}</div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.sso.loginDisplayDescription")}
              </p>
            </div>
            <Field label={t("settings.sso.providerDisplayName")} id="sso-provider-display-name">
              <Input
                id="sso-provider-display-name"
                data-testid="sso-provider-display-name"
                value={state.providerDisplayName}
                onChange={(e) => update("providerDisplayName", e.target.value)}
                placeholder={t("settings.sso.providerDisplayNamePlaceholder")}
                maxLength={80}
              />
            </Field>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t("settings.sso.loginWelcomeZh")} id="sso-login-welcome-zh">
                <Input
                  id="sso-login-welcome-zh"
                  data-testid="sso-login-welcome-zh"
                  value={state.loginWelcomeZh}
                  onChange={(e) => update("loginWelcomeZh", e.target.value)}
                  placeholder={t("settings.sso.loginWelcomeZhPlaceholder")}
                  maxLength={240}
                />
              </Field>
              <Field label={t("settings.sso.loginWelcomeEn")} id="sso-login-welcome-en">
                <Input
                  id="sso-login-welcome-en"
                  data-testid="sso-login-welcome-en"
                  value={state.loginWelcomeEn}
                  onChange={(e) => update("loginWelcomeEn", e.target.value)}
                  placeholder={t("settings.sso.loginWelcomeEnPlaceholder")}
                  maxLength={240}
                />
              </Field>
            </div>
          </div>

          {/* Provider type */}
          <div className="space-y-1.5">
            <label
              htmlFor="sso-provider"
              className="block text-xs uppercase tracking-wide text-muted-foreground"
            >
              {t("settings.sso.providerType", { defaultValue: "Provider type" })}
            </label>
            <select
              id="sso-provider"
              data-testid="sso-provider-type"
              value={state.providerType}
              onChange={(e) => update("providerType", e.target.value as ProviderType)}
              className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm"
            >
              {PROVIDER_TYPES.map((p) => (
                <option key={p} value={p} disabled={p !== "oidc"}>
                  {p}
                  {p !== "oidc" ? " (coming soon)" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Issuer URL */}
          <Field
            label={t("settings.sso.issuerUrl", { defaultValue: "Issuer URL" })}
            id="sso-issuer-url"
          >
            <Input
              id="sso-issuer-url"
              data-testid="sso-issuer-url"
              type="url"
              value={state.issuerUrl}
              onChange={(e) => update("issuerUrl", e.target.value)}
              placeholder="https://idp.example.com"
              autoComplete="off"
            />
          </Field>

          {/* Client ID */}
          <Field
            label={t("settings.sso.clientId", { defaultValue: "Client ID" })}
            id="sso-client-id"
          >
            <Input
              id="sso-client-id"
              data-testid="sso-client-id"
              value={state.clientId}
              onChange={(e) => update("clientId", e.target.value)}
              autoComplete="off"
            />
          </Field>

          {/* Client secret */}
          <Field
            label={t("settings.sso.clientSecret", { defaultValue: "Client secret" })}
            id="sso-client-secret"
          >
            <Input
              id="sso-client-secret"
              data-testid="sso-client-secret"
              type="password"
              value={state.clientSecret}
              onChange={(e) => update("clientSecret", e.target.value)}
              placeholder={
                state.hasStoredSecret
                  ? t("settings.sso.secretUnchanged", {
                      defaultValue: "(unchanged — re-enter to rotate)",
                    })
                  : ""
              }
              autoComplete="new-password"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("settings.sso.secretHelp", {
                defaultValue: "Stored encrypted at rest. Leave empty to keep the existing value.",
              })}
            </p>
          </Field>

          {/* Redirect URI (read-only) */}
          <Field
            label={t("settings.sso.redirectUri", { defaultValue: "Redirect URI" })}
            id="sso-redirect-uri"
          >
            <Input
              id="sso-redirect-uri"
              data-testid="sso-redirect-uri"
              value={state.redirectUri}
              onChange={(e) => update("redirectUri", e.target.value)}
              readOnly
              className="font-mono"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("settings.sso.redirectHelp", {
                defaultValue: "Add this URI to your IdP's allowed redirect list.",
              })}
            </p>
          </Field>

          {/* Group mapping */}
          <div className="space-y-2" data-testid="sso-group-mapping">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {t("settings.sso.groupMapping", { defaultValue: "Group → Role mapping" })}
            </div>
            {state.groupMappingRows.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {t("settings.sso.groupMappingEmpty", {
                  defaultValue: "No groups mapped — every signed-in user defaults to 'user'.",
                })}
              </p>
            ) : null}
            {state.groupMappingRows.map((row, idx) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are list-like, no animation, no stable id available
                key={`row-${idx}`}
                data-testid={`sso-group-row-${idx}`}
                className="flex items-center gap-2"
              >
                <Input
                  data-testid={`sso-group-key-${idx}`}
                  value={row.key}
                  onChange={(e) => updateGroupRow(idx, e.target.value, row.value)}
                  placeholder="idp-group-name"
                  className="flex-1"
                />
                <select
                  data-testid={`sso-group-role-${idx}`}
                  value={row.value}
                  onChange={(e) => updateGroupRow(idx, row.key, e.target.value as Role)}
                  className="h-9 rounded-md border border-border bg-card px-2 text-sm"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-testid={`sso-group-remove-${idx}`}
                  onClick={() => removeGroupRow(idx)}
                  aria-label={t("common.remove", { defaultValue: "Remove" })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="sso-group-add"
              onClick={addGroupRow}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("settings.sso.addGroup", { defaultValue: "Add group mapping" })}
            </Button>
          </div>

          {/* Auto-create users toggle */}
          <label className="flex items-center gap-2 text-sm" data-testid="sso-autocreate-row">
            <input
              type="checkbox"
              checked={state.autoCreateUsers}
              onChange={(e) => update("autoCreateUsers", e.target.checked)}
              data-testid="sso-autocreate"
            />
            <span>
              {t("settings.sso.autoCreate", {
                defaultValue: "Auto-create users on first SSO login",
              })}
            </span>
          </label>

          {/* Test result banner */}
          {testResult ? (
            <div
              data-testid="sso-test-result"
              className={cn(
                "rounded-md border px-3 py-2 text-xs",
                testResult.success
                  ? "border-status-running/40 bg-[color-mix(in_oklab,var(--status-running)_10%,transparent)] text-status-running"
                  : "border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] text-status-failed",
              )}
            >
              {testResult.success ? (
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1.5 font-medium">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {t("settings.sso.testSuccess", { defaultValue: "Discovery succeeded" })}
                  </div>
                  <code className="block break-all text-[10.5px] text-muted-foreground">
                    {testResult.issuer}
                  </code>
                  <code className="block break-all text-[10.5px] text-muted-foreground">
                    auth: {testResult.authorizationEndpoint ?? "-"}
                  </code>
                  <code className="block break-all text-[10.5px] text-muted-foreground">
                    token: {testResult.tokenEndpoint ?? "-"}
                  </code>
                </div>
              ) : (
                <div>
                  {t("settings.sso.testFailed", {
                    defaultValue: "连接测试失败，请检查配置后重试。",
                  })}
                </div>
              )}
            </div>
          ) : null}

          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="sso-test"
              disabled={testing || state.issuerUrl.length === 0 || state.clientId.length === 0}
              onClick={onTest}
            >
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t("settings.sso.test", { defaultValue: "Test connection" })}
            </Button>
            <Button type="submit" size="sm" data-testid="sso-save" disabled={saving}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {t("settings.sso.save", { defaultValue: "Save" })}
            </Button>
            {state.hasStoredSecret ? (
              <span className="text-[11px] text-muted-foreground" data-testid="sso-secret-stored">
                {t("settings.sso.secretStored", { defaultValue: "Secret stored (encrypted)" })}
              </span>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

interface FieldProps {
  label: string;
  id: string;
  children: React.ReactNode;
}

function Field({ label, id, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

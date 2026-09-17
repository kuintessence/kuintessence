import { useQueryClient } from "@tanstack/react-query";
import { Check, Clipboard, KeyRound, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ActiveAgentRegistrationToken,
  AgentRegistrationScheduler,
  AgentRegistrationToken,
} from "../../lib/cp-client";
import {
  useActiveAgentRegistrationTokens,
  useAgentRegistrationContext,
  useCreateAgentRegistrationToken,
  useRevokeAgentRegistrationToken,
} from "../../lib/use-cp-agent-registration";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

interface IssuedToken extends AgentRegistrationToken {
  command: string;
}

const DEFAULT_REGISTRATION_SCHEDULERS: AgentRegistrationScheduler[] = [
  "slurm",
  "pbs-pro",
  "torque",
  "kubernetes",
];

function defaultHttpUrl(): string {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  if (url.port === "5173") url.port = "3000";
  return url.origin;
}

function defaultGrpcUrl(): string {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  if (url.port === "5173" || url.port === "3000") {
    url.port = "3001";
  }
  return url.origin;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildRegisterCommand(input: {
  serverHttpUrl: string;
  serverGrpcUrl: string;
  token: string;
  scheduler: string;
}): string {
  const parts = [
    "kq agent register",
    `  --url ${shellQuote(input.serverHttpUrl)}`,
    `  --grpc-url ${shellQuote(input.serverGrpcUrl)}`,
    `  --token ${shellQuote(input.token)}`,
  ];
  if (input.scheduler.trim() !== "") {
    parts.push(`  --scheduler ${shellQuote(input.scheduler.trim())}`);
  }
  return parts.join(" \\\n");
}

export function AgentRegistrationPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const context = useAgentRegistrationContext();
  const activeTokens = useActiveAgentRegistrationTokens();
  const createToken = useCreateAgentRegistrationToken();
  const revokeToken = useRevokeAgentRegistrationToken();
  const [providerOrgId, setProviderOrgId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [siteName, setSiteName] = useState("");
  const [ttlSec, setTtlSec] = useState("86400");
  const serverHttpUrl = useMemo(defaultHttpUrl, []);
  const serverGrpcUrl = useMemo(defaultGrpcUrl, []);
  const [scheduler, setScheduler] = useState<AgentRegistrationScheduler>("slurm");
  const [issuedTokens, setIssuedTokens] = useState<IssuedToken[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  const providerOrgs = context.data?.providerOrgs ?? [];
  const schedulers = context.data?.schedulers ?? DEFAULT_REGISTRATION_SCHEDULERS;
  const issuedTokenIds = useMemo(
    () => new Set(issuedTokens.map((token) => token.id)),
    [issuedTokens],
  );
  const persistedActiveTokens = useMemo(
    () => (activeTokens.data ?? []).filter((token) => !issuedTokenIds.has(token.id)),
    [activeTokens.data, issuedTokenIds],
  );
  const ttl = useMemo(() => Number.parseInt(ttlSec, 10), [ttlSec]);
  const formValid =
    providerOrgId.trim() !== "" &&
    agentId.trim() !== "" &&
    siteName.trim() !== "" &&
    serverHttpUrl.trim() !== "" &&
    serverGrpcUrl.trim() !== "" &&
    Number.isFinite(ttl) &&
    ttl > 0;

  useEffect(() => {
    if (providerOrgs.length === 0) return;
    if (providerOrgs.some((org) => org.id === providerOrgId)) return;
    setProviderOrgId(providerOrgs[0]?.id ?? "");
  }, [providerOrgId, providerOrgs]);

  useEffect(() => {
    if (schedulers.some((item) => item === scheduler)) return;
    setScheduler(schedulers[0] ?? "slurm");
  }, [scheduler, schedulers]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (context.error) return;
    if (!formValid) return;
    const token = await createToken.mutateAsync({
      providerOrgId: providerOrgId.trim(),
      agentId: agentId.trim(),
      siteName: siteName.trim(),
      expiresInSec: ttl,
    });
    const command = buildRegisterCommand({
      serverHttpUrl,
      serverGrpcUrl,
      scheduler,
      token: token.token,
    });
    setIssuedTokens((items) => [{ ...token, command }, ...items]);
    await queryClient.invalidateQueries({ queryKey: ["cp", "agent-registration-tokens"] });
  };

  const copyText = async (key: string, value: string) => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1600);
  };

  const revoke = async (token: IssuedToken) => {
    await revokeToken.mutateAsync(token.id);
    setIssuedTokens((items) => items.filter((item) => item.id !== token.id));
    await queryClient.invalidateQueries({ queryKey: ["cp", "agent-registration-tokens"] });
  };

  const revokeActive = async (token: ActiveAgentRegistrationToken) => {
    await revokeToken.mutateAsync(token.id);
    await queryClient.invalidateQueries({ queryKey: ["cp", "agent-registration-tokens"] });
  };

  return (
    <div className="space-y-4" data-testid="cp-agent-registration-page">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {t("cp.agentRegistration.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("cp.agentRegistration.subtitle")}</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t("cp.agentRegistration.form.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <div className="grid gap-3 sm:grid-cols-6">
                <label
                  className="space-y-1 text-sm sm:col-span-4"
                  htmlFor="agent-registration-provider"
                >
                  <span className="text-muted-foreground">
                    {t("cp.agentRegistration.form.providerOrgId")}
                  </span>
                  <select
                    id="agent-registration-provider"
                    value={providerOrgId}
                    onChange={(event) => setProviderOrgId(event.target.value)}
                    data-testid="agent-registration-provider"
                    className={selectClassName}
                    disabled={context.isLoading || providerOrgs.length === 0}
                    required
                  >
                    {providerOrgs.length === 0 ? (
                      <option value="">{t("cp.agentRegistration.form.noProviderOrgs")}</option>
                    ) : null}
                    {providerOrgs.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                  {providerOrgId ? (
                    <code
                      className="block min-w-0 truncate rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground"
                      title={providerOrgId}
                    >
                      {t("cp.agentRegistration.form.selectedProviderOrgId")}: {providerOrgId}
                    </code>
                  ) : null}
                </label>
                <label className="space-y-1 text-sm sm:col-span-2" htmlFor="agent-registration-ttl">
                  <span className="text-muted-foreground">
                    {t("cp.agentRegistration.form.ttlSec")}
                  </span>
                  <Input
                    id="agent-registration-ttl"
                    type="number"
                    min={1}
                    value={ttlSec}
                    onChange={(event) => setTtlSec(event.target.value)}
                    data-testid="agent-registration-ttl"
                    required
                  />
                </label>
                <label
                  className="space-y-1 text-sm sm:col-span-3"
                  htmlFor="agent-registration-agent-id"
                >
                  <span className="text-muted-foreground">
                    {t("cp.agentRegistration.form.agentId")}
                  </span>
                  <Input
                    id="agent-registration-agent-id"
                    value={agentId}
                    onChange={(event) => setAgentId(event.target.value)}
                    data-testid="agent-registration-agent-id"
                    placeholder="example-slurm-a"
                    required
                  />
                </label>
                <label
                  className="space-y-1 text-sm sm:col-span-3"
                  htmlFor="agent-registration-site-name"
                >
                  <span className="text-muted-foreground">
                    {t("cp.agentRegistration.form.siteName")}
                  </span>
                  <Input
                    id="agent-registration-site-name"
                    value={siteName}
                    onChange={(event) => setSiteName(event.target.value)}
                    data-testid="agent-registration-site-name"
                    placeholder="example-site"
                    required
                  />
                </label>
              </div>

              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
                <div className="grid gap-2 rounded-md border border-border bg-muted/25 p-3 sm:grid-cols-2">
                  <div className="text-sm font-medium">
                    {t("cp.agentRegistration.form.detectedUrls")}
                  </div>
                  <div className="hidden sm:block" />
                  <ReadonlyUrlRow
                    label={t("cp.agentRegistration.form.serverHttpUrl")}
                    value={serverHttpUrl}
                    testId="agent-registration-http-url"
                  />
                  <ReadonlyUrlRow
                    label={t("cp.agentRegistration.form.serverGrpcUrl")}
                    value={serverGrpcUrl}
                    testId="agent-registration-grpc-url"
                  />
                </div>
                <label className="space-y-1 text-sm" htmlFor="agent-registration-scheduler">
                  <span className="text-muted-foreground">
                    {t("cp.agentRegistration.form.scheduler")}
                  </span>
                  <select
                    id="agent-registration-scheduler"
                    value={scheduler}
                    onChange={(event) =>
                      setScheduler(event.target.value as AgentRegistrationScheduler)
                    }
                    data-testid="agent-registration-scheduler"
                    className={selectClassName}
                  >
                    {schedulers.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {context.error ? (
                <div
                  className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
                  data-testid="agent-registration-context-error"
                >
                  {toUserFacingError(context.error, t("cp.agentRegistration.contextLoadFailed"))}
                </div>
              ) : null}

              {createToken.error ? (
                <div
                  className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
                  data-testid="agent-registration-error"
                >
                  {toUserFacingError(
                    createToken.error,
                    t("cp.agentRegistration.form.createFailed"),
                  )}
                </div>
              ) : null}

              <Button
                type="submit"
                disabled={
                  !formValid || context.isLoading || Boolean(context.error) || createToken.isPending
                }
                data-testid="agent-registration-submit"
              >
                <KeyRound className="h-4 w-4" />
                {createToken.isPending
                  ? t("cp.agentRegistration.form.creating")
                  : t("cp.agentRegistration.form.submit")}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("cp.agentRegistration.activeTokens.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            {activeTokens.isLoading ? (
              <div
                className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground"
                data-testid="agent-registration-active-loading"
              >
                {t("cp.agentRegistration.activeTokens.loading")}
              </div>
            ) : activeTokens.error ? (
              <div
                className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
                data-testid="agent-registration-active-error"
              >
                {toUserFacingError(
                  activeTokens.error,
                  t("cp.agentRegistration.activeTokens.loadFailed"),
                )}
              </div>
            ) : persistedActiveTokens.length === 0 ? (
              <div
                className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground"
                data-testid="agent-registration-active-empty"
              >
                {t("cp.agentRegistration.activeTokens.empty")}
              </div>
            ) : (
              <div className="space-y-3">
                {persistedActiveTokens.map((token) => (
                  <ActiveTokenCard
                    key={token.id}
                    token={token}
                    onRevoke={() => revokeActive(token)}
                    revokeDisabled={revokeToken.isPending}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("cp.agentRegistration.tokens.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            {issuedTokens.length === 0 ? (
              <div
                className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground"
                data-testid="agent-registration-empty"
              >
                {t("cp.agentRegistration.tokens.empty")}
              </div>
            ) : (
              <div className="space-y-3">
                {issuedTokens.map((token) => (
                  <div
                    key={token.id}
                    className="rounded-md border border-border p-3"
                    data-testid={`agent-registration-token-${token.id}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-mono text-sm">{token.agentId}</div>
                        <div className="text-xs text-muted-foreground">
                          {token.siteName} · {token.providerOrgId}
                        </div>
                      </div>
                      <Badge variant="default">{new Date(token.expiresAt).toLocaleString()}</Badge>
                    </div>

                    <div className="mt-3 flex gap-2">
                      <Input
                        value={token.token}
                        readOnly
                        className="font-mono text-xs"
                        data-testid={`agent-registration-token-value-${token.id}`}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => copyText(`token:${token.id}`, token.token)}
                        aria-label={t("cp.agentRegistration.tokens.copyToken")}
                        title={t("cp.agentRegistration.tokens.copyToken")}
                      >
                        {copied === `token:${token.id}` ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <Clipboard className="h-4 w-4" />
                        )}
                      </Button>
                    </div>

                    <pre
                      className="mt-3 max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs"
                      data-testid={`agent-registration-command-${token.id}`}
                    >
                      {token.command}
                    </pre>
                    <div className="mt-2 flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => copyText(`command:${token.id}`, token.command)}
                      >
                        {copied === `command:${token.id}` ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <Clipboard className="h-4 w-4" />
                        )}
                        {t("cp.agentRegistration.tokens.copyCommand")}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={revokeToken.isPending}
                        onClick={() => revoke(token)}
                      >
                        <Trash2 className="h-4 w-4" />
                        {t("cp.agentRegistration.tokens.revoke")}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const selectClassName = cn(
  "flex h-9 w-full rounded-md border border-border bg-card px-3 py-1 text-sm shadow-sm",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

function ActiveTokenCard({
  token,
  onRevoke,
  revokeDisabled,
}: {
  token: ActiveAgentRegistrationToken;
  onRevoke: () => void;
  revokeDisabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="rounded-md border border-border p-3"
      data-testid={`agent-registration-active-token-${token.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-mono text-sm">{token.agentId}</div>
          <div className="text-xs text-muted-foreground">
            {token.siteName} · {token.providerOrgId}
          </div>
        </div>
        <Badge variant="default">{new Date(token.expiresAt).toLocaleString()}</Badge>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {t("cp.agentRegistration.activeTokens.createdAt")}:{" "}
        {new Date(token.createdAt).toLocaleString()}
      </div>
      <div className="mt-2 flex justify-end">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          data-testid={`agent-registration-active-revoke-${token.id}`}
          disabled={revokeDisabled}
          onClick={onRevoke}
        >
          <Trash2 className="h-4 w-4" />
          {t("cp.agentRegistration.tokens.revoke")}
        </Button>
      </div>
    </div>
  );
}

function ReadonlyUrlRow({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div className="grid gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <code
        className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        data-testid={testId}
      >
        {value}
      </code>
    </div>
  );
}

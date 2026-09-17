import type { TerminalSession } from "@kuintessence/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { listSandboxAccountMappings } from "../../lib/sandbox-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import type { AgentRow } from "../agents/AgentCard";
import { Button } from "../ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";

export interface NewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (session: TerminalSession) => void;
}

export function NewSessionDialog({ open, onOpenChange, onCreated }: NewSessionDialogProps) {
  const { t } = useTranslation();
  const [agentId, setAgentId] = useState<string>("");
  const [mappingId, setMappingId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const agentsQ = useQuery({
    queryKey: ["agents-list"],
    queryFn: () => api.get<{ agents: AgentRow[] }>("/agents"),
    enabled: open,
    staleTime: 30_000,
  });
  const mappingsQ = useQuery({
    queryKey: ["sandbox-account-mappings"],
    queryFn: listSandboxAccountMappings,
    enabled: open,
    staleTime: 30_000,
  });

  const agentsLoadError = agentsQ.error as Error | null;
  const onlineAgents = (agentsLoadError ? [] : (agentsQ.data?.agents ?? [])).filter(
    (a) => a.status.toLowerCase() === "online",
  );
  const selectedAgent = onlineAgents.find((a) => a.agentId === agentId) ?? onlineAgents[0];
  const approvedMappings = (mappingsQ.data ?? []).filter(({ account, mapping }) => {
    const unexpired = !mapping.expiresAt || new Date(mapping.expiresAt).getTime() > Date.now();
    return (
      mapping.status === "approved" &&
      unexpired &&
      account.enabled &&
      account.backendType === "unix" &&
      account.agentId === selectedAgent?.agentId &&
      Boolean(account.username)
    );
  });
  const selectedMapping =
    approvedMappings.find(({ mapping }) => mapping.id === mappingId) ??
    approvedMappings.find(({ mapping }) => mapping.isDefault) ??
    approvedMappings[0];

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (agentsLoadError) {
      toast.error(toUserFacingError(agentsLoadError, t("terminal.agentsLoadFailed")));
      return;
    }
    if (!selectedAgent) {
      toast.error(t("terminal.noOnlineAgent"));
      return;
    }
    if (mappingsQ.error instanceof Error) {
      toast.error(toUserFacingError(mappingsQ.error, t("terminal.accountMappingsLoadFailed")));
      return;
    }
    if (!selectedMapping?.account.username) {
      toast.error(t("terminal.accountMappingRequired"));
      return;
    }
    setBusy(true);
    try {
      const session = await api.post<TerminalSession>("/terminal/sessions", {
        siteId: selectedAgent.siteName,
        agentId: selectedAgent.agentId,
        remoteUser: selectedMapping.account.username,
        authMethod: "key",
      });
      onCreated(session);
      onOpenChange(false);
    } catch (err) {
      toast.error(toUserFacingError(err, t("terminal.openFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="terminal-new-session">
        <SheetHeader>
          <SheetTitle>{t("terminal.newSessionTitle")}</SheetTitle>
          <SheetDescription>{t("terminal.newSessionDescription")}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="terminal-new-session-form"
            onSubmit={onSubmit}
            className="space-y-4"
            data-testid="terminal-new-session-form"
          >
            <div className="space-y-1.5">
              <label
                htmlFor="terminal-agent"
                className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                {t("terminal.agentLabel")}
              </label>
              {agentsQ.isLoading ? (
                <div className="text-sm text-muted-foreground">{t("terminal.loadingAgents")}</div>
              ) : agentsLoadError ? (
                <div
                  className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-xs text-status-failed"
                  data-testid="terminal-agents-error"
                >
                  {toUserFacingError(agentsLoadError, t("terminal.agentsLoadFailed"))}
                </div>
              ) : onlineAgents.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                  {t("terminal.noOnlineAgentHint")}{" "}
                  <code className="font-mono">
                    SERVER_GRPC_URL=… AGENT_ID=… AGENT_SITE_NAME=… bun packages/agent/src/index.ts
                  </code>
                </div>
              ) : (
                <select
                  id="terminal-agent"
                  data-testid="terminal-agent-select"
                  className="flex h-9 w-full rounded-md border border-border bg-card px-3 text-sm font-mono"
                  value={selectedAgent?.agentId ?? ""}
                  onChange={(e) => {
                    setAgentId(e.target.value);
                    setMappingId("");
                  }}
                >
                  {onlineAgents.map((a) => (
                    <option key={a.agentId} value={a.agentId}>
                      {a.siteName} · {a.schedulerType} {a.schedulerVersion}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="terminal-user"
                className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                {t("terminal.accountMapping")}
              </label>
              {mappingsQ.isLoading ? (
                <div className="text-sm text-muted-foreground">
                  {t("terminal.loadingAccountMappings")}
                </div>
              ) : mappingsQ.error instanceof Error ? (
                <div className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-xs text-status-failed">
                  {toUserFacingError(mappingsQ.error, t("terminal.accountMappingsLoadFailed"))}
                </div>
              ) : approvedMappings.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                  <p>{t("terminal.noApprovedAccountMapping")}</p>
                  <Button asChild variant="link" size="sm" className="h-auto px-0 py-1">
                    <a href="/settings">{t("terminal.manageAccountMappings")}</a>
                  </Button>
                </div>
              ) : (
                <select
                  id="terminal-user"
                  value={selectedMapping?.mapping.id ?? ""}
                  onChange={(event) => setMappingId(event.target.value)}
                  className="flex h-9 w-full rounded-md border border-border bg-card px-3 text-sm"
                  data-testid="terminal-user-select"
                >
                  {approvedMappings.map(({ account, mapping }) => (
                    <option key={mapping.id} value={mapping.id}>
                      {account.displayName} · {account.username}
                      {account.schedulerAccount ? ` · ${account.schedulerAccount}` : ""}
                    </option>
                  ))}
                </select>
              )}
              <p className="text-[11px] text-muted-foreground">
                {t("terminal.accountMappingHint")}
              </p>
            </div>

            <div
              className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
              data-testid="terminal-ssh-handoff"
            >
              <p>{t("terminal.sshHandoff")}</p>
              <Button asChild variant="link" size="sm" className="h-auto px-0 py-1">
                <a href="/agents">
                  {t("terminal.liveSsh")}
                  <ArrowRight />
                </a>
              </Button>
            </div>
          </form>
        </SheetBody>
        <SheetFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="terminal-new-session-form"
            disabled={
              busy ||
              Boolean(agentsLoadError) ||
              Boolean(mappingsQ.error) ||
              onlineAgents.length === 0 ||
              !selectedMapping
            }
            data-testid="terminal-open-submit"
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("terminal.openShell")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

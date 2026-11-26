import type { TerminalSession } from "@kuintessence/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { listSandboxAccountMappings } from "../../lib/sandbox-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import type { AgentRow } from "../agents/AgentCard";
import { Button } from "../ui/button";
import { ResourceSelectField } from "../ui/resource-select-field";
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const agentsQ = useQuery({
    queryKey: ["agents-list"],
    queryFn: () => api.get<{ agents: AgentRow[] }>("/agents"),
    enabled: open,
    staleTime: 30_000,
  });
  const agentsLoadError = agentsQ.error as Error | null;
  const onlineAgents = (agentsLoadError ? [] : (agentsQ.data?.agents ?? [])).filter(
    (a) => a.status.toLowerCase() === "online",
  );
  const selectedAgent = onlineAgents.find((a) => a.agentId === agentId) ?? onlineAgents[0];
  const mappingsQ = useQuery({
    queryKey: ["sandbox-account-mappings"],
    queryFn: listSandboxAccountMappings,
    enabled: open && Boolean(selectedAgent),
    staleTime: 30_000,
  });

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
    if (busy || !selectedAgent || mappingsQ.isError || !selectedMapping?.account.username) return;
    setError(null);
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
      setError(toUserFacingError(err, t("terminal.openFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setError(null);
          onOpenChange(next);
        }
      }}
    >
      <SheetContent dismissible={!busy} data-testid="terminal-new-session">
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
                <div className="space-y-2 text-sm" data-testid="terminal-agents-error">
                  <p role="alert" className="text-status-failed">
                    {toUserFacingError(agentsLoadError, t("terminal.agentsLoadFailed"))}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={agentsQ.isFetching}
                    onClick={() => void agentsQ.refetch()}
                  >
                    {t("common.retry")}
                  </Button>
                </div>
              ) : onlineAgents.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("terminal.noOnlineAgent")}</p>
              ) : (
                <ResourceSelectField
                  resourceType="agents"
                  recent
                  expandable
                  disabled={busy}
                  id="terminal-agent"
                  data-testid="terminal-agent-select"
                  className="flex w-full font-mono"
                  value={selectedAgent?.agentId ?? ""}
                  onChange={(e) => {
                    setError(null);
                    setAgentId(e.target.value);
                    setMappingId("");
                  }}
                >
                  {onlineAgents.map((a) => (
                    <option key={a.agentId} value={a.agentId}>
                      {a.siteName} · {a.schedulerType} {a.schedulerVersion}
                    </option>
                  ))}
                </ResourceSelectField>
              )}
            </div>

            {selectedAgent ? (
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
                  <div className="space-y-2 text-sm" data-testid="terminal-mapping-error">
                    <p role="alert" className="text-status-failed">
                      {toUserFacingError(mappingsQ.error, t("terminal.accountMappingsLoadFailed"))}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={mappingsQ.isFetching}
                      onClick={() => void mappingsQ.refetch()}
                    >
                      {t("common.retry")}
                    </Button>
                  </div>
                ) : approvedMappings.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    <p>{t("terminal.noApprovedAccountMapping")}</p>
                    <Button asChild variant="link" size="sm" className="h-auto px-0 py-1">
                      <a href="/settings">{t("terminal.manageAccountMappings")}</a>
                    </Button>
                  </div>
                ) : (
                  <ResourceSelectField
                    resourceType="execution-account-mappings"
                    recent
                    expandable
                    disabled={busy}
                    id="terminal-user"
                    value={selectedMapping?.mapping.id ?? ""}
                    onChange={(event) => {
                      setError(null);
                      setMappingId(event.target.value);
                    }}
                    className="flex w-full"
                    data-testid="terminal-user-select"
                  >
                    {approvedMappings.map(({ account, mapping }) => (
                      <option key={mapping.id} value={mapping.id}>
                        {account.displayName} · {account.username}
                        {account.schedulerAccount ? ` · ${account.schedulerAccount}` : ""}
                      </option>
                    ))}
                  </ResourceSelectField>
                )}
                {selectedMapping && !mappingsQ.isError ? (
                  <p className="text-xs text-muted-foreground">
                    {t("terminal.accountMappingHint")}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div
              className="border-t border-border pt-3 text-xs text-muted-foreground"
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
        {error ? (
          <p
            role="alert"
            className="border-t border-border px-4 py-2 text-sm text-status-failed sm:px-5"
            data-testid="terminal-create-error"
          >
            {error}
          </p>
        ) : null}
        <SheetFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setError(null);
              onOpenChange(false);
            }}
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
            {t(busy ? "terminal.creating" : "terminal.openShell")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

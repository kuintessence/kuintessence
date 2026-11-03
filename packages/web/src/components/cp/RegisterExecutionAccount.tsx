import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createSandboxExecutionAccount,
  listSandboxAgentSecurityViews,
} from "../../lib/sandbox-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

export function RegisterExecutionAccount({
  providerOrgId,
  onClose,
  onSaved,
}: {
  providerOrgId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["sandbox-account-agents", providerOrgId],
    queryFn: listSandboxAgentSecurityViews,
  });
  const agents = (query.data ?? []).filter((agent) => agent.providerOrgId === providerOrgId);
  const agent = agents.find((item) => item.agentId === agentId);
  const kubernetes = agent?.schedulerType === "kubernetes";
  const identityFields = kubernetes
    ? ["namespace", "serviceAccount"]
    : ["username", "uid", "gid", "schedulerAccount", "allowedQueues"];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent aria-describedby={`${id}-note`} dirty outsideDismissPolicy="never">
        <DialogHeader>
          <DialogTitle>{t("cp.accounts.register")}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4 overflow-y-auto p-5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!agent || query.error || busy) return;
            const form = new FormData(event.currentTarget);
            const value = (name: string) => String(form.get(name) ?? "").trim();
            const displayName = value("displayName");
            if (
              !displayName ||
              (kubernetes ? !value("namespace") || !value("serviceAccount") : !value("username"))
            ) {
              setError(t("cp.accounts.registration.required"));
              return;
            }
            const uid = Number(value("uid")),
              gid = Number(value("gid"));
            if (
              !kubernetes &&
              ![uid, gid].every(
                (value) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647,
              )
            ) {
              setError(t("cp.accounts.registration.invalidIdentity"));
              return;
            }
            setBusy(true);
            setError("");
            try {
              await createSandboxExecutionAccount({
                providerOrgId,
                agentId: agent.agentId,
                displayName,
                sharedService: form.get("sharedService") === "on",
                ...(kubernetes
                  ? {
                      backendType: "kubernetes",
                      namespace: value("namespace"),
                      serviceAccount: value("serviceAccount"),
                    }
                  : {
                      backendType: "unix",
                      username: value("username"),
                      uid,
                      gid,
                      ...(value("schedulerAccount")
                        ? { schedulerAccount: value("schedulerAccount") }
                        : {}),
                      allowedQueues: [
                        ...new Set(
                          value("allowedQueues")
                            .split(",")
                            .map((name) => name.trim())
                            .filter(Boolean),
                        ),
                      ],
                    }),
              });
              await onSaved();
            } catch (error) {
              setError(toUserFacingError(error, t("cp.accounts.registration.failed")));
            } finally {
              setBusy(false);
            }
          }}
        >
          <p id={`${id}-note`} className="text-sm text-muted-foreground">
            {t("cp.accounts.registration.note")}
          </p>
          {query.error ? (
            <div role="alert" className="space-y-2 text-sm">
              <p>{toUserFacingError(query.error, t("cp.accounts.registration.agentsFailed"))}</p>
              <Button type="button" variant="outline" onClick={() => void query.refetch()}>
                {t("cp.common.retry")}
              </Button>
            </div>
          ) : query.isPending ? (
            <p role="status">{t("cp.common.loading")}</p>
          ) : agents.length === 0 ? (
            <p>{t("cp.accounts.registration.noAgents")}</p>
          ) : null}
          <fieldset disabled={busy || query.isPending || !!query.error} className="space-y-4">
            <div className="grid gap-1.5 text-sm">
              <label htmlFor={`${id}-agent`}>{t("cp.accounts.registration.agent")}</label>
              <select
                id={`${id}-agent`}
                required
                value={agentId}
                onChange={(event) => {
                  setAgentId(event.target.value);
                  setError("");
                }}
                className="h-9 w-full rounded-md border border-input bg-background px-3"
              >
                <option value="">{t("cp.accounts.registration.selectAgent")}</option>
                {agents.map((agent) => (
                  <option key={agent.agentId} value={agent.agentId}>
                    {agent.siteName} · {agent.agentId} ({agent.schedulerType})
                  </option>
                ))}
              </select>
            </div>
            <label className="grid gap-1.5 text-sm" htmlFor={`${id}-name`}>
              {t("cp.accounts.registration.displayName")}
              <Input id={`${id}-name`} name="displayName" required maxLength={255} />
            </label>
            {agent && (
              <div key={agentId} className="grid gap-4 sm:grid-cols-2">
                {identityFields.map((name) => (
                  <label key={name} htmlFor={`${id}-${name}`} className="grid gap-1.5 text-sm">
                    {t(`cp.accounts.registration.${name}`)}
                    <Input
                      id={`${id}-${name}`}
                      name={name}
                      aria-describedby={name === "allowedQueues" ? `${id}-queues-hint` : undefined}
                      required={name !== "schedulerAccount" && name !== "allowedQueues"}
                      type={name === "uid" || name === "gid" ? "number" : "text"}
                      {...(name === "uid" || name === "gid"
                        ? { min: 1, max: 2147483647, step: 1 }
                        : { maxLength: name === "allowedQueues" ? 4096 : 255 })}
                      {...(name === "namespace" || name === "serviceAccount"
                        ? { pattern: "[a-z0-9]([-a-z0-9]*[a-z0-9])?" }
                        : {})}
                    />
                  </label>
                ))}
              </div>
            )}
            {agent && !kubernetes && (
              <p id={`${id}-queues-hint`} className="text-sm text-muted-foreground">
                {t("cp.accounts.registration.emptyQueuesHint")}
              </p>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="sharedService" />
              {t("cp.accounts.registration.sharedService")}
            </label>
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t("cp.common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !agent || !!query.error}>
              {t(busy ? "cp.common.saving" : "cp.common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

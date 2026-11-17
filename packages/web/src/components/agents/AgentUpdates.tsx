import { AgentUpdateListSchema } from "@kuintessence/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function AgentUpdates({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const id = useId();
  const auth = getAuthState();
  const role = auth.role;
  const platform = ["operator", "platform_admin", "super_admin"].includes(role ?? "");
  const canManage = platform || role === "org_admin";
  const [release, setRelease] = useState("");
  const [message, setMessage] = useState("");
  const client = useQueryClient();
  const key = ["agent-updates", agentId, auth.revision];
  const query = useQuery({
    queryKey: key,
    queryFn: async () =>
      AgentUpdateListSchema.parse(
        await api.get<unknown>(`/agents/${encodeURIComponent(agentId)}/updates`),
      ),
    refetchInterval: 10_000,
  });
  const mutation = useMutation({
    mutationFn: (kind: "notice" | "update") =>
      api.post(`/agents/${encodeURIComponent(agentId)}/updates`, {
        requestId: crypto.randomUUID(),
        kind,
        release,
        message,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  const data = query.error ? undefined : query.data;
  return (
    <details className="pt-2" data-testid={`agent-updates-${agentId}`}>
      <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {t("agents.updater.title")}
        {data?.requests.some((entry) => entry.kind === "notice")
          ? ` · ${t("agents.updater.notice")}`
          : ""}
      </summary>
      {query.isLoading ? <p role="status">{t("agents.updater.loading")}</p> : null}
      {query.error ? (
        <p role="alert">{toUserFacingError(query.error, t("agents.updater.loadFailed"))}</p>
      ) : null}
      {data ? (
        <div className="space-y-3 pt-3">
          {!data.supported ? (
            <p className="text-xs text-muted-foreground">{t("agents.updater.unsupported")}</p>
          ) : null}
          {data.requests.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("agents.updater.empty")}</p>
          ) : null}
          <ul className="space-y-2 text-sm" aria-label={t("agents.updater.history")}>
            {data.requests.map((entry) => (
              <li key={entry.requestId} className="min-w-0">
                <p>
                  {t(
                    entry.kind === "notice"
                      ? "agents.updater.notice"
                      : `agents.updater.states.${entry.state}`,
                  )}
                </p>
                {entry.message ? (
                  <p className="break-words text-muted-foreground">{entry.message}</p>
                ) : null}
                <p className="break-all font-mono text-xs" title={entry.release}>
                  {entry.release.slice(0, 12)}
                </p>
                {canManage && entry.kind === "notice" ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() => setRelease(entry.release)}
                  >
                    {t("agents.updater.useRelease")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {canManage ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                mutation.mutate("update");
              }}
            >
              <label htmlFor={`${id}-release`} className="text-sm">
                {t("agents.updater.release")}
              </label>
              <Input
                id={`${id}-release`}
                value={release}
                required
                pattern="[a-f0-9]{64}"
                maxLength={64}
                className="font-mono"
                onChange={(event) => setRelease(event.target.value.trim())}
              />
              <label htmlFor={`${id}-message`} className="text-sm">
                {t("agents.updater.message")}
              </label>
              <textarea
                id={`${id}-message`}
                className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                maxLength={500}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("agents.updater.safety")}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={mutation.isPending || !/^[a-f0-9]{64}$/.test(release)}
                >
                  {t("agents.updater.request")}
                </Button>
                {platform ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={mutation.isPending || !/^[a-f0-9]{64}$/.test(release)}
                    onClick={() => mutation.mutate("notice")}
                  >
                    {t("agents.updater.notify")}
                  </Button>
                ) : null}
              </div>
              {mutation.isPending ? <p role="status">{t("agents.updater.sending")}</p> : null}
              {mutation.isSuccess ? <p role="status">{t("agents.updater.sent")}</p> : null}
              {mutation.error ? (
                <p role="alert">{toUserFacingError(mutation.error, t("agents.updater.failed"))}</p>
              ) : null}
            </form>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

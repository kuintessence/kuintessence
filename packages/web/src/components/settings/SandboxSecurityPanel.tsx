import type { EffectiveSandboxPolicy, SandboxPolicyOverlay } from "@kuintessence/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getEffectiveSandboxPolicy,
  listSandboxAgentSecurityViews,
  listSandboxPolicyOverlays,
  updatePlatformSandboxPolicy,
} from "../../lib/sandbox-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

interface AgentEffectivePolicy {
  agentId: string;
  policy: EffectiveSandboxPolicy;
}

export function SandboxSecurityPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [policy, setPolicy] = useState({
    sandboxEnabled: true,
    impersonationEnabled: false,
    degradedImpersonationAllowed: false,
    sharedServiceAllowed: false,
    runtimePrecacheRequired: false,
  });
  const overlaysQuery = useQuery({
    queryKey: ["sandbox-policy-overlays"],
    queryFn: listSandboxPolicyOverlays,
    retry: false,
  });
  const agentsQuery = useQuery({
    queryKey: ["sandbox-security-agents"],
    queryFn: listSandboxAgentSecurityViews,
    refetchInterval: 15_000,
    retry: false,
  });
  const effectiveQuery = useQuery({
    queryKey: ["sandbox-effective-policies", agentsQuery.data?.map((agent) => agent.agentId)],
    enabled: agentsQuery.isSuccess,
    queryFn: async (): Promise<AgentEffectivePolicy[]> =>
      Promise.all(
        (agentsQuery.data ?? []).map(async (agent) => ({
          agentId: agent.agentId,
          policy: await getEffectiveSandboxPolicy(agent.agentId),
        })),
      ),
    refetchInterval: 15_000,
    retry: false,
  });
  const platformOverlay = overlaysQuery.data?.find((row) => row.scope === "platform")?.policy;

  useEffect(() => {
    if (!platformOverlay) return;
    setPolicy({
      sandboxEnabled: platformOverlay.sandboxEnabled ?? true,
      impersonationEnabled: platformOverlay.impersonationEnabled ?? false,
      degradedImpersonationAllowed: platformOverlay.degradedImpersonationAllowed ?? false,
      sharedServiceAllowed: platformOverlay.sharedServiceAllowed ?? false,
      runtimePrecacheRequired: platformOverlay.runtimePrecacheRequired ?? false,
    });
  }, [platformOverlay]);

  const saveMutation = useMutation({
    mutationFn: () =>
      updatePlatformSandboxPolicy({
        ...(platformOverlay ?? {}),
        ...policy,
      } satisfies SandboxPolicyOverlay),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sandbox-policy-overlays"] });
      void queryClient.invalidateQueries({ queryKey: ["sandbox-effective-policies"] });
      toast.success(t("sandbox.security.saved"));
    },
    onError: (error) => toast.error(toUserFacingError(error, t("sandbox.security.saveFailed"))),
  });
  const effectiveByAgent = new Map(
    (effectiveQuery.data ?? []).map((row) => [row.agentId, row.policy]),
  );
  const agents = agentsQuery.data ?? [];

  return (
    <Card data-testid="sandbox-security-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" />
          {t("sandbox.security.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <p className="text-xs leading-5 text-muted-foreground">{t("sandbox.security.subtitle")}</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <PolicyToggle
            checked={policy.sandboxEnabled}
            label={t("sandbox.security.sandboxEnabled")}
            onChange={(checked) =>
              setPolicy((current) => ({ ...current, sandboxEnabled: checked }))
            }
          />
          <PolicyToggle
            checked={policy.impersonationEnabled}
            label={t("sandbox.security.impersonation")}
            onChange={(checked) =>
              setPolicy((current) => ({ ...current, impersonationEnabled: checked }))
            }
          />
          <PolicyToggle
            checked={policy.degradedImpersonationAllowed}
            label={t("sandbox.security.degraded")}
            onChange={(checked) =>
              setPolicy((current) => ({ ...current, degradedImpersonationAllowed: checked }))
            }
          />
          <PolicyToggle
            checked={policy.sharedServiceAllowed}
            label={t("sandbox.security.shared")}
            onChange={(checked) =>
              setPolicy((current) => ({ ...current, sharedServiceAllowed: checked }))
            }
          />
          <PolicyToggle
            checked={policy.runtimePrecacheRequired}
            label={t("sandbox.security.precache")}
            onChange={(checked) =>
              setPolicy((current) => ({ ...current, runtimePrecacheRequired: checked }))
            }
          />
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || overlaysQuery.isLoading || overlaysQuery.isError}
          >
            {t("sandbox.security.saveUpperBound")}
          </Button>
        </div>
        {overlaysQuery.error instanceof Error ||
        agentsQuery.error instanceof Error ||
        effectiveQuery.error instanceof Error ? (
          <div className="text-sm text-[var(--status-failed)]">
            {toUserFacingError(
              overlaysQuery.error ?? agentsQuery.error ?? effectiveQuery.error,
              t("sandbox.security.loadFailed"),
            )}
          </div>
        ) : overlaysQuery.isLoading || agentsQuery.isLoading || effectiveQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
        ) : agents.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            {t("sandbox.security.empty")}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[880px] text-left text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t("sandbox.security.table.agent")}</th>
                  <th className="px-3 py-2 font-medium">{t("sandbox.security.table.scheduler")}</th>
                  <th className="px-3 py-2 font-medium">{t("sandbox.security.table.root")}</th>
                  <th className="px-3 py-2 font-medium">{t("sandbox.security.table.readiness")}</th>
                  <th className="px-3 py-2 font-medium">
                    {t("sandbox.security.table.impersonation")}
                  </th>
                  <th className="px-3 py-2 font-medium">{t("sandbox.security.table.shared")}</th>
                  <th className="px-3 py-2 font-medium">{t("sandbox.security.table.limits")}</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => {
                  const effective = effectiveByAgent.get(agent.agentId);
                  return (
                    <tr key={agent.agentId} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="font-medium">{agent.siteName}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {agent.agentId}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono">{agent.schedulerType}</td>
                      <td className="px-3 py-2">
                        <Fact enabled={agent.rootMode} />
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          variant={
                            agent.sandboxReadiness === "ready"
                              ? "succeeded"
                              : agent.sandboxReadiness === "degraded"
                                ? "pending"
                                : "failed"
                          }
                        >
                          {t(`sandbox.security.readiness.${agent.sandboxReadiness}`)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <Fact enabled={effective?.impersonationEnabled ?? false} />
                      </td>
                      <td className="px-3 py-2">
                        <Fact enabled={effective?.sharedServiceAllowed ?? false} />
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
                        {effective
                          ? `${effective.limits.maxCpuCores} CPU · ${effective.limits.maxMemoryMb} MiB · ${effective.limits.maxWallTimeSec}s`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PolicyToggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-border bg-background p-3 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function Fact({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  return enabled ? (
    <ShieldCheck
      className="h-4 w-4 text-[var(--status-succeeded)]"
      aria-label={t("common.enabled")}
    />
  ) : (
    <ShieldAlert
      className="h-4 w-4 text-[var(--status-failed)]"
      aria-label={t("common.disabled")}
    />
  );
}

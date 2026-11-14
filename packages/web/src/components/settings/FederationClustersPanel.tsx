import {
  type FederationAgreementApproval,
  FederationAgreementApprovalSchema,
  type FederationClusterQueueConfig,
  FederationClusterQueueConfigSchema,
  type FederationClusterQueueView,
  FederationClusterQueueViewSchema,
} from "@kuintessence/shared/federation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { api } from "../../lib/api-client";
import { federationReadFailed } from "../../lib/federation-query-state";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { toUserFacingError } from "../../lib/user-facing-error";
import {
  FederationEmpty,
  FederationLoadError,
  FederationSectionTitle,
  useFederationAuthRevision,
} from "../federation/FederationLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { FederationClusterProfiles } from "./FederationClusterProfiles";

const root = "/admin/federation/clusters";
const empty = (orgId: string): FederationClusterQueueConfig => ({
  localOrgId: orgId,
  name: "",
  clusterName: "",
  queueName: "",
  schedulerType: "slurm",
  agreementRevisionId: "",
  executionTarget: { providerOrgId: "", clusterId: "", agentId: "", queueId: "" },
  allowAllMembers: true,
  allowedUserIds: [],
  showPartnerLabel: true,
  enabled: true,
  profiles: [],
});

export function FederationClustersPanel() {
  const orgId = useActiveOrganizationId();
  const authRevision = useFederationAuthRevision();
  const { t } = useTranslation();
  if (!orgId) return <FederationEmpty>{t("federation.selectOrganization")}</FederationEmpty>;
  return (
    <ClusterQueues key={`${orgId}:${authRevision}`} orgId={orgId} authRevision={authRevision} />
  );
}

function ClusterQueues({ orgId, authRevision }: { orgId: string; authRevision: string | null }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [editing, setEditing] = useState<FederationClusterQueueView | "new" | null>(null);
  const key = ["federation", "cluster-queues", orgId, authRevision];
  const list = useQuery({
    queryKey: key,
    queryFn: async () =>
      z
        .object({ data: z.array(FederationClusterQueueViewSchema) })
        .parse(await api.get<unknown>(root, { organizationId: orgId, authRevision })).data,
  });
  if (editing)
    return (
      <ClusterQueueForm
        orgId={orgId}
        authRevision={authRevision}
        initial={editing === "new" ? undefined : editing}
        onBack={() => setEditing(null)}
        onSaved={async () => {
          await client.invalidateQueries({ queryKey: key });
          await client.invalidateQueries({ queryKey: ["queues"] });
          await client.invalidateQueries({ queryKey: ["queues-visible"] });
          setEditing(null);
        }}
      />
    );
  return (
    <Card data-testid="federation-clusters-panel">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <FederationSectionTitle title={t("federation.clusters.title")} />
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          {t("federation.clusters.add")}
        </Button>
      </CardHeader>
      <CardContent>
        {federationReadFailed(list) ? (
          <FederationLoadError onRetry={() => void list.refetch()} />
        ) : list.isPending ? (
          <p role="status">{t("common.loading")}</p>
        ) : !list.data?.length ? (
          <FederationEmpty>{t("federation.clusters.empty")}</FederationEmpty>
        ) : (
          <div className="divide-y">
            {list.data.map((row) => (
              <button
                type="button"
                key={row.id}
                onClick={() => setEditing(row)}
                className="flex w-full flex-wrap items-center justify-between gap-3 rounded-md px-2 py-4 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0">
                  <span className="block break-words font-medium">{row.config.clusterName}</span>
                  <span className="text-sm text-muted-foreground">
                    {row.partnerName} · {row.config.queueName}
                  </span>
                </span>
                <Badge variant={row.config.enabled ? "succeeded" : "outline"}>
                  {t(row.config.enabled ? "common.enabled" : "common.disabled")}
                </Badge>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ClusterQueueForm({
  orgId,
  authRevision,
  initial,
  onBack,
  onSaved,
}: {
  orgId: string;
  authRevision: string | null;
  initial?: FederationClusterQueueView;
  onBack: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initial?.config ?? empty(orgId));
  const [error, setError] = useState<string | null>(null);
  const blocked = useMobileMutationBlocked(root);
  const [memberSearch, setMemberSearch] = useState("");
  const deferredMemberSearch = useDeferredValue(memberSearch);
  const scope = { organizationId: orgId, authRevision };
  const agreements = useQuery({
    queryKey: ["federation", "cluster-agreements", orgId, authRevision],
    queryFn: async () => {
      const response = z
        .object({ success: z.boolean(), data: z.array(FederationAgreementApprovalSchema) })
        .parse(await api.get<unknown>("/federation/agreements?limit=100", scope));
      return response.data.filter(
        (item) =>
          item.state === "active" &&
          item.counterpartyApprovalJws &&
          item.terms.executionTargets?.length,
      );
    },
  });
  const materials = useQuery({
    queryKey: ["federation", "cluster-materials", orgId, authRevision],
    queryFn: async () => {
      const result = z
        .object({
          data: z.object({
            data: z.array(
              z.object({ originSiteId: z.uuid(), digest: z.string(), kind: z.string() }),
            ),
          }),
        })
        .parse(await api.get<unknown>("/federation/assets/materials?limit=100", scope));
      return result.data.data;
    },
  });
  const members = useQuery({
    queryKey: ["federation", "cluster-members", orgId, authRevision, deferredMemberSearch],
    queryFn: async () =>
      z
        .object({
          data: z.array(
            z.object({ userId: z.uuid(), email: z.string(), displayName: z.string().nullable() }),
          ),
          hasMore: z.boolean(),
        })
        .parse(
          await api.get<unknown>(
            `/admin/federation/capabilities/members?orgId=${orgId}&limit=100&search=${encodeURIComponent(deferredMemberSearch)}`,
            scope,
          ),
        ),
  });
  const agreement = agreements.data?.find((a) => a.revisionId === draft.agreementRevisionId);
  const patch = <K extends keyof FederationClusterQueueConfig>(
    field: K,
    value: FederationClusterQueueConfig[K],
  ) => setDraft((current) => ({ ...current, [field]: value }));
  const save = useMutation({
    mutationFn: async () => {
      const config = FederationClusterQueueConfigSchema.parse({
        ...draft,
        profiles: draft.profiles,
      });
      return initial
        ? api.put(`${root}/${initial.id}`, config, scope)
        : api.post(root, config, scope);
    },
    onSuccess: async () => {
      toast.success(t("common.saved"));
      await onSaved();
    },
    onError: (cause: unknown) => {
      setError(
        cause instanceof z.ZodError
          ? cause.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n")
          : cause instanceof SyntaxError
            ? t("federation.clusters.invalidJson")
            : toUserFacingError(cause, t("federation.submitFailed")),
      );
    },
  });
  const disable = useMutation({
    mutationFn: () => api.delete(`${root}/${initial?.id}`, scope),
    onSuccess: onSaved,
    onError: (cause: unknown) => setError(toUserFacingError(cause, t("federation.submitFailed"))),
  });
  function chooseAgreement(value: string) {
    const selected = agreements.data?.find((a) => a.revisionId === value);
    setDraft((current) => ({
      ...current,
      agreementRevisionId: value,
      profiles: [],
      executionTarget: selected?.terms.executionTargets?.[0] ?? empty(orgId).executionTarget,
    }));
  }
  return (
    <Card data-testid="federation-cluster-form">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <FederationSectionTitle
          title={initial ? draft.clusterName : t("federation.clusters.add")}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={onBack}
          disabled={save.isPending || disable.isPending}
        >
          <ArrowLeft className="size-4" />
          {t("common.back")}
        </Button>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          <fieldset
            disabled={blocked || save.isPending || disable.isPending}
            className="space-y-6 disabled:opacity-60"
          >
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1.5 text-sm font-medium">
                {t("federation.clusters.clusterName")}
                <Input
                  value={draft.clusterName}
                  onChange={(event) => {
                    patch("clusterName", event.target.value);
                    patch("name", event.target.value);
                  }}
                  required
                />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                {t("federation.clusters.agreement")}
                <NativeSelect
                  className="w-full"
                  value={draft.agreementRevisionId}
                  onChange={(event) => chooseAgreement(event.target.value)}
                  required
                >
                  <option value="">{t("common.select")}</option>
                  {agreements.data?.map((a: FederationAgreementApproval) => (
                    <option key={a.revisionId} value={a.revisionId}>
                      {a.targetName ?? a.terms.targetSiteId} ·{" "}
                      {t(`federation.agreements.modes.${a.terms.mode}`)} · {a.terms.unit}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                {t("federation.clusters.executionQueue")}
                <NativeSelect
                  className="w-full"
                  value={JSON.stringify(draft.executionTarget)}
                  onChange={(event) => {
                    const target = agreement?.terms.executionTargets?.find(
                      (v) => JSON.stringify(v) === event.target.value,
                    );
                    if (target) patch("executionTarget", target);
                  }}
                  required
                >
                  <option value="">{t("common.select")}</option>
                  {agreement?.terms.executionTargets?.map((target) => (
                    <option key={JSON.stringify(target)} value={JSON.stringify(target)}>
                      {target.clusterId} · {target.queueId}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                {t("federation.clusters.queueName")}
                <Input
                  value={draft.queueName}
                  onChange={(event) => patch("queueName", event.target.value)}
                  required
                />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                {t("federation.clusters.scheduler")}
                <NativeSelect
                  className="w-full"
                  value={draft.schedulerType}
                  onChange={(event) =>
                    patch(
                      "schedulerType",
                      event.target.value as FederationClusterQueueConfig["schedulerType"],
                    )
                  }
                >
                  {["slurm", "pbs-pro", "torque", "kubernetes"].map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            </div>
            {agreement ? (
              <dl className="grid gap-4 border-y py-4 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">{t("federation.clusters.budget")}</dt>
                  <dd className="mt-1 tabular-nums">
                    {agreement.terms.budgetLimit} {agreement.terms.unit}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("federation.clusters.taskLimit")}</dt>
                  <dd className="mt-1 tabular-nums">
                    {agreement.terms.maxTaskAmount} {agreement.terms.unit}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("federation.clusters.concurrency")}</dt>
                  <dd className="mt-1 tabular-nums">{agreement.terms.maxReservations}</dd>
                </div>
              </dl>
            ) : null}
            <fieldset className="space-y-3">
              <legend className="mb-3 text-sm font-medium">
                {t("federation.clusters.members")}
              </legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.allowAllMembers}
                  onChange={(event) => patch("allowAllMembers", event.target.checked)}
                />
                {t("federation.clusters.allMembers")}
              </label>
              <Input
                aria-label={t("federation.clusters.searchMembers")}
                placeholder={t("federation.clusters.searchMembers")}
                value={memberSearch}
                onChange={(event) => setMemberSearch(event.target.value)}
              />
              <div className="grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-2">
                {members.data?.data.map((member) => (
                  <label key={member.userId} className="flex min-w-0 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={draft.allowAllMembers}
                      checked={
                        draft.allowAllMembers || draft.allowedUserIds.includes(member.userId)
                      }
                      onChange={(event) =>
                        patch(
                          "allowedUserIds",
                          event.target.checked
                            ? [...draft.allowedUserIds, member.userId]
                            : draft.allowedUserIds.filter((id) => id !== member.userId),
                        )
                      }
                    />
                    <span className="truncate">{member.displayName || member.email}</span>
                  </label>
                ))}
              </div>
              {members.data?.hasMore ? (
                <p className="text-sm text-muted-foreground">
                  {t("federation.clusters.moreMembers")}
                </p>
              ) : null}
            </fieldset>
            <div className="flex flex-wrap gap-x-8 gap-y-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={draft.showPartnerLabel}
                  checked={draft.showPartnerLabel}
                  onChange={(event) => patch("showPartnerLabel", event.target.checked)}
                />
                {t("federation.clusters.showPartner")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={draft.enabled}
                  checked={draft.enabled}
                  onChange={(event) => patch("enabled", event.target.checked)}
                />
                {t("common.enabled")}
              </label>
            </div>
            <FederationClusterProfiles
              value={draft.profiles}
              onChange={(profiles) => patch("profiles", profiles)}
              agreement={agreement}
              materials={(materials.data ?? []).filter(
                (material) => material.originSiteId === agreement?.terms.sourceSiteId,
              )}
            />
            {error ? (
              <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {agreements.isError || members.isError ? (
              <FederationLoadError
                onRetry={() => {
                  void agreements.refetch();
                  void members.refetch();
                }}
              />
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                type="submit"
                disabled={
                  agreements.isPending || members.isPending || agreements.isError || members.isError
                }
              >
                {save.isPending ? t("common.saving") : t("common.save")}
              </Button>
              {initial?.config.enabled ? (
                <Button type="button" variant="outline" onClick={() => disable.mutate()}>
                  {t("federation.clusters.disable")}
                </Button>
              ) : null}
            </div>
          </fieldset>
        </form>
      </CardContent>
    </Card>
  );
}

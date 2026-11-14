import {
  FederationCurrentCapabilitiesSchema,
  MediaExportSummarySchema,
  MediaOptionsSchema,
  MediaPackageSummarySchema,
} from "@kuintessence/shared/federation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { FederationEmpty } from "./FederationLayout";
import { MediaDeliveryDetail } from "./MediaDeliveryDetail";
import {
  type MediaDeliveryAction,
  MediaDeliveryForm,
  mediaActionCapability,
} from "./MediaDeliveryForm";
import { MediaPagination, type MediaScope } from "./MediaLogisticsShared";

export type MediaWorkflowExport = { workflowRunId: string; taskKind: "task-input" | "task-result" };
type MediaDeliveryProps = {
  scope: ApiOrganizationScope;
  switching: boolean;
  exportFrom?: MediaWorkflowExport;
};
export function MediaDeliveryPanel(props: MediaDeliveryProps) {
  return (
    <MediaAccess
      key={`${props.scope.organizationId}:${props.scope.authRevision}:${props.exportFrom?.workflowRunId ?? ""}:${props.exportFrom?.taskKind ?? ""}`}
      {...props}
    />
  );
}
function MediaAccess({ scope, switching, exportFrom }: MediaDeliveryProps) {
  const { t } = useTranslation();
  const capabilities = useQuery({
    queryKey: ["federation", "current-capabilities", scope.organizationId, scope.authRevision],
    queryFn: async () =>
      FederationCurrentCapabilitiesSchema.parse(
        (await api.get<{ data: unknown }>("/federation/capabilities", scope)).data,
      ),
  });
  const allowed =
    !capabilities.isError &&
    capabilities.data?.orgId === scope.organizationId &&
    capabilities.data.effectiveCapabilities.includes("asset.read");
  const context = useQuery({
    queryKey: [
      "federation",
      "media",
      scope.organizationId,
      scope.authRevision,
      "options",
      "agents",
      undefined,
      0,
    ],
    enabled: allowed,
    queryFn: async () => {
      const value = MediaOptionsSchema.parse(
        await api.get("/federation/media/options?kind=agents&limit=20&offset=0", scope),
      );
      if (value.localOrgId !== scope.organizationId || value.kind !== "agents")
        throw new Error("Media organization mismatch");
      return value;
    },
    refetchOnWindowFocus: false,
  });
  if (capabilities.isError || (allowed && context.isError))
    return (
      <div role="alert" className="space-y-2">
        <p>{t("federation.loadFailed")}</p>
        <Button
          variant="outline"
          onClick={() => {
            void capabilities.refetch();
            void context.refetch();
          }}
        >
          {t("federation.refresh")}
        </Button>
      </div>
    );
  if (capabilities.isPending) return <p role="status">{t("federation.loading")}</p>;
  if (!allowed) return <p>{t("federation.delivery.denied")}</p>;
  if (!context.data) return <p role="status">{t("federation.loading")}</p>;
  return (
    <MediaInventory
      scope={{ ...scope, localSiteId: context.data.localSiteId }}
      capabilities={capabilities.data?.effectiveCapabilities ?? []}
      exportFrom={exportFrom}
      busy={switching || capabilities.isFetching || context.isFetching}
    />
  );
}
function MediaInventory({
  scope,
  capabilities,
  busy,
  exportFrom,
}: {
  scope: MediaScope;
  exportFrom?: MediaWorkflowExport;
  capabilities: readonly string[];
  busy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [direction, setDirection] = useState<"exports" | "packages">("exports");
  const [page, setPage] = useState(0),
    [selected, setSelected] = useState<string | null>(null);
  const [action, setAction] = useState<MediaDeliveryAction | null>(null);
  const key = ["federation", "media", scope.organizationId, scope.authRevision];
  const list = useQuery({
    queryKey: [...key, direction, "list", page, exportFrom?.workflowRunId],
    queryFn: async () => {
      const raw = (
        await api.get<{ data: unknown }>(
          `/federation/media/${direction}?limit=20&offset=${page * 20}${exportFrom ? `&workflowRunId=${encodeURIComponent(exportFrom.workflowRunId)}` : ""}`,
          scope,
        )
      ).data;
      if (direction === "exports")
        return {
          kind: "exports" as const,
          data: z.array(MediaExportSummarySchema).max(20).parse(raw),
        };
      const data = z.array(MediaPackageSummarySchema).max(20).parse(raw);
      if (data.some((row) => row.recipientSiteId !== scope.localSiteId))
        throw new Error("Media recipient mismatch");
      return { kind: "packages" as const, data };
    },
    refetchOnWindowFocus: false,
  });
  const reload = async () => {
    await client.invalidateQueries({ queryKey: key });
  };
  const next: MediaDeliveryAction =
    direction === "exports"
      ? { kind: "export", ...exportFrom }
      : { kind: "register", workflowRunId: exportFrom?.workflowRunId };
  return (
    <section className="space-y-5" aria-label={t("federation.delivery.title")}>
      <h2 className="text-lg font-semibold tracking-tight">{t("federation.delivery.title")}</h2>
      {exportFrom ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold">{t("federation.delivery.workflowMaterials")}</h3>
          <Button asChild variant="ghost">
            <a href={`/workflows/${encodeURIComponent(exportFrom.workflowRunId)}`}>
              {t("federation.delivery.backToWorkflow")}
            </a>
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={direction}
          onValueChange={(value) => {
            if (value !== "exports" && value !== "packages") return;
            setDirection(value);
            setPage(0);
            setSelected(null);
            setAction(null);
          }}
        >
          <TabsList className="federation-subnav" aria-label={t("federation.delivery.title")}>
            <TabsTrigger value="exports" disabled={!!action}>
              {t("federation.delivery.outgoing")}
            </TabsTrigger>
            <TabsTrigger value="packages" disabled={!!action}>
              {t("federation.delivery.incoming")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || list.isFetching || !!action}
            onClick={() => void reload()}
          >
            {t("federation.refresh")}
          </Button>
          {!selected && !action && capabilities.includes(mediaActionCapability(next)) ? (
            <Button
              disabled={busy || list.isPending || list.isError}
              onClick={() => setAction(next)}
            >
              {t(`federation.delivery.actions.${next.kind}`)}
            </Button>
          ) : null}
        </div>
      </div>
      {action ? (
        <MediaDeliveryForm
          scope={scope}
          action={action}
          busy={
            busy ||
            list.isError ||
            list.isFetching ||
            !capabilities.includes(mediaActionCapability(action))
          }
          onCancel={() => setAction(null)}
          onSaved={async (id) => {
            setAction(null);
            setSelected(id ?? null);
            await reload();
          }}
        />
      ) : selected ? (
        <>
          <Button variant="ghost" onClick={() => setSelected(null)}>
            {t("federation.logistics.back")}
          </Button>
          <MediaDeliveryDetail
            key={`${direction}:${selected}`}
            scope={scope}
            direction={direction}
            packageId={selected}
            capabilities={capabilities}
            busy={busy || list.isFetching || list.isError}
            onSaved={reload}
          />
        </>
      ) : list.isError ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : list.isPending ? (
        <p role="status">{t("federation.loading")}</p>
      ) : (
        <>
          {!list.data?.data.length ? (
            <FederationEmpty>{t("federation.delivery.empty")}</FederationEmpty>
          ) : (
            <ul className="federation-list divide-y divide-border rounded-md border">
              {list.data.data.map((row) => {
                const outgoing = "taskSelection" in row;
                const subject = outgoing
                  ? (row.taskSelection?.kind ?? "dataset")
                  : row.subject.kind;
                const state = row.revokedAt
                  ? "revoked"
                  : outgoing
                    ? Date.parse(row.expiresAt) <= Date.now()
                      ? "expired"
                      : "approved"
                    : "registered";
                return (
                  <li key={row.packageId}>
                    <button
                      type="button"
                      className="federation-list-row flex w-full flex-wrap justify-between gap-3 p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-ring"
                      onClick={() => setSelected(row.packageId)}
                    >
                      <span className="min-w-0 space-y-1">
                        <span className="block font-medium">
                          {t(`federation.delivery.kinds.${subject}`)}
                        </span>
                        <code className="block break-all text-xs">{row.packageId}</code>
                        <span className="block text-sm text-muted-foreground">
                          {new Date(outgoing ? row.approvedAt : row.registeredAt).toLocaleString(
                            i18n.language,
                          )}
                        </span>
                      </span>
                      <Badge variant="outline">{t(`federation.delivery.states.${state}`)}</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <MediaPagination
            page={page}
            hasMore={list.data?.data.length === 20}
            busy={list.isFetching}
            onChange={setPage}
          />
        </>
      )}
    </section>
  );
}

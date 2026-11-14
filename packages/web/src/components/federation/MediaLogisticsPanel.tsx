import {
  FederationCurrentCapabilitiesSchema,
  MediaDeviceListSchema,
  MediaLogisticsContextSchema,
  MediaShipmentDetailSchema,
  MediaShipmentListSchema,
  mediaShipmentTerminal,
} from "@kuintessence/shared/federation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type ApiOrganizationScope, api } from "../../lib/api-client";
import { federationReadFailed } from "../../lib/federation-query-state";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import {
  FederationEmpty,
  FederationRefreshNotice,
  FederationSectionTitle,
} from "./FederationLayout";
import { type MediaFormAction, MediaLogisticsForm } from "./MediaLogisticsForm";
import { checkMediaScope, MediaPagination, type MediaScope } from "./MediaLogisticsShared";

export function MediaLogisticsPanel(props: { scope: ApiOrganizationScope; switching: boolean }) {
  return (
    <MediaAccess key={`${props.scope.organizationId}:${props.scope.authRevision}`} {...props} />
  );
}
function MediaAccess({ scope, switching }: { scope: ApiOrganizationScope; switching: boolean }) {
  const { t } = useTranslation();
  const capabilities = useQuery({
    queryKey: ["federation", "current-capabilities", scope.organizationId, scope.authRevision],
    queryFn: async () =>
      FederationCurrentCapabilitiesSchema.parse(
        (await api.get<{ data: unknown }>("/federation/capabilities", scope)).data,
      ),
  });
  const allowed =
    !federationReadFailed(capabilities) &&
    capabilities.data?.orgId === scope.organizationId &&
    capabilities.data.effectiveCapabilities.includes("media.logistics");
  const context = useQuery({
    queryKey: ["federation", "media", scope.organizationId, scope.authRevision, "context"],
    enabled: allowed,
    queryFn: async () => {
      const value = MediaLogisticsContextSchema.parse(
        (await api.get<{ data: unknown }>("/federation/media/logistics-context", scope)).data,
      );
      if (value.localOrgId !== scope.organizationId) throw new Error("Media organization mismatch");
      return value;
    },
  });
  if (federationReadFailed(capabilities) || (allowed && federationReadFailed(context)))
    return (
      <div role="alert">
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
  if (!allowed) return <p>{t("federation.logistics.denied")}</p>;
  if (!context.data) return <p role="status">{t("federation.loading")}</p>;
  return (
    <>
      <FederationRefreshNotice query={capabilities} onRetry={() => void capabilities.refetch()} />
      <FederationRefreshNotice query={context} onRetry={() => void context.refetch()} />
      <MediaInventory
        scope={{ ...scope, localSiteId: context.data.localSiteId }}
        busy={
          switching ||
          capabilities.isFetching ||
          context.isFetching ||
          capabilities.isError ||
          context.isError
        }
      />
    </>
  );
}
function MediaInventory({ scope, busy }: { scope: MediaScope; busy: boolean }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [view, setView] = useState("shipments");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [eventPage, setEventPage] = useState(0);
  const [action, setAction] = useState<MediaFormAction | null>(null);
  const key = ["federation", "media", scope.organizationId, scope.authRevision];
  const list = useQuery({
    queryKey: [...key, view, page],
    queryFn: async () => {
      const raw = await api.get(`/federation/media/${view}?limit=20&offset=${page * 20}`, scope);
      if (view === "devices") {
        const value = MediaDeviceListSchema.parse(raw);
        for (const row of value.data) checkMediaScope(row.device, scope);
        return { kind: "devices" as const, ...value };
      }
      const value = MediaShipmentListSchema.parse(raw);
      for (const row of value.data) checkMediaScope(row, scope);
      return { kind: "shipments" as const, ...value };
    },
    refetchOnWindowFocus: false,
  });
  const detail = useQuery({
    queryKey: [...key, "shipment", selected, eventPage],
    enabled: !!selected,
    queryFn: async () => {
      const value = MediaShipmentDetailSchema.parse(
        (
          await api.get<{ data: unknown }>(
            `/federation/media/shipments/${selected}?limit=20&offset=${eventPage * 20}`,
            scope,
          )
        ).data,
      );
      checkMediaScope(value.shipment, scope);
      if (value.shipment.shipmentId !== selected) throw new Error("Shipment identity mismatch");
      return value;
    },
    refetchOnWindowFocus: false,
  });
  const current = !federationReadFailed(detail) ? detail.data : undefined;
  const reload = () => {
    void client.invalidateQueries({ queryKey: key });
  };
  return (
    <section className="space-y-5" aria-label={t("federation.logistics.title")}>
      <FederationRefreshNotice query={list} onRetry={reload} />
      <FederationRefreshNotice query={detail} onRetry={() => void detail.refetch()} />
      <FederationSectionTitle title={t("federation.logistics.title")} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={view}
          onValueChange={(value) => {
            setView(value);
            setPage(0);
            setSelected(null);
            setAction(null);
          }}
        >
          <TabsList className="federation-subnav" aria-label={t("federation.logistics.title")}>
            <TabsTrigger value="shipments" disabled={!!action}>
              {t("federation.logistics.shipments")}
            </TabsTrigger>
            <TabsTrigger value="devices" disabled={!!action}>
              {t("federation.logistics.devices")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || !!action || list.isFetching || (!!selected && detail.isFetching)}
            onClick={reload}
          >
            {t("federation.refresh")}
          </Button>
          {!action && !selected ? (
            <Button
              disabled={busy || list.isPending || list.isError}
              onClick={() => setAction({ kind: view === "devices" ? "register" : "shipment" })}
            >
              {t(`federation.logistics.${view === "devices" ? "newDevice" : "newShipment"}`)}
            </Button>
          ) : null}
        </div>
      </div>
      {federationReadFailed(list) ? (
        <p role="alert">{t("federation.loadFailed")}</p>
      ) : action ? (
        <MediaLogisticsForm
          scope={scope}
          action={action}
          busy={busy || list.isError || (!!selected && detail.isError)}
          onCancel={() => setAction(null)}
          onSaved={async (shipmentId) => {
            setAction(null);
            if (shipmentId) {
              setSelected(shipmentId);
              setEventPage(0);
            }
            await client.invalidateQueries({ queryKey: key });
          }}
        />
      ) : selected ? (
        <>
          <Button variant="ghost" onClick={() => setSelected(null)}>
            {t("federation.logistics.back")}
          </Button>
          {federationReadFailed(detail) ? (
            <p role="alert">{t("federation.loadFailed")}</p>
          ) : !current ? (
            <p role="status">{t("federation.loading")}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold break-words">{current.shipment.name}</h3>
                  <p className="text-sm break-all">
                    {current.shipment.senderName ?? current.shipment.senderSiteId} →{" "}
                    {current.shipment.recipientName ?? current.shipment.recipientSiteId}
                  </p>
                </div>
                <span className="rounded-md bg-muted px-3 py-1 text-sm">
                  {t(`federation.logistics.states.${current.shipment.state}`)}
                </span>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <h4 className="mb-2 font-medium">{t("federation.logistics.devices")}</h4>
                  <ul className="space-y-2">
                    {current.devices.map(({ device }) => (
                      <li key={device.deviceId} className="text-sm break-words">
                        {device.name} · {device.assetTag}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="mb-2 font-medium">{t("federation.logistics.packages")}</h4>
                  <ul className="space-y-2">
                    {current.shipment.packages.map((item) => (
                      <li key={item.packageId}>
                        <details className="text-xs break-all">
                          <summary className="cursor-pointer font-mono">{item.packageId}</summary>
                          <p className="mt-2 font-mono">{item.manifestDigest}</p>
                        </details>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <h4 className="font-medium">{t("federation.logistics.history")}</h4>
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    detail.isFetching ||
                    detail.isError ||
                    mediaShipmentTerminal(current.shipment.state)
                  }
                  onClick={() => setAction({ kind: "handoff", shipment: current.shipment })}
                >
                  {t("federation.logistics.recordHandoff")}
                </Button>
              </div>
              {current.events.length ? (
                <ol className="space-y-4 border-l border-border pl-4">
                  {current.events.map((event) => (
                    <li key={event.eventId} className="space-y-1 text-sm">
                      <p className="font-medium">
                        {t(`federation.logistics.states.${event.payload.state}`)}
                      </p>
                      <time dateTime={event.payload.occurredAt}>
                        {new Date(event.payload.occurredAt).toLocaleString(i18n.language)}
                      </time>
                      <p className="whitespace-pre-wrap break-words">{event.payload.note}</p>
                      {event.payload.evidenceDigest ? (
                        <code className="block break-all text-xs">
                          {event.payload.evidenceDigest}
                        </code>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("federation.logistics.noHistory")}
                </p>
              )}
              <MediaPagination
                page={eventPage}
                hasMore={current.hasMore}
                busy={detail.isFetching}
                onChange={setEventPage}
              />
            </>
          )}
        </>
      ) : list.isPending || !list.data ? (
        <p role="status">{t("federation.loading")}</p>
      ) : (
        <>
          {!list.data?.data.length ? (
            <FederationEmpty>{t("federation.logistics.empty")}</FederationEmpty>
          ) : (
            <ul className="federation-list divide-y divide-border rounded-md border border-border">
              {list.data.kind === "shipments"
                ? list.data.data.map((row) => (
                    <li key={row.shipmentId}>
                      <button
                        type="button"
                        className="federation-list-row flex w-full flex-wrap justify-between gap-3 p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => {
                          setSelected(row.shipmentId);
                          setEventPage(0);
                        }}
                      >
                        <span className="min-w-0">
                          <span className="block font-medium break-words">{row.name}</span>
                          <span className="block text-sm text-muted-foreground break-all">
                            {row.senderName ?? row.senderSiteId} →{" "}
                            {row.recipientName ?? row.recipientSiteId}
                          </span>
                        </span>
                        <Badge variant="outline">
                          {t(`federation.logistics.states.${row.state}`)}
                        </Badge>
                      </button>
                    </li>
                  ))
                : list.data.data.map(({ device, activeShipmentId }) => (
                    <li
                      key={device.deviceId}
                      className="flex flex-wrap items-center justify-between gap-3 p-4"
                    >
                      <div className="min-w-0">
                        <p className="font-medium break-words">
                          {device.name} · {device.assetTag}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {(device.capacityBytes / 2 ** 30).toLocaleString(i18n.language, {
                            maximumFractionDigits: 2,
                          })}{" "}
                          GiB · {t(`federation.logistics.states.${device.state}`)}
                          {activeShipmentId ? ` · ${t("federation.logistics.assigned")}` : ""}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        disabled={
                          busy || list.isError || !!activeShipmentId || device.state === "destroyed"
                        }
                        onClick={() => setAction({ kind: "update", device })}
                      >
                        {t("federation.logistics.edit")}
                      </Button>
                    </li>
                  ))}
            </ul>
          )}
          <MediaPagination
            page={page}
            hasMore={list.data?.hasMore ?? false}
            busy={list.isFetching}
            onChange={setPage}
          />
        </>
      )}
    </section>
  );
}

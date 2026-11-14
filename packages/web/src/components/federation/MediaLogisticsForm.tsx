import {
  federationCanonicalJson,
  MEDIA_SHIPMENT_TRANSITIONS,
  type MediaDevice,
  MediaDeviceListSchema,
  MediaDeviceRegistrationSchema,
  MediaDeviceSchema,
  MediaDeviceUpdateSchema,
  MediaHandoffRecordSchema,
  MediaHandoffSchema,
  type MediaShipment,
  MediaShipmentRegistrationSchema,
  MediaShipmentSchema,
  type MediaTransportPackage,
  MediaTransportPackagesSchema,
} from "@kuintessence/shared/federation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { FederationEmpty } from "./FederationLayout";
import { checkMediaScope, MediaPagination, type MediaScope } from "./MediaLogisticsShared";

export type MediaFormAction =
  | { kind: "register" }
  | { kind: "shipment" }
  | { kind: "update"; device: MediaDevice }
  | { kind: "handoff"; shipment: MediaShipment };
type Request = { path: string; body: unknown; method: "post" | "patch" };
export function MediaLogisticsForm({
  scope,
  action,
  busy,
  onCancel,
  onSaved,
}: {
  scope: MediaScope;
  action: MediaFormAction;
  busy: boolean;
  onCancel: () => void;
  onSaved: (shipmentId?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState(action.kind === "update" ? action.device.name : "");
  const [assetTag, setAssetTag] = useState("");
  const [capacity, setCapacity] = useState("");
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const states =
    action.kind === "handoff"
      ? MEDIA_SHIPMENT_TRANSITIONS[action.shipment.state].filter(
          (state) =>
            !(
              action.shipment.state === "prepared" &&
              state === "received" &&
              action.shipment.recipientSiteId !== scope.localSiteId
            ),
        )
      : ["active", "retired", "destroyed"];
  const [state, setState] = useState(
    action.kind === "update" ? action.device.state : (states[0] ?? ""),
  );
  const [devicePage, setDevicePage] = useState(0);
  const [packagePage, setPackagePage] = useState(0);
  const [devices, setDevices] = useState<MediaDevice[]>([]);
  const [packages, setPackages] = useState<MediaTransportPackage[]>([]);
  const [request, setRequest] = useState<Request | null>(null);
  const [invalid, setInvalid] = useState(false);
  const allowed = useRef(!busy);
  allowed.current = !busy;
  const key = ["federation", "media", scope.organizationId, scope.authRevision, "picker"];
  const inventory = useQuery({
    queryKey: [...key, "devices", devicePage],
    enabled: action.kind === "shipment",
    queryFn: async () => {
      const value = MediaDeviceListSchema.parse(
        await api.get(`/federation/media/devices?limit=20&offset=${devicePage * 20}`, scope),
      );
      for (const row of value.data) checkMediaScope(row.device, scope);
      return value;
    },
    refetchOnWindowFocus: false,
  });
  const available = useQuery({
    queryKey: [...key, "packages", packagePage],
    enabled: action.kind === "shipment",
    queryFn: async () =>
      checkMediaScope(
        MediaTransportPackagesSchema.parse(
          await api.get(
            `/federation/media/transport-packages?limit=20&offset=${packagePage * 20}`,
            scope,
          ),
        ),
        scope,
      ),
    refetchOnWindowFocus: false,
  });
  const send = useMutation({
    mutationFn: async (intent: Request) => {
      if (!allowed.current) throw new Error("Media action unavailable");
      const raw = (await api[intent.method]<{ data: unknown }>(intent.path, intent.body, scope))
        .data;
      if (action.kind === "register" || action.kind === "update") {
        const saved = checkMediaScope(MediaDeviceSchema.parse(raw), scope);
        if (action.kind === "register") {
          const input = MediaDeviceRegistrationSchema.parse(intent.body);
          if (
            saved.deviceId !== input.deviceId ||
            saved.assetTag !== input.assetTag ||
            saved.capacityBytes !== input.capacityBytes ||
            saved.name !== input.name
          )
            throw new Error("Device response mismatch");
        } else {
          const input = MediaDeviceUpdateSchema.parse(intent.body);
          if (
            saved.deviceId !== action.device.deviceId ||
            saved.version !== input.expectedVersion + 1 ||
            saved.name !== input.name ||
            saved.state !== input.state
          )
            throw new Error("Device update mismatch");
        }
        return undefined;
      }
      if (action.kind === "shipment") {
        const input = MediaShipmentRegistrationSchema.parse(intent.body);
        const saved = checkMediaScope(MediaShipmentSchema.parse(raw), scope);
        if (
          saved.shipmentId !== input.shipmentId ||
          saved.name !== input.name ||
          federationCanonicalJson(saved.packages.map((row) => row.packageId).sort()) !==
            federationCanonicalJson([...input.packageIds].sort()) ||
          saved.packages.some(
            (row) =>
              !packages.some(
                (item) =>
                  item.packageId === row.packageId &&
                  item.manifestDigest === row.manifestDigest &&
                  item.agreementRevisionId === row.agreementRevisionId &&
                  item.senderSiteId === saved.senderSiteId &&
                  item.recipientSiteId === saved.recipientSiteId,
              ),
          )
        )
          throw new Error("Shipment response mismatch");
        return saved.shipmentId;
      }
      const event = MediaHandoffRecordSchema.parse(raw);
      if (
        event.localSiteId !== scope.localSiteId ||
        event.shipmentId !== action.shipment.shipmentId ||
        federationCanonicalJson(event.payload) !== federationCanonicalJson(intent.body)
      )
        throw new Error("Handoff response mismatch");
      return action.shipment.shipmentId;
    },
    onSuccess: onSaved,
  });
  const blocked = busy || send.isPending;
  const locked = blocked || !!request;
  const build = (): Request => {
    const base = "/federation/media";
    if (action.kind === "register")
      return {
        method: "post",
        path: `${base}/devices`,
        body: MediaDeviceRegistrationSchema.parse({
          deviceId: crypto.randomUUID(),
          name,
          assetTag,
          capacityBytes: Number(capacity) * 2 ** 30,
        }),
      };
    if (action.kind === "update")
      return {
        method: "patch",
        path: `${base}/devices/${action.device.deviceId}`,
        body: MediaDeviceUpdateSchema.parse({
          expectedVersion: action.device.version,
          name,
          state,
          reason: note,
        }),
      };
    if (action.kind === "shipment")
      return {
        method: "post",
        path: `${base}/shipments`,
        body: MediaShipmentRegistrationSchema.parse({
          shipmentId: crypto.randomUUID(),
          name,
          deviceIds: devices.map((row) => row.deviceId),
          packageIds: packages.map((row) => row.packageId),
        }),
      };
    return {
      method: "post",
      path: `${base}/shipments/${action.shipment.shipmentId}/handoffs`,
      body: MediaHandoffSchema.parse({
        eventId: crypto.randomUUID(),
        expectedVersion: action.shipment.version,
        state,
        occurredAt: occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(),
        note,
        evidenceDigest: evidence.trim() || null,
      }),
    };
  };
  const identity = request
    ? action.kind === "register"
      ? MediaDeviceRegistrationSchema.parse(request.body).deviceId
      : action.kind === "shipment"
        ? MediaShipmentRegistrationSchema.parse(request.body).shipmentId
        : action.kind === "handoff"
          ? MediaHandoffSchema.parse(request.body).eventId
          : action.device.deviceId
    : null;
  const first = packages[0];
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked) return;
        try {
          const intent = request ?? build();
          setRequest(intent);
          setInvalid(false);
          send.mutate(intent);
        } catch {
          setInvalid(true);
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">
          {t(
            `federation.logistics.${action.kind === "register" ? "newDevice" : action.kind === "shipment" ? "newShipment" : action.kind === "update" ? "edit" : "recordHandoff"}`,
          )}
        </h3>
        <Button type="button" variant="ghost" disabled={send.isPending} onClick={onCancel}>
          {t("federation.logistics.back")}
        </Button>
      </div>
      <fieldset disabled={locked} className="grid max-w-xl gap-3">
        {action.kind !== "handoff" ? (
          <label className="space-y-1 text-sm" htmlFor={`${id}-name`}>
            <span>{t("federation.logistics.name")}</span>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={128}
              required
            />
          </label>
        ) : null}
        {action.kind === "register" ? (
          <>
            <label className="space-y-1 text-sm" htmlFor={`${id}-tag`}>
              <span>{t("federation.logistics.assetTag")}</span>
              <Input
                id={`${id}-tag`}
                value={assetTag}
                onChange={(e) => setAssetTag(e.target.value)}
                maxLength={128}
                required
              />
            </label>
            <label className="space-y-1 text-sm" htmlFor={`${id}-capacity`}>
              <span>{t("federation.logistics.capacity")}</span>
              <Input
                id={`${id}-capacity`}
                type="number"
                min="0.000001"
                max={Number.MAX_SAFE_INTEGER / 2 ** 30}
                step="any"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                required
              />
            </label>
          </>
        ) : null}
        {action.kind === "update" || action.kind === "handoff" ? (
          <>
            <label className="space-y-1 text-sm" htmlFor={`${id}-state`}>
              <span>{t("federation.logistics.state")}</span>
              <select
                id={`${id}-state`}
                className="h-10 w-full rounded-md border border-input bg-background px-3"
                value={state}
                onChange={(e) => setState(e.target.value)}
                required
              >
                {states.map((value) => (
                  <option key={value} value={value}>
                    {t(`federation.logistics.states.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm" htmlFor={`${id}-note`}>
              <span>
                {t(
                  action.kind === "update"
                    ? "federation.logistics.reason"
                    : "federation.logistics.note",
                )}
              </span>
              <Textarea
                id={`${id}-note`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={500}
                required
              />
            </label>
          </>
        ) : null}
        {action.kind === "handoff" ? (
          <>
            <label className="space-y-1 text-sm" htmlFor={`${id}-time`}>
              <span>{t("federation.logistics.occurredAt")}</span>
              <Input
                id={`${id}-time`}
                type="datetime-local"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm" htmlFor={`${id}-evidence`}>
              <span>{t("federation.logistics.evidence")}</span>
              <Input
                id={`${id}-evidence`}
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                maxLength={71}
              />
            </label>
          </>
        ) : null}
      </fieldset>
      {action.kind === "shipment" ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <fieldset disabled={locked} className="min-w-0 space-y-3">
            <legend className="mb-3 font-medium">
              {t("federation.logistics.devices")} · {devices.length}/100
            </legend>
            {devices.length ? (
              <ul className="flex flex-wrap gap-2">
                {devices
                  .filter(
                    (item) =>
                      !inventory.data?.data.some((row) => row.device.deviceId === item.deviceId),
                  )
                  .map((item) => (
                    <li key={item.deviceId}>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          setDevices(devices.filter((row) => row.deviceId !== item.deviceId))
                        }
                      >
                        {t("federation.logistics.remove", { name: item.name })}
                      </Button>
                    </li>
                  ))}
              </ul>
            ) : null}
            {inventory.isError ? (
              <p role="alert">{t("federation.loadFailed")}</p>
            ) : inventory.isPending ? (
              <p role="status">{t("federation.loading")}</p>
            ) : inventory.data?.data.length ? (
              <ul className="divide-y border rounded-md">
                {inventory.data.data.map(({ device, activeShipmentId }) => (
                  <li key={device.deviceId}>
                    <label className="flex items-start gap-3 p-3 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={devices.some((row) => row.deviceId === device.deviceId)}
                        disabled={
                          device.state !== "active" ||
                          !!activeShipmentId ||
                          (devices.length >= 100 &&
                            !devices.some((row) => row.deviceId === device.deviceId))
                        }
                        onChange={(e) =>
                          setDevices(
                            e.target.checked
                              ? [...devices, device]
                              : devices.filter((row) => row.deviceId !== device.deviceId),
                          )
                        }
                      />
                      <span className="break-words min-w-0">
                        {device.name} · {device.assetTag}
                        {activeShipmentId
                          ? ` · ${t("federation.logistics.assigned")}`
                          : device.state !== "active"
                            ? ` · ${t(`federation.logistics.states.${device.state}`)}`
                            : ""}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <FederationEmpty>{t("federation.logistics.empty")}</FederationEmpty>
            )}
            <MediaPagination
              page={devicePage}
              hasMore={inventory.data?.hasMore ?? false}
              busy={inventory.isFetching}
              onChange={setDevicePage}
            />
          </fieldset>
          <fieldset disabled={locked} className="min-w-0 space-y-3">
            <legend className="mb-3 font-medium">
              {t("federation.logistics.packages")} · {packages.length}/100
            </legend>
            {packages.length ? (
              <ul className="space-y-1">
                {packages
                  .filter(
                    (item) => !available.data?.data.some((row) => row.packageId === item.packageId),
                  )
                  .map((item) => (
                    <li key={item.packageId}>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-auto whitespace-normal break-all text-left"
                        onClick={() =>
                          setPackages(packages.filter((row) => row.packageId !== item.packageId))
                        }
                      >
                        {t("federation.logistics.remove", { name: item.packageId })}
                      </Button>
                    </li>
                  ))}
              </ul>
            ) : null}
            {available.isError ? (
              <p role="alert">{t("federation.loadFailed")}</p>
            ) : available.isPending ? (
              <p role="status">{t("federation.loading")}</p>
            ) : available.data?.data.length ? (
              <ul className="divide-y border rounded-md">
                {available.data.data.map((item) => (
                  <li key={item.packageId}>
                    <label className="flex items-start gap-3 p-3 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={packages.some((row) => row.packageId === item.packageId)}
                        disabled={
                          (!!first &&
                            (first.senderSiteId !== item.senderSiteId ||
                              first.recipientSiteId !== item.recipientSiteId)) ||
                          (packages.length >= 100 &&
                            !packages.some((row) => row.packageId === item.packageId))
                        }
                        onChange={(e) =>
                          setPackages(
                            e.target.checked
                              ? [...packages, item]
                              : packages.filter((row) => row.packageId !== item.packageId),
                          )
                        }
                      />
                      <span className="min-w-0 break-all">
                        <span className="block">
                          {item.senderName ?? item.senderSiteId} →{" "}
                          {item.recipientName ?? item.recipientSiteId}
                        </span>
                        <span className="block font-mono text-xs">{item.packageId}</span>
                        <span className="block text-muted-foreground">
                          {t(`federation.logistics.kinds.${item.subjectKind}`)}
                          {item.revokedAt ? ` · ${t("federation.logistics.revoked")}` : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <FederationEmpty>{t("federation.logistics.empty")}</FederationEmpty>
            )}
            <MediaPagination
              page={packagePage}
              hasMore={available.data?.hasMore ?? false}
              busy={available.isFetching}
              onChange={setPackagePage}
            />
          </fieldset>
        </div>
      ) : null}
      {invalid ? (
        <p role="alert" className="text-sm text-status-failed">
          {t("federation.logistics.invalid")}
        </p>
      ) : null}
      {send.isError ? (
        <div role="alert" className="space-y-2 text-sm text-status-failed">
          <p>{t("federation.logistics.uncertain")}</p>
          <code className="block break-all">{request?.path}</code>
          <code className="block break-all">{identity}</code>
        </div>
      ) : null}
      <Button
        disabled={
          blocked ||
          (action.kind === "handoff" && !states.length) ||
          (!request &&
            action.kind === "shipment" &&
            (!devices.length ||
              !packages.length ||
              inventory.isError ||
              available.isError ||
              inventory.isPending ||
              available.isPending))
        }
      >
        {t(send.isError ? "federation.logistics.retry" : "federation.logistics.save")}
      </Button>
    </form>
  );
}

import { z } from "zod";
import { FederationDigestSchema } from "./references";

const Name = z.string().trim().min(1).max(128);
const Note = z.string().trim().min(1).max(500);
const Version = z.number().int().positive().max(2_147_483_646);
const Ids = z
  .array(z.uuid())
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length);

export const MediaDeviceStateSchema = z.enum(["active", "retired", "destroyed"]);
export const MediaDeviceRegistrationSchema = z.strictObject({
  deviceId: z.uuid(),
  name: Name,
  assetTag: Name,
  capacityBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const MediaDeviceUpdateSchema = z.strictObject({
  expectedVersion: Version,
  name: Name,
  state: MediaDeviceStateSchema,
  reason: Note,
});
export const MediaShipmentStateSchema = z.enum([
  "prepared",
  "dispatched",
  "received",
  "returning",
  "returned",
  "closed",
  "cancelled",
  "lost",
  "damaged",
]);
export type MediaShipmentState = z.infer<typeof MediaShipmentStateSchema>;
export const MediaShipmentRegistrationSchema = z.strictObject({
  shipmentId: z.uuid(),
  name: Name,
  deviceIds: Ids,
  packageIds: Ids,
});
export const MediaHandoffSchema = z.strictObject({
  eventId: z.uuid(),
  expectedVersion: Version,
  state: MediaShipmentStateSchema.exclude(["prepared"]),
  occurredAt: z.iso.datetime(),
  note: Note,
  evidenceDigest: FederationDigestSchema.nullable(),
});
export type MediaHandoff = z.infer<typeof MediaHandoffSchema>;
export const MEDIA_SHIPMENT_TRANSITIONS: Record<MediaShipmentState, readonly MediaShipmentState[]> =
  {
    prepared: ["dispatched", "received", "cancelled"],
    dispatched: ["received", "lost", "damaged"],
    received: ["returning", "closed"],
    returning: ["returned", "lost", "damaged"],
    returned: [],
    closed: [],
    cancelled: [],
    lost: [],
    damaged: [],
  };
export function mediaShipmentTerminal(state: MediaShipmentState): boolean {
  return MEDIA_SHIPMENT_TRANSITIONS[state].length === 0;
}

/** Local custody observations never grant disclosure, decryption, import or replica deletion. */
export const MediaShipmentPackageSchema = z.strictObject({
  packageId: z.uuid(),
  manifestDigest: FederationDigestSchema,
  agreementRevisionId: z.uuid(),
});
export type MediaShipmentPackage = z.infer<typeof MediaShipmentPackageSchema>;

export const MediaLogisticsContextSchema = z.object({
  localSiteId: z.uuid(),
  localOrgId: z.uuid(),
});
const Recorded = {
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  registrationDigest: FederationDigestSchema,
  version: z.number().int().positive(),
};
export const MediaDeviceSchema = MediaDeviceRegistrationSchema.extend({
  ...MediaLogisticsContextSchema.shape,
  ...Recorded,
  state: MediaDeviceStateSchema,
});
export type MediaDevice = z.infer<typeof MediaDeviceSchema>;
export const MediaDeviceListSchema = z.object({
  data: z.array(z.object({ device: MediaDeviceSchema, activeShipmentId: z.uuid().nullable() })),
  hasMore: z.boolean(),
});
export const MediaShipmentSchema = z
  .object({
    ...MediaLogisticsContextSchema.shape,
    ...Recorded,
    shipmentId: z.uuid(),
    name: Name,
    senderSiteId: z.uuid(),
    recipientSiteId: z.uuid(),
    senderName: z.string().nullable().optional(),
    recipientName: z.string().nullable().optional(),
    packages: z.array(MediaShipmentPackageSchema).min(1).max(100),
    state: MediaShipmentStateSchema,
  })
  .refine(
    (row) =>
      row.senderSiteId !== row.recipientSiteId &&
      [row.senderSiteId, row.recipientSiteId].includes(row.localSiteId),
  );
export type MediaShipment = z.infer<typeof MediaShipmentSchema>;
export const MediaShipmentListSchema = z.object({
  data: z.array(MediaShipmentSchema),
  hasMore: z.boolean(),
});
export const MediaHandoffRecordSchema = z
  .object({
    localSiteId: z.uuid(),
    shipmentId: z.uuid(),
    eventId: z.uuid(),
    payload: MediaHandoffSchema,
    version: z.number().int().positive(),
    recordedBy: z.uuid(),
    recordedAt: z.iso.datetime(),
  })
  .refine(
    (row) => row.eventId === row.payload.eventId && row.version === row.payload.expectedVersion + 1,
  );
export const MediaShipmentDetailSchema = z
  .object({
    shipment: MediaShipmentSchema,
    devices: z.array(z.object({ device: MediaDeviceSchema, active: z.boolean() })),
    events: z.array(MediaHandoffRecordSchema),
    hasMore: z.boolean(),
  })
  .refine(
    (row) =>
      row.devices.every(
        ({ device }) =>
          device.localSiteId === row.shipment.localSiteId &&
          device.localOrgId === row.shipment.localOrgId,
      ) &&
      row.events.every(
        (event) =>
          event.localSiteId === row.shipment.localSiteId &&
          event.shipmentId === row.shipment.shipmentId,
      ),
  );
export const MediaTransportPackageSchema = MediaShipmentPackageSchema.extend({
  senderSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  senderName: z.string().nullable(),
  recipientName: z.string().nullable(),
  subjectKind: z.enum(["dataset", "task-input", "task-result"]),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type MediaTransportPackage = z.infer<typeof MediaTransportPackageSchema>;
export const MediaTransportPackagesSchema = MediaLogisticsContextSchema.extend({
  data: z.array(MediaTransportPackageSchema),
  hasMore: z.boolean(),
}).refine((row) =>
  row.data.every(
    (item) =>
      item.senderSiteId !== item.recipientSiteId &&
      [item.senderSiteId, item.recipientSiteId].includes(row.localSiteId),
  ),
);

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

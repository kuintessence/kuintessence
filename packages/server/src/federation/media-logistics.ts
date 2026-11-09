import { createHash } from "node:crypto";
import {
  federationMediaShipmentDevices as assignments,
  auditLog,
  federationMediaDevices as devices,
  federationMediaExports,
  federationMediaPackages,
  federationMediaHandoffs as handoffs,
  type PgDb,
  type PgTransaction,
  federationMediaShipments as shipments,
} from "@kuintessence/db";
import {
  FederationError,
  federationCanonicalJson,
  MEDIA_SHIPMENT_TRANSITIONS,
  MediaDeviceRegistrationSchema,
  MediaDeviceUpdateSchema,
  MediaHandoffSchema,
  type MediaShipmentPackage,
  MediaShipmentRegistrationSchema,
  mediaShipmentTerminal,
} from "@kuintessence/shared/federation";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { type FederationActor, requireFederationCapability } from "./permissions";

function digest(value: unknown) {
  return `sha256:${createHash("sha256").update(federationCanonicalJson(value)).digest("hex")}`;
}
const Page = z.object({
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().nonnegative(),
});

/** Human custody records, independent of key grants, import receipts and data replicas. */
export class FederationMediaLogistics {
  constructor(
    private readonly db: PgDb,
    private readonly localSiteId: string,
    private readonly clock = () => new Date(),
  ) {
    z.uuid().parse(localSiteId);
  }

  private async audit(
    tx: PgTransaction,
    actor: FederationActor,
    action: string,
    target: string,
    after: unknown,
  ) {
    await tx.insert(auditLog).values({
      actor: actor.userId,
      orgId: actor.orgId,
      action: `federation.media.logistics.${action}`,
      target,
      diff: { after },
    });
  }

  async registerDevice(actor: FederationActor, raw: unknown) {
    const input = MediaDeviceRegistrationSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "media.logistics");
      const [created] = await tx
        .insert(devices)
        .values({
          ...input,
          localSiteId: this.localSiteId,
          localOrgId: actor.orgId,
          registrationDigest: digest(input),
          createdBy: actor.userId,
          createdAt: this.clock(),
          updatedAt: this.clock(),
        })
        .onConflictDoNothing()
        .returning();
      if (created) {
        await this.audit(tx, actor, "device.register", input.deviceId, input);
        return created;
      }
      const [existing] = await tx
        .select()
        .from(devices)
        .where(
          and(
            eq(devices.localSiteId, this.localSiteId),
            eq(devices.deviceId, input.deviceId),
            eq(devices.localOrgId, actor.orgId),
          ),
        );
      if (!existing || existing.registrationDigest !== digest(input))
        throw new FederationError("OPERATION_CONFLICT");
      return existing;
    });
  }

  async listDevices(actor: FederationActor, limit = 50, offset = 0) {
    Page.parse({ limit, offset });
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "media.logistics");
      const rows = await tx
        .select({ device: devices, activeShipmentId: assignments.shipmentId })
        .from(devices)
        .leftJoin(
          assignments,
          and(
            eq(assignments.localSiteId, devices.localSiteId),
            eq(assignments.deviceId, devices.deviceId),
            eq(assignments.active, true),
          ),
        )
        .where(and(eq(devices.localSiteId, this.localSiteId), eq(devices.localOrgId, actor.orgId)))
        .orderBy(asc(devices.assetTag), asc(devices.deviceId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }

  async updateDevice(actor: FederationActor, deviceId: string, raw: unknown) {
    z.uuid().parse(deviceId);
    const input = MediaDeviceUpdateSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "media.logistics");
      const [device] = await tx
        .select()
        .from(devices)
        .where(
          and(
            eq(devices.localSiteId, this.localSiteId),
            eq(devices.deviceId, deviceId),
            eq(devices.localOrgId, actor.orgId),
          ),
        )
        .for("update");
      if (!device) throw new FederationError("POLICY_DENIED");
      if (device.version !== input.expectedVersion || device.state === "destroyed")
        throw new FederationError("OPERATION_CONFLICT");
      const [busy] = await tx
        .select()
        .from(assignments)
        .where(
          and(
            eq(assignments.localSiteId, this.localSiteId),
            eq(assignments.deviceId, deviceId),
            eq(assignments.active, true),
          ),
        );
      if (busy) throw new FederationError("OPERATION_CONFLICT");
      const [updated] = await tx
        .update(devices)
        .set({
          name: input.name,
          state: input.state,
          version: device.version + 1,
          updatedAt: this.clock(),
        })
        .where(and(eq(devices.localSiteId, this.localSiteId), eq(devices.deviceId, deviceId)))
        .returning();
      if (!updated) throw new FederationError("OPERATION_CONFLICT");
      await this.audit(tx, actor, "device.update", deviceId, {
        ...input,
        previousState: device.state,
        previousName: device.name,
      });
      return updated;
    });
  }

  private async packages(tx: PgTransaction, actor: FederationActor, ids: string[]) {
    const outgoing = await tx
      .select({
        packageId: federationMediaExports.packageId,
        manifestDigest: federationMediaExports.manifestDigest,
        agreementRevisionId: federationMediaExports.agreementRevisionId,
        senderSiteId: federationMediaExports.localSiteId,
        recipientSiteId: federationMediaExports.recipientSiteId,
      })
      .from(federationMediaExports)
      .where(
        and(
          eq(federationMediaExports.localSiteId, this.localSiteId),
          eq(federationMediaExports.localOrgId, actor.orgId),
          inArray(federationMediaExports.packageId, ids),
        ),
      )
      .for("share");
    const incoming = await tx
      .select({
        packageId: federationMediaPackages.packageId,
        manifestDigest: federationMediaPackages.manifestDigest,
        agreementRevisionId: federationMediaPackages.agreementRevisionId,
        senderSiteId: federationMediaPackages.senderSiteId,
        recipientSiteId: federationMediaPackages.localSiteId,
      })
      .from(federationMediaPackages)
      .where(
        and(
          eq(federationMediaPackages.localSiteId, this.localSiteId),
          eq(federationMediaPackages.localOrgId, actor.orgId),
          inArray(federationMediaPackages.packageId, ids),
        ),
      )
      .for("share");
    const rows = [...outgoing, ...incoming].sort((a, b) => a.packageId.localeCompare(b.packageId));
    const first = rows[0];
    if (
      !first ||
      rows.length !== ids.length ||
      new Set(rows.map((row) => row.packageId)).size !== ids.length ||
      rows.some(
        (row) =>
          row.senderSiteId !== first.senderSiteId || row.recipientSiteId !== first.recipientSiteId,
      )
    )
      throw new FederationError("POLICY_DENIED");
    return {
      senderSiteId: first.senderSiteId,
      recipientSiteId: first.recipientSiteId,
      packages: rows.map(
        ({ packageId, manifestDigest, agreementRevisionId }): MediaShipmentPackage => ({
          packageId,
          manifestDigest,
          agreementRevisionId,
        }),
      ),
    };
  }

  async registerShipment(actor: FederationActor, raw: unknown) {
    const input = MediaShipmentRegistrationSchema.parse(raw);
    input.deviceIds.sort();
    input.packageIds.sort();
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "media.logistics");
      // Lock inventory in a stable order before reserving devices or changing any shipment.
      const selected = await tx
        .select()
        .from(devices)
        .where(
          and(
            eq(devices.localSiteId, this.localSiteId),
            eq(devices.localOrgId, actor.orgId),
            inArray(devices.deviceId, input.deviceIds),
          ),
        )
        .orderBy(asc(devices.deviceId))
        .for("update");
      if (selected.length !== input.deviceIds.length) throw new FederationError("POLICY_DENIED");
      const binding = await this.packages(tx, actor, input.packageIds);
      const [created] = await tx
        .insert(shipments)
        .values({
          localSiteId: this.localSiteId,
          shipmentId: input.shipmentId,
          localOrgId: actor.orgId,
          name: input.name,
          ...binding,
          registrationDigest: digest(input),
          createdBy: actor.userId,
          createdAt: this.clock(),
          updatedAt: this.clock(),
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        const [existing] = await tx
          .select()
          .from(shipments)
          .where(
            and(
              eq(shipments.localSiteId, this.localSiteId),
              eq(shipments.shipmentId, input.shipmentId),
              eq(shipments.localOrgId, actor.orgId),
            ),
          );
        if (!existing || existing.registrationDigest !== digest(input))
          throw new FederationError("OPERATION_CONFLICT");
        return existing;
      }
      const busy = await tx
        .select()
        .from(assignments)
        .where(
          and(
            eq(assignments.localSiteId, this.localSiteId),
            inArray(assignments.deviceId, input.deviceIds),
            eq(assignments.active, true),
          ),
        );
      if (selected.some((device) => device.state !== "active") || busy.length)
        throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(assignments).values(
        input.deviceIds.map((deviceId) => ({
          localSiteId: this.localSiteId,
          shipmentId: input.shipmentId,
          deviceId,
        })),
      );
      await this.audit(tx, actor, "shipment.register", input.shipmentId, { ...input, ...binding });
      return created;
    });
  }

  async listShipments(actor: FederationActor, limit = 50, offset = 0) {
    Page.parse({ limit, offset });
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "media.logistics");
      const rows = await tx
        .select()
        .from(shipments)
        .where(
          and(eq(shipments.localSiteId, this.localSiteId), eq(shipments.localOrgId, actor.orgId)),
        )
        .orderBy(desc(shipments.createdAt), asc(shipments.shipmentId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }

  async shipmentDetails(actor: FederationActor, shipmentId: string, limit = 50, offset = 0) {
    z.uuid().parse(shipmentId);
    Page.parse({ limit, offset });
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "media.logistics");
      const [shipment] = await tx
        .select()
        .from(shipments)
        .where(
          and(
            eq(shipments.localSiteId, this.localSiteId),
            eq(shipments.shipmentId, shipmentId),
            eq(shipments.localOrgId, actor.orgId),
          ),
        )
        .for("share");
      if (!shipment) throw new FederationError("POLICY_DENIED");
      const deviceRows = await tx
        .select({ device: devices, active: assignments.active })
        .from(assignments)
        .innerJoin(
          devices,
          and(
            eq(devices.localSiteId, assignments.localSiteId),
            eq(devices.deviceId, assignments.deviceId),
          ),
        )
        .where(
          and(
            eq(assignments.localSiteId, this.localSiteId),
            eq(assignments.shipmentId, shipmentId),
          ),
        )
        .orderBy(asc(devices.deviceId));
      const events = await tx
        .select()
        .from(handoffs)
        .where(and(eq(handoffs.localSiteId, this.localSiteId), eq(handoffs.shipmentId, shipmentId)))
        .orderBy(desc(handoffs.version))
        .limit(limit + 1)
        .offset(offset);
      return {
        shipment,
        devices: deviceRows,
        events: events.slice(0, limit),
        hasMore: events.length > limit,
      };
    });
  }

  async recordHandoff(actor: FederationActor, shipmentId: string, raw: unknown) {
    z.uuid().parse(shipmentId);
    const input = MediaHandoffSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "media.logistics");
      const [visible] = await tx
        .select()
        .from(shipments)
        .where(
          and(
            eq(shipments.localSiteId, this.localSiteId),
            eq(shipments.shipmentId, shipmentId),
            eq(shipments.localOrgId, actor.orgId),
          ),
        );
      if (!visible) throw new FederationError("POLICY_DENIED");
      const links = await tx
        .select()
        .from(assignments)
        .where(
          and(
            eq(assignments.localSiteId, this.localSiteId),
            eq(assignments.shipmentId, shipmentId),
          ),
        )
        .orderBy(asc(assignments.deviceId));
      if (!links.length) throw new FederationError("OPERATION_CONFLICT");
      await tx
        .select()
        .from(devices)
        .where(
          and(
            eq(devices.localSiteId, this.localSiteId),
            inArray(
              devices.deviceId,
              links.map((link) => link.deviceId),
            ),
          ),
        )
        .orderBy(asc(devices.deviceId))
        .for("update");
      const [shipment] = await tx
        .select()
        .from(shipments)
        .where(
          and(eq(shipments.localSiteId, this.localSiteId), eq(shipments.shipmentId, shipmentId)),
        )
        .for("update");
      if (!shipment) throw new FederationError("OPERATION_CONFLICT");
      const [existing] = await tx
        .select()
        .from(handoffs)
        .where(
          and(eq(handoffs.localSiteId, this.localSiteId), eq(handoffs.eventId, input.eventId)),
        );
      if (existing) {
        if (existing.shipmentId !== shipmentId || digest(existing.payload) !== digest(input))
          throw new FederationError("OPERATION_CONFLICT");
        return existing;
      }
      if (
        shipment.version !== input.expectedVersion ||
        !MEDIA_SHIPMENT_TRANSITIONS[shipment.state].includes(input.state) ||
        Date.parse(input.occurredAt) > this.clock().getTime()
      )
        throw new FederationError("OPERATION_CONFLICT");
      // A receiver can register an already-arrived parcel without inventing a sender's dispatch event.
      if (
        shipment.state === "prepared" &&
        input.state === "received" &&
        shipment.recipientSiteId !== this.localSiteId
      )
        throw new FederationError("POLICY_DENIED");
      const [event] = await tx
        .insert(handoffs)
        .values({
          localSiteId: this.localSiteId,
          eventId: input.eventId,
          shipmentId,
          payload: input,
          version: shipment.version + 1,
          recordedBy: actor.userId,
          recordedAt: this.clock(),
        })
        .onConflictDoNothing()
        .returning();
      if (!event) throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(shipments)
        .set({ state: input.state, version: event.version, updatedAt: this.clock() })
        .where(
          and(eq(shipments.localSiteId, this.localSiteId), eq(shipments.shipmentId, shipmentId)),
        );
      if (mediaShipmentTerminal(input.state)) {
        await tx
          .update(assignments)
          .set({ active: false })
          .where(
            and(
              eq(assignments.localSiteId, this.localSiteId),
              eq(assignments.shipmentId, shipmentId),
            ),
          );
        if (input.state === "lost" || input.state === "damaged") {
          for (const link of links) {
            const [device] = await tx
              .select()
              .from(devices)
              .where(
                and(eq(devices.localSiteId, this.localSiteId), eq(devices.deviceId, link.deviceId)),
              );
            if (!device) throw new FederationError("OPERATION_CONFLICT");
            await tx
              .update(devices)
              .set({ state: "retired", version: device.version + 1, updatedAt: this.clock() })
              .where(
                and(eq(devices.localSiteId, this.localSiteId), eq(devices.deviceId, link.deviceId)),
              );
          }
        }
      }
      await this.audit(tx, actor, "handoff", shipmentId, {
        ...input,
        previousState: shipment.state,
      });
      return event;
    });
  }
}

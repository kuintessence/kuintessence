CREATE TABLE "federation_media_devices" (
	"local_site_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"asset_tag" varchar(128) NOT NULL,
	"capacity_bytes" bigint NOT NULL,
	"registration_digest" varchar(71) NOT NULL,
	"state" varchar(16) DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_media_devices_local_site_id_device_id_pk" PRIMARY KEY("local_site_id","device_id"),
	CONSTRAINT "federation_media_device_state" CHECK ("federation_media_devices"."state" IN ('active','retired','destroyed') AND "federation_media_devices"."version" > 0 AND "federation_media_devices"."capacity_bytes" BETWEEN 1 AND 9007199254740991 AND "federation_media_devices"."registration_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "federation_media_handoffs" (
	"local_site_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"version" integer NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_media_handoffs_local_site_id_event_id_pk" PRIMARY KEY("local_site_id","event_id"),
	CONSTRAINT "federation_media_handoff_identity" CHECK (("federation_media_handoffs"."version" > 1 AND "federation_media_handoffs"."payload"->>'eventId' = "federation_media_handoffs"."event_id"::text AND ("federation_media_handoffs"."payload"->>'expectedVersion')::int = "federation_media_handoffs"."version" - 1 AND "federation_media_handoffs"."payload"->>'state' IN ('dispatched','received','returning','returned','closed','cancelled','lost','damaged')) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_media_shipment_devices" (
	"local_site_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "federation_media_shipment_devices_local_site_id_shipment_id_device_id_pk" PRIMARY KEY("local_site_id","shipment_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "federation_media_shipments" (
	"local_site_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"sender_site_id" uuid NOT NULL,
	"recipient_site_id" uuid NOT NULL,
	"packages" jsonb NOT NULL,
	"registration_digest" varchar(71) NOT NULL,
	"state" varchar(16) DEFAULT 'prepared' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_media_shipments_local_site_id_shipment_id_pk" PRIMARY KEY("local_site_id","shipment_id"),
	CONSTRAINT "federation_media_shipment_identity" CHECK (("federation_media_shipments"."sender_site_id" <> "federation_media_shipments"."recipient_site_id" AND "federation_media_shipments"."local_site_id" IN ("federation_media_shipments"."sender_site_id","federation_media_shipments"."recipient_site_id") AND "federation_media_shipments"."version" > 0 AND "federation_media_shipments"."registration_digest" ~ '^sha256:[a-f0-9]{64}$' AND jsonb_typeof("federation_media_shipments"."packages") = 'array' AND jsonb_array_length("federation_media_shipments"."packages") BETWEEN 1 AND 100 AND "federation_media_shipments"."state" IN ('prepared','dispatched','received','returning','returned','closed','cancelled','lost','damaged')) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_media_devices" ADD CONSTRAINT "federation_media_devices_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_devices" ADD CONSTRAINT "federation_media_devices_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_devices" ADD CONSTRAINT "federation_media_devices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_handoffs" ADD CONSTRAINT "federation_media_handoffs_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_handoffs" ADD CONSTRAINT "federation_media_handoffs_local_site_id_shipment_id_federation_media_shipments_local_site_id_shipment_id_fk" FOREIGN KEY ("local_site_id","shipment_id") REFERENCES "public"."federation_media_shipments"("local_site_id","shipment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipment_devices" ADD CONSTRAINT "federation_media_shipment_devices_local_site_id_shipment_id_federation_media_shipments_local_site_id_shipment_id_fk" FOREIGN KEY ("local_site_id","shipment_id") REFERENCES "public"."federation_media_shipments"("local_site_id","shipment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipment_devices" ADD CONSTRAINT "federation_media_shipment_devices_local_site_id_device_id_federation_media_devices_local_site_id_device_id_fk" FOREIGN KEY ("local_site_id","device_id") REFERENCES "public"."federation_media_devices"("local_site_id","device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipments" ADD CONSTRAINT "federation_media_shipments_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipments" ADD CONSTRAINT "federation_media_shipments_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipments" ADD CONSTRAINT "federation_media_shipments_sender_site_id_federation_sites_id_fk" FOREIGN KEY ("sender_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipments" ADD CONSTRAINT "federation_media_shipments_recipient_site_id_federation_sites_id_fk" FOREIGN KEY ("recipient_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipments" ADD CONSTRAINT "federation_media_shipments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_media_device_tag" ON "federation_media_devices" USING btree ("local_site_id","local_org_id","asset_tag");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_media_handoff_version" ON "federation_media_handoffs" USING btree ("local_site_id","shipment_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_media_device_active_shipment" ON "federation_media_shipment_devices" USING btree ("local_site_id","device_id") WHERE "federation_media_shipment_devices"."active";--> statement-breakpoint
CREATE INDEX "federation_media_shipment_org" ON "federation_media_shipments" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));
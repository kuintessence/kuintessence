CREATE TABLE "federation_certificates" (
	"fingerprint" varchar(64) PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"certificate_pem" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "federation_certificate_interval" CHECK ("federation_certificates"."valid_from" < "federation_certificates"."valid_until"),
	CONSTRAINT "federation_certificate_fingerprint" CHECK ("federation_certificates"."fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "federation_signing_keys" (
	"site_id" uuid NOT NULL,
	"key_id" varchar(128) NOT NULL,
	"public_key_pem" text NOT NULL,
	"allowed_kinds" jsonb NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "federation_signing_keys_site_id_key_id_pk" PRIMARY KEY("site_id","key_id"),
	CONSTRAINT "federation_key_interval" CHECK ("federation_signing_keys"."valid_from" < "federation_signing_keys"."valid_until")
);
--> statement-breakpoint
CREATE TABLE "federation_sites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"endpoint" text NOT NULL,
	"state" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_site_state" CHECK ("federation_sites"."state" IN ('active', 'suspended', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "federation_certificates" ADD CONSTRAINT "federation_certificates_site_id_federation_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_signing_keys" ADD CONSTRAINT "federation_signing_keys_site_id_federation_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_certificate_site" ON "federation_certificates" USING btree ("site_id");
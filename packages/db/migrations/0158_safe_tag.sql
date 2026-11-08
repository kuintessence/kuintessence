CREATE TABLE "federation_media_key_grants" (
	"local_site_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"query_digest" varchar(71) NOT NULL,
	"response_jws" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_media_key_grants_local_site_id_query_id_pk" PRIMARY KEY("local_site_id","query_id"),
	CONSTRAINT "federation_media_key_grant_window" CHECK ("federation_media_key_grants"."expires_at" > "federation_media_key_grants"."created_at" AND "federation_media_key_grants"."expires_at" <= "federation_media_key_grants"."created_at" + interval '60 seconds'),
	CONSTRAINT "federation_media_key_grant_digest" CHECK ("federation_media_key_grants"."query_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "federation_media_key_grants" ADD CONSTRAINT "federation_media_key_grants_local_site_id_package_id_federation_media_exports_local_site_id_package_id_fk" FOREIGN KEY ("local_site_id","package_id") REFERENCES "public"."federation_media_exports"("local_site_id","package_id") ON DELETE no action ON UPDATE no action;
CREATE TABLE "federation_media_export_operations" (
	"local_site_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"state" varchar(16) NOT NULL,
	"sha256" varchar(64),
	"size_bytes" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_media_export_operations_local_site_id_package_id_pk" PRIMARY KEY("local_site_id","package_id"),
	CONSTRAINT "federation_media_export_operations_generation_unique" UNIQUE("generation"),
	CONSTRAINT "federation_media_export_operation_result" CHECK ((
      "federation_media_export_operations"."state" IN ('queued', 'exported', 'failed') AND
      (CASE WHEN "federation_media_export_operations"."state" = 'exported' THEN "federation_media_export_operations"."sha256" ~ '^[a-f0-9]{64}$' AND "federation_media_export_operations"."size_bytes" BETWEEN 1 AND 6597069766656
       ELSE "federation_media_export_operations"."sha256" IS NULL AND "federation_media_export_operations"."size_bytes" IS NULL END)
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_media_export_operations" ADD CONSTRAINT "federation_media_export_operations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_export_operations" ADD CONSTRAINT "federation_media_export_operations_local_site_id_package_id_federation_media_exports_local_site_id_package_id_fk" FOREIGN KEY ("local_site_id","package_id") REFERENCES "public"."federation_media_exports"("local_site_id","package_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_media_export_pending" ON "federation_media_export_operations" USING btree ("local_site_id","state","updated_at");
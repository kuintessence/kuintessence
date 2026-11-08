CREATE TABLE "federation_media_import_operations" (
	"authorization_id" uuid PRIMARY KEY NOT NULL,
	"generation" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"state" varchar(16) NOT NULL,
	"latest_grant" jsonb,
	"verified_bytes" bigint,
	"verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_media_import_operations_generation_unique" UNIQUE("generation"),
	CONSTRAINT "federation_media_import_operation_state" CHECK (("federation_media_import_operations"."state" IN ('queued','verified','failed') AND
    (CASE WHEN "federation_media_import_operations"."state" = 'verified' THEN "federation_media_import_operations"."verified_at" IS NOT NULL AND "federation_media_import_operations"."latest_grant" IS NOT NULL AND "federation_media_import_operations"."verified_bytes" BETWEEN 0 AND 5497558138880
     ELSE "federation_media_import_operations"."verified_at" IS NULL AND "federation_media_import_operations"."verified_bytes" IS NULL END)) IS TRUE),
	CONSTRAINT "federation_media_import_operation_binding" CHECK ("federation_media_import_operations"."latest_grant" IS NULL OR (
    "federation_media_import_operations"."latest_grant"->'binding'->>'generation' = "federation_media_import_operations"."generation"::text AND
    "federation_media_import_operations"."latest_grant"->'binding'->>'authorizationId' = "federation_media_import_operations"."authorization_id"::text) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_media_import_operations" ADD CONSTRAINT "federation_media_import_operations_authorization_id_federation_media_import_authorizations_authorization_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."federation_media_import_authorizations"("authorization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_import_operations" ADD CONSTRAINT "federation_media_import_operations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_media_import_pending" ON "federation_media_import_operations" USING btree ("state","updated_at");
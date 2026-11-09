CREATE TABLE "federation_task_media_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_input_import_id" uuid,
	"task_result_import_id" uuid,
	"authorization_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "federation_task_media_claim_direction" CHECK (num_nonnulls("federation_task_media_claims"."task_input_import_id", "federation_task_media_claims"."task_result_import_id") = 1),
	CONSTRAINT "federation_task_media_claim_time" CHECK ("federation_task_media_claims"."released_at" IS NULL OR "federation_task_media_claims"."released_at" >= "federation_task_media_claims"."claimed_at")
);
--> statement-breakpoint
ALTER TABLE "federation_task_media_claims" ADD CONSTRAINT "federation_task_media_claims_task_input_import_id_federation_input_imports_id_fk" FOREIGN KEY ("task_input_import_id") REFERENCES "public"."federation_input_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_task_media_claims" ADD CONSTRAINT "federation_task_media_claims_task_result_import_id_federation_result_imports_id_fk" FOREIGN KEY ("task_result_import_id") REFERENCES "public"."federation_result_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_task_media_claims" ADD CONSTRAINT "federation_task_media_claims_authorization_id_federation_media_import_operations_authorization_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."federation_media_import_operations"("authorization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_task_media_claim_generation" ON "federation_task_media_claims" USING btree ("authorization_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_task_media_claim_input" ON "federation_task_media_claims" USING btree ("task_input_import_id") WHERE "federation_task_media_claims"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_task_media_claim_result" ON "federation_task_media_claims" USING btree ("task_result_import_id") WHERE "federation_task_media_claims"."released_at" IS NULL;
DROP INDEX "licensed_material_mappings_lookup_idx";--> statement-breakpoint
ALTER TABLE "licensed_material_mappings" ADD COLUMN "asset_id" uuid;--> statement-breakpoint
ALTER TABLE "licensed_material_mappings" ADD COLUMN "license_subject" varchar(255);--> statement-breakpoint
ALTER TABLE "sandbox_runtime_contract_bindings" ADD COLUMN "attestation_key_id" varchar(255);--> statement-breakpoint
ALTER TABLE "sandbox_runtime_contract_bindings" ADD COLUMN "attestation_signature" text;--> statement-breakpoint
ALTER TABLE "sandbox_runtime_contract_bindings" ADD COLUMN "attested_at" timestamp;--> statement-breakpoint
ALTER TABLE "licensed_material_mappings" ADD CONSTRAINT "licensed_material_mappings_asset_id_software_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."software_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "licensed_material_mappings_lookup_idx" ON "licensed_material_mappings" USING btree ("provider_org_id","asset_id","material_name","material_version","status");
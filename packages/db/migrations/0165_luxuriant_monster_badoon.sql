ALTER TABLE "federation_dataset_use_policies" DROP CONSTRAINT "federation_dataset_use_policies_agreement_revision_id_federation_agreements_revision_id_fk";
--> statement-breakpoint
ALTER TABLE "federation_media_exports" DROP CONSTRAINT "federation_media_exports_agreement_revision_id_federation_agreements_revision_id_fk";
--> statement-breakpoint
ALTER TABLE "federation_dataset_use_policies" ADD CONSTRAINT "federation_dataset_use_approval" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_agreement_approvals"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_export_approval" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_agreement_approvals"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;
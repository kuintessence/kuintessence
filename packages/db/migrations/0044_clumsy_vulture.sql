CREATE TABLE "usecase_package_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_digest" varchar(71) NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"immutable_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ecosystem_release_assets" ADD COLUMN "manifest_entry_digest" varchar(71) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ecosystem_release_assets" ADD COLUMN "usecase_package_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "ecosystem_release_assets" ADD COLUMN "usecase_spec_digest" varchar(71);--> statement-breakpoint
ALTER TABLE "usecase_packages" ADD COLUMN "spec_digest" varchar(71);--> statement-breakpoint
ALTER TABLE "usecase_packages" ADD COLUMN "namespace" varchar(20) DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "usecase_packages" ADD COLUMN "owner_subject" varchar(255);--> statement-breakpoint
ALTER TABLE "usecase_packages" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "usecase_packages" ADD COLUMN "owner_org_id" uuid;--> statement-breakpoint
ALTER TABLE "usecase_packages" ADD COLUMN "provenance" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "usecase_packages" ADD COLUMN "immutable_at" timestamp;--> statement-breakpoint
ALTER TABLE "usecase_package_revisions" ADD CONSTRAINT "usecase_package_revisions_package_id_usecase_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."usecase_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usecase_package_revisions" ADD CONSTRAINT "usecase_package_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usecase_package_revisions_package_revision_idx" ON "usecase_package_revisions" USING btree ("package_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "usecase_package_revisions_package_digest_idx" ON "usecase_package_revisions" USING btree ("package_id","spec_digest");--> statement-breakpoint
CREATE INDEX "usecase_package_revisions_digest_idx" ON "usecase_package_revisions" USING btree ("spec_digest");--> statement-breakpoint
ALTER TABLE "ecosystem_release_assets" ADD CONSTRAINT "ecosystem_release_assets_usecase_package_revision_id_usecase_package_revisions_id_fk" FOREIGN KEY ("usecase_package_revision_id") REFERENCES "public"."usecase_package_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usecase_packages" ADD CONSTRAINT "usecase_packages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usecase_packages" ADD CONSTRAINT "usecase_packages_owner_org_id_orgs_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ecosystem_release_assets_usecase_package_revision_idx" ON "ecosystem_release_assets" USING btree ("release_id","usecase_package_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ecosystem_release_assets_manifest_entry_digest_idx" ON "ecosystem_release_assets" USING btree ("release_id","manifest_entry_digest");--> statement-breakpoint
CREATE INDEX "usecase_packages_spec_digest_idx" ON "usecase_packages" USING btree ("spec_digest");--> statement-breakpoint
CREATE INDEX "usecase_packages_owner_idx" ON "usecase_packages" USING btree ("namespace","owner_org_id","owner_user_id");--> statement-breakpoint
ALTER TABLE "usecase_packages" ADD CONSTRAINT "usecase_packages_namespace_check" CHECK ("usecase_packages"."namespace" IN ('platform', 'org', 'user'));
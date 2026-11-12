CREATE TABLE "oci_repository_blob" (
	"repository_id" uuid NOT NULL,
	"digest" varchar(80) NOT NULL,
	CONSTRAINT "oci_repository_blob_repository_id_digest_pk" PRIMARY KEY("repository_id","digest")
);
--> statement-breakpoint
CREATE TABLE "oci_repository_manifest" (
	"repository_id" uuid NOT NULL,
	"digest" varchar(80) NOT NULL,
	"explicit" boolean DEFAULT false NOT NULL,
	CONSTRAINT "oci_repository_manifest_repository_id_digest_pk" PRIMARY KEY("repository_id","digest")
);
--> statement-breakpoint
CREATE TABLE "oci_repository_scope" (
	"repository_id" uuid PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oci_repository_blob" ADD CONSTRAINT "oci_repository_blob_repository_id_oci_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."oci_repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oci_repository_blob" ADD CONSTRAINT "oci_repository_blob_digest_oci_blob_digest_fk" FOREIGN KEY ("digest") REFERENCES "public"."oci_blob"("digest") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oci_repository_manifest" ADD CONSTRAINT "oci_repository_manifest_repository_id_oci_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."oci_repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oci_repository_manifest" ADD CONSTRAINT "oci_repository_manifest_digest_oci_manifest_digest_fk" FOREIGN KEY ("digest") REFERENCES "public"."oci_manifest"("digest") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oci_repository_scope" ADD CONSTRAINT "oci_repository_scope_repository_id_oci_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."oci_repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oci_repository_blob_digest_idx" ON "oci_repository_blob" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "oci_repository_manifest_digest_idx" ON "oci_repository_manifest" USING btree ("digest");
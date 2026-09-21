CREATE TABLE "spack_material_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spec" varchar(500) NOT NULL,
	"repository_id" varchar(64) NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spack_material_bindings_spec_check" CHECK (length(trim("spack_material_bindings"."spec")) > 0),
	CONSTRAINT "spack_material_bindings_repository_check" CHECK ("spack_material_bindings"."repository_id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "spack_material_bindings_digest_check" CHECK ("spack_material_bindings"."manifest_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "spack_material_operation_references" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"requested_by" varchar(255) NOT NULL,
	"spec" varchar(500) NOT NULL,
	"repository_id" varchar(64) NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spack_material_operation_references_spec_check" CHECK (length(trim("spack_material_operation_references"."spec")) > 0),
	CONSTRAINT "spack_material_operation_references_repository_check" CHECK ("spack_material_operation_references"."repository_id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "spack_material_operation_references_digest_check" CHECK ("spack_material_operation_references"."manifest_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "spack_material_bindings_binding_idx" ON "spack_material_bindings" USING btree ("spec","repository_id","manifest_digest");--> statement-breakpoint
CREATE INDEX "spack_material_bindings_release_idx" ON "spack_material_bindings" USING btree ("repository_id","manifest_digest");--> statement-breakpoint
CREATE INDEX "spack_material_operation_references_release_idx" ON "spack_material_operation_references" USING btree ("repository_id","manifest_digest");
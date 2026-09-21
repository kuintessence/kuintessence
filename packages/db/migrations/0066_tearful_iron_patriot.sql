CREATE TABLE "spack_material_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" varchar(64) NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"revision" integer NOT NULL,
	"state" varchar(16) NOT NULL,
	"operator_id" uuid NOT NULL,
	"reason" varchar(1000) NOT NULL,
	"epoch" uuid NOT NULL,
	"rollout_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spack_material_lifecycle_events_repository_check" CHECK ("spack_material_lifecycle_events"."repository_id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "spack_material_lifecycle_events_digest_check" CHECK ("spack_material_lifecycle_events"."manifest_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "spack_material_lifecycle_events_revision_check" CHECK ("spack_material_lifecycle_events"."revision" > 0 and "spack_material_lifecycle_events"."rollout_revision" > 0),
	CONSTRAINT "spack_material_lifecycle_events_state_check" CHECK ("spack_material_lifecycle_events"."state" in ('available', 'withdrawn')),
	CONSTRAINT "spack_material_lifecycle_events_reason_check" CHECK (length(trim("spack_material_lifecycle_events"."reason")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "spack_material_lifecycle_events_release_revision_idx" ON "spack_material_lifecycle_events" USING btree ("repository_id","manifest_digest","revision");
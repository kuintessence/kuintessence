CREATE TABLE "spack_install_binding_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(36) NOT NULL,
	"spec" varchar(500) NOT NULL,
	"revision" integer NOT NULL,
	"state" varchar(16) NOT NULL,
	"repository_id" varchar(64),
	"manifest_digest" varchar(71),
	"source" varchar(16) NOT NULL,
	"operator_id" uuid,
	"reason" varchar(1000) NOT NULL,
	"epoch" uuid,
	"rollout_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spack_install_binding_events_scope_check" CHECK ("spack_install_binding_events"."scope" = 'platform' or "spack_install_binding_events"."scope" ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
	CONSTRAINT "spack_install_binding_events_revision_check" CHECK ("spack_install_binding_events"."revision" > 0),
	CONSTRAINT "spack_install_binding_events_state_check" CHECK (("spack_install_binding_events"."state" = 'disabled' and "spack_install_binding_events"."repository_id" is null and "spack_install_binding_events"."manifest_digest" is null)
        or ("spack_install_binding_events"."state" = 'enabled' and "spack_install_binding_events"."repository_id" is not null
          and "spack_install_binding_events"."repository_id" ~ '^[a-f0-9]{64}$' and "spack_install_binding_events"."manifest_digest" is not null
          and "spack_install_binding_events"."manifest_digest" ~ '^sha256:[a-f0-9]{64}$')),
	CONSTRAINT "spack_install_binding_events_source_check" CHECK (("spack_install_binding_events"."source" = 'config' and "spack_install_binding_events"."scope" = 'platform' and "spack_install_binding_events"."revision" = 1
          and "spack_install_binding_events"."state" = 'enabled' and "spack_install_binding_events"."operator_id" is null)
        or ("spack_install_binding_events"."source" = 'web' and "spack_install_binding_events"."operator_id" is not null and "spack_install_binding_events"."epoch" is not null
          and "spack_install_binding_events"."rollout_revision" is not null and "spack_install_binding_events"."rollout_revision" > 0)),
	CONSTRAINT "spack_install_binding_events_text_check" CHECK (length(trim("spack_install_binding_events"."spec")) > 0 and length(trim("spack_install_binding_events"."reason")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "spack_install_binding_events_revision_idx" ON "spack_install_binding_events" USING btree ("scope","spec","revision");
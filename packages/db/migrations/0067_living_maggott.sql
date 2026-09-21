CREATE TABLE "spack_material_visibility_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" varchar(64) NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"revision" integer NOT NULL,
	"policy" jsonb NOT NULL,
	"operator_id" uuid NOT NULL,
	"reason" varchar(1000) NOT NULL,
	"epoch" uuid NOT NULL,
	"rollout_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spack_material_visibility_events_repository_check" CHECK ("spack_material_visibility_events"."repository_id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "spack_material_visibility_events_digest_check" CHECK ("spack_material_visibility_events"."manifest_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "spack_material_visibility_events_revision_check" CHECK ("spack_material_visibility_events"."revision" > 0 and "spack_material_visibility_events"."rollout_revision" > 0),
	CONSTRAINT "spack_material_visibility_events_policy_check" CHECK (jsonb_typeof("spack_material_visibility_events"."policy") = 'object'
        and "spack_material_visibility_events"."policy"->>'mode' in ('inherit', 'allowlist')),
	CONSTRAINT "spack_material_visibility_events_reason_check" CHECK (length(trim("spack_material_visibility_events"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "spack_material_rollouts" DROP CONSTRAINT "spack_material_rollouts_transition_check";--> statement-breakpoint
CREATE UNIQUE INDEX "spack_material_visibility_events_release_revision_idx" ON "spack_material_visibility_events" USING btree ("repository_id","manifest_digest","revision");--> statement-breakpoint
ALTER TABLE "spack_material_rollouts" ADD CONSTRAINT "spack_material_rollouts_transition_check" CHECK (("spack_material_rollouts"."phase" in ('paused', 'policy-paused') and "spack_material_rollouts"."action" in ('pause', 'reconcile') and "spack_material_rollouts"."evidence" is null)
        or ("spack_material_rollouts"."phase" in ('paused', 'policy-paused') and "spack_material_rollouts"."action" = 'retire' and "spack_material_rollouts"."evidence" is not null)
        or ("spack_material_rollouts"."phase" = 'ready' and "spack_material_rollouts"."action" = 'activate' and "spack_material_rollouts"."evidence" is not null)
        or ("spack_material_rollouts"."phase" = 'policy-ready' and "spack_material_rollouts"."action" in ('activate', 'activate-policy') and "spack_material_rollouts"."evidence" is not null));
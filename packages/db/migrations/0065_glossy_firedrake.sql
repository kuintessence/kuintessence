CREATE TABLE "spack_material_binding_retirements" (
	"binding_id" uuid PRIMARY KEY NOT NULL,
	"epoch" uuid NOT NULL,
	"revision" integer NOT NULL,
	"operator_id" uuid NOT NULL,
	"reason" varchar(1000) NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spack_material_binding_retirements_revision_check" CHECK ("spack_material_binding_retirements"."revision" > 0),
	CONSTRAINT "spack_material_binding_retirements_reason_check" CHECK (length(trim("spack_material_binding_retirements"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "spack_material_rollouts" DROP CONSTRAINT "spack_material_rollouts_transition_check";--> statement-breakpoint
ALTER TABLE "spack_material_binding_retirements" ADD CONSTRAINT "spack_material_binding_retirements_binding_id_spack_material_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."spack_material_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spack_material_rollouts" ADD CONSTRAINT "spack_material_rollouts_transition_check" CHECK (("spack_material_rollouts"."phase" = 'paused' and "spack_material_rollouts"."action" in ('pause', 'reconcile') and "spack_material_rollouts"."evidence" is null)
        or ("spack_material_rollouts"."phase" = 'paused' and "spack_material_rollouts"."action" = 'retire' and "spack_material_rollouts"."evidence" is not null)
        or ("spack_material_rollouts"."phase" = 'ready' and "spack_material_rollouts"."action" = 'activate' and "spack_material_rollouts"."evidence" is not null));
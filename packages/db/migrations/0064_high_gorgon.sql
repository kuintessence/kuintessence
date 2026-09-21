CREATE TABLE "spack_material_rollouts" (
	"revision" integer PRIMARY KEY NOT NULL,
	"epoch" uuid NOT NULL,
	"phase" varchar(16) NOT NULL,
	"action" varchar(16) NOT NULL,
	"operator_id" uuid NOT NULL,
	"inventory_digest" varchar(71) NOT NULL,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spack_material_rollouts_revision_check" CHECK ("spack_material_rollouts"."revision" > 0),
	CONSTRAINT "spack_material_rollouts_transition_check" CHECK (("spack_material_rollouts"."phase" = 'paused' and "spack_material_rollouts"."action" in ('pause', 'reconcile') and "spack_material_rollouts"."evidence" is null)
        or ("spack_material_rollouts"."phase" = 'ready' and "spack_material_rollouts"."action" = 'activate' and "spack_material_rollouts"."evidence" is not null)),
	CONSTRAINT "spack_material_rollouts_digest_check" CHECK ("spack_material_rollouts"."inventory_digest" ~ '^sha256:[a-f0-9]{64}$')
);

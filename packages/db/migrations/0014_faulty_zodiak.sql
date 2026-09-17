ALTER TABLE "software_policy_overlays" ADD COLUMN "usecase_default_allow" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "software_policy_overlays" ADD COLUMN "usecase_allow_list" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "software_policy_overlays" ADD COLUMN "usecase_deny_list" jsonb DEFAULT '[]'::jsonb NOT NULL;
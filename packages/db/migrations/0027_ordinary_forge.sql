ALTER TABLE "sso_config" ADD COLUMN "provider_display_name" varchar(80) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sso_config" ADD COLUMN "login_welcome_zh" varchar(240) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sso_config" ADD COLUMN "login_welcome_en" varchar(240) DEFAULT '' NOT NULL;
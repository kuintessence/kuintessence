CREATE TABLE "platform_branding" (
	"singleton_id" varchar(16) PRIMARY KEY DEFAULT 'default' NOT NULL,
	"locales" jsonb DEFAULT '{"zh":{"name":"","title":"","subtitle":"","welcome":""},"en":{"name":"","title":"","subtitle":"","welcome":""}}'::jsonb NOT NULL,
	"logo_url" text DEFAULT '' NOT NULL,
	"favicon_url" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar(255),
	CONSTRAINT "platform_branding_singleton_check" CHECK ("platform_branding"."singleton_id" = 'default')
);

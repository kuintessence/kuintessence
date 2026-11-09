ALTER TABLE "federation_input_imports" ADD COLUMN "delivery" varchar(16) DEFAULT 'network' NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD COLUMN "delivery" varchar(16) DEFAULT 'network' NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_input_imports" ADD CONSTRAINT "federation_input_import_delivery" CHECK ("federation_input_imports"."delivery" IN ('network', 'media'));--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD CONSTRAINT "federation_result_import_delivery" CHECK ("federation_result_imports"."delivery" IN ('network', 'media'));
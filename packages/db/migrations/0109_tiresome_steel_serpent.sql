CREATE TABLE "federation_input_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"manifest" jsonb NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_input_import_digest" CHECK ("federation_input_imports"."manifest_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "federation_input_import_state" CHECK ("federation_input_imports"."state" IN ('pending', 'cancelled')),
	CONSTRAINT "federation_input_import_quota" CHECK ("federation_input_imports"."reserved_bytes" BETWEEN 0 AND 9007199254740991 AND ("federation_input_imports"."state" != 'cancelled' OR "federation_input_imports"."reserved_bytes" = 0))
);
--> statement-breakpoint
ALTER TABLE "federation_input_imports" ADD CONSTRAINT "federation_input_imports_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_input_imports" ADD CONSTRAINT "federation_input_imports_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_input_imports" ADD CONSTRAINT "federation_input_imports_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_input_import_reservation" ON "federation_input_imports" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "federation_input_import_pending" ON "federation_input_imports" USING btree ("local_site_id","next_check_at") WHERE "federation_input_imports"."state" = 'pending';
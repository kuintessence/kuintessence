CREATE TABLE "federation_preparations" (
	"reservation_id" uuid PRIMARY KEY NOT NULL,
	"state" varchar(16) NOT NULL,
	"blocker" varchar(64),
	"mappings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_preparation_state" CHECK (("federation_preparations"."state" = 'resolved' AND "federation_preparations"."blocker" IS NULL) OR ("federation_preparations"."state" IN ('waiting', 'blocked') AND "federation_preparations"."blocker" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "federation_preparations" ADD CONSTRAINT "federation_preparations_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;
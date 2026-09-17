ALTER TABLE "software_operations" DROP CONSTRAINT "software_operations_requested_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "software_operations" ALTER COLUMN "requested_by" SET DATA TYPE varchar(255);
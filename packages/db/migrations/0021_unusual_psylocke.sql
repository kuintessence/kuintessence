ALTER TABLE "file_transfers" ADD COLUMN "cluster_root_id" uuid;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD COLUMN "cluster_root_revision" timestamp;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD COLUMN "root_policy_changed_at" timestamp;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_cluster_root_id_cluster_file_roots_id_fk" FOREIGN KEY ("cluster_root_id") REFERENCES "public"."cluster_file_roots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_transfers_cluster_root_state_idx" ON "file_transfers" USING btree ("cluster_root_id","state");
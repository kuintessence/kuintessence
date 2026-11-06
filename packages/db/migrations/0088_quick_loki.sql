CREATE TABLE "workflow_artifact_files" (
	"artifact_id" uuid NOT NULL,
	"relative_path" varchar(255) NOT NULL,
	"netdrive_file_id" uuid,
	CONSTRAINT "workflow_artifact_files_artifact_id_relative_path_pk" PRIMARY KEY("artifact_id","relative_path")
);
--> statement-breakpoint
ALTER TABLE "workflow_artifacts" ADD COLUMN "file_members" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_artifact_files" ADD CONSTRAINT "workflow_artifact_files_artifact_id_workflow_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."workflow_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_artifact_files" ADD CONSTRAINT "workflow_artifact_files_netdrive_file_id_netdrive_files_id_fk" FOREIGN KEY ("netdrive_file_id") REFERENCES "public"."netdrive_files"("id") ON DELETE set null ON UPDATE no action;
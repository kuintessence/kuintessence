ALTER TABLE "federation_task_media_claims" ADD COLUMN "upload_grant_token" uuid;--> statement-breakpoint
ALTER TABLE "federation_task_media_claims" ADD COLUMN "upload_grant" jsonb;--> statement-breakpoint
ALTER TABLE "federation_task_media_claims" ADD CONSTRAINT "federation_task_media_upload_grant" CHECK ("federation_task_media_claims"."upload_grant" IS NULL OR ("federation_task_media_claims"."upload_grant_token" IS NOT NULL AND
        "federation_task_media_claims"."upload_grant"->'binding'->>'authorizationId' = "federation_task_media_claims"."authorization_id"::text AND
        "federation_task_media_claims"."upload_grant"->'binding'->>'generation' = "federation_task_media_claims"."generation"::text) IS TRUE);
ALTER TABLE "federation_media_exports" ALTER COLUMN "version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD COLUMN "task_selection" jsonb;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_export_selector" CHECK (((
        "federation_media_exports"."manifest"->'subject'->>'kind' = 'dataset'
        AND "federation_media_exports"."version_id" IS NOT NULL AND "federation_media_exports"."location_id" IS NOT NULL
        AND "federation_media_exports"."task_selection" IS NULL
        AND NOT ("federation_media_exports"."source" ? 'objects')
      ) OR (
        "federation_media_exports"."version_id" IS NULL AND "federation_media_exports"."location_id" IS NULL
        AND "federation_media_exports"."task_selection"->>'kind' IN ('task-input', 'task-result')
        AND "federation_media_exports"."task_selection"->>'kind' = "federation_media_exports"."manifest"->'subject'->>'kind'
        AND "federation_media_exports"."task_selection"->>'operationId' = "federation_media_exports"."manifest"->'subject'->>'operationId'
        AND "federation_media_exports"."task_selection"->>'agentId' = "federation_media_exports"."source"->>'agentId'
        AND jsonb_typeof("federation_media_exports"."source"->'objects') = 'array'
        AND NOT ("federation_media_exports"."source" ?| array['managedRootId', 'relativePath'])
      )) IS TRUE);
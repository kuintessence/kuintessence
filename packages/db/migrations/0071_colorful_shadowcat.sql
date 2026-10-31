CREATE TABLE "compute_centers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"metadata" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compute_cluster_agents" (
	"agent_id" varchar(255) PRIMARY KEY NOT NULL,
	"cluster_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compute_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"center_id" uuid NOT NULL,
	"metadata" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compute_interconnects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_center_id" uuid NOT NULL,
	"to_center_id" uuid NOT NULL,
	"metadata" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "compute_interconnects_different_ends" CHECK ("compute_interconnects"."from_center_id" <> "compute_interconnects"."to_center_id")
);
--> statement-breakpoint
CREATE TABLE "interconnect_map_views" (
	"user_id" uuid NOT NULL,
	"scope" varchar(512) NOT NULL,
	"view" jsonb NOT NULL,
	CONSTRAINT "interconnect_map_views_user_id_scope_pk" PRIMARY KEY("user_id","scope")
);
--> statement-breakpoint
ALTER TABLE "compute_centers" ADD CONSTRAINT "compute_centers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_cluster_agents" ADD CONSTRAINT "compute_cluster_agents_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_cluster_agents" ADD CONSTRAINT "compute_cluster_agents_cluster_id_compute_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."compute_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_clusters" ADD CONSTRAINT "compute_clusters_center_id_compute_centers_id_fk" FOREIGN KEY ("center_id") REFERENCES "public"."compute_centers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_interconnects" ADD CONSTRAINT "compute_interconnects_from_center_id_compute_centers_id_fk" FOREIGN KEY ("from_center_id") REFERENCES "public"."compute_centers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_interconnects" ADD CONSTRAINT "compute_interconnects_to_center_id_compute_centers_id_fk" FOREIGN KEY ("to_center_id") REFERENCES "public"."compute_centers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interconnect_map_views" ADD CONSTRAINT "interconnect_map_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compute_centers_org_idx" ON "compute_centers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "compute_clusters_center_idx" ON "compute_clusters" USING btree ("center_id");
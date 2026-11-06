CREATE TABLE "federation_agreement_approvals" (
	"local_site_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"execution_user_id" uuid,
	"terms" jsonb NOT NULL,
	"terms_digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_approval_jws" text,
	"approved_by" uuid NOT NULL,
	"state" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_agreement_approvals_local_site_id_revision_id_pk" PRIMARY KEY("local_site_id","revision_id"),
	CONSTRAINT "federation_approval_state" CHECK ("federation_agreement_approvals"."state" IN ('active', 'suspended', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "federation_capabilities" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"capability" varchar(32) NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_capabilities_org_id_user_id_capability_pk" PRIMARY KEY("org_id","user_id","capability"),
	CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve'))
);
--> statement-breakpoint
ALTER TABLE "federation_agreement_approvals" ADD CONSTRAINT "federation_agreement_approvals_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_agreement_approvals" ADD CONSTRAINT "federation_agreement_approvals_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_agreement_approvals" ADD CONSTRAINT "federation_agreement_approvals_execution_user_id_users_id_fk" FOREIGN KEY ("execution_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_agreement_approvals" ADD CONSTRAINT "federation_agreement_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capabilities_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capabilities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capabilities_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_approval_org" ON "federation_agreement_approvals" USING btree ("local_org_id","created_at");
CREATE TABLE "federation_disclosure_downloads" (
	"local_site_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"read_id" uuid NOT NULL,
	"part" varchar(24) NOT NULL,
	"request_digest" varchar(71) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_disclosure_downloads_local_site_id_query_id_pk" PRIMARY KEY("local_site_id","query_id"),
	CONSTRAINT "federation_disclosure_download_part" CHECK ("federation_disclosure_downloads"."part" IN ('policy-source','policy-target','disclosure-source','disclosure-target'))
);
--> statement-breakpoint
CREATE TABLE "federation_evidence_cases" (
	"local_site_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"context" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_evidence_cases_local_site_id_case_id_pk" PRIMARY KEY("local_site_id","case_id"),
	CONSTRAINT "federation_evidence_case_identity" CHECK (("federation_evidence_cases"."context"->>'caseId' = "federation_evidence_cases"."case_id"::text AND "federation_evidence_cases"."context"->>'evidenceRecipientSiteId' = "federation_evidence_cases"."local_site_id"::text) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_received_disclosures" (
	"local_site_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"received_by" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_received_disclosures_local_site_id_grant_id_pk" PRIMARY KEY("local_site_id","grant_id"),
	CONSTRAINT "federation_received_disclosure_identity" CHECK (("federation_received_disclosures"."scope"->>'caseId' = "federation_received_disclosures"."case_id"::text AND "federation_received_disclosures"."scope"->>'grantId' = "federation_received_disclosures"."grant_id"::text AND "federation_received_disclosures"."scope"->>'evidenceRecipientSiteId' = "federation_received_disclosures"."local_site_id"::text) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_disclosure_downloads" ADD CONSTRAINT "federation_disclosure_download_grant_fk" FOREIGN KEY ("local_site_id","grant_id") REFERENCES "public"."federation_disclosures"("local_site_id","grant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence_cases" ADD CONSTRAINT "federation_evidence_cases_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence_cases" ADD CONSTRAINT "federation_evidence_cases_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence_cases" ADD CONSTRAINT "federation_evidence_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_received_disclosures" ADD CONSTRAINT "federation_received_disclosures_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_received_disclosures" ADD CONSTRAINT "federation_received_disclosure_case_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_evidence_cases"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'payment.approve', 'disclosure.approve', 'disclosure.receive', 'dispute.read', 'dispute.open', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));
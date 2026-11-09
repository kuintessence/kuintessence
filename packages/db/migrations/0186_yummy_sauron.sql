CREATE TABLE "federation_disclosure_read_authorizations" (
	"local_site_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"query" jsonb NOT NULL,
	"query_digest" varchar(71) NOT NULL,
	"response_jws" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_disclosure_read_authorizations_local_site_id_query_id_pk" PRIMARY KEY("local_site_id","query_id"),
	CONSTRAINT "federation_disclosure_read_identity" CHECK (("federation_disclosure_read_authorizations"."query"->>'kind' = 'commercial-disclosure-read-query'
    AND "federation_disclosure_read_authorizations"."query"->>'recipientSiteId' = "federation_disclosure_read_authorizations"."local_site_id"::text AND "federation_disclosure_read_authorizations"."query"->>'queryId' = "federation_disclosure_read_authorizations"."query_id"::text
    AND "federation_disclosure_read_authorizations"."query"->'scope'->>'grantId' = "federation_disclosure_read_authorizations"."grant_id"::text) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_disclosure_read_authorizations" ADD CONSTRAINT "federation_disclosure_read_grant_fk" FOREIGN KEY ("local_site_id","grant_id") REFERENCES "public"."federation_disclosures"("local_site_id","grant_id") ON DELETE no action ON UPDATE no action;
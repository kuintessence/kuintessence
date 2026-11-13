CREATE TABLE "workflow_artifact_files" (
	"artifact_id" uuid NOT NULL,
	"relative_path" varchar(255) NOT NULL,
	"netdrive_file_id" uuid,
	CONSTRAINT "workflow_artifact_files_artifact_id_relative_path_pk" PRIMARY KEY("artifact_id","relative_path")
);
--> statement-breakpoint
CREATE TABLE "federation_accounting_collections" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"request_id" uuid,
	"issued_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" varchar(64),
	"observation" jsonb,
	"digest" varchar(71),
	CONSTRAINT "federation_accounting_state" CHECK ("federation_accounting_collections"."state" IN ('pending','collected','needs_review')),
	CONSTRAINT "federation_accounting_observation" CHECK (("federation_accounting_collections"."state" = 'collected') = ("federation_accounting_collections"."observation" IS NOT NULL AND "federation_accounting_collections"."digest" IS NOT NULL)),
	CONSTRAINT "federation_accounting_digest" CHECK ("federation_accounting_collections"."digest" IS NULL OR "federation_accounting_collections"."digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
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
CREATE TABLE "federation_agreement_syncs" (
	"local_site_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "federation_agreement_syncs_local_site_id_revision_id_pk" PRIMARY KEY("local_site_id","revision_id"),
	CONSTRAINT "federation_agreement_sync_state" CHECK ("federation_agreement_syncs"."state" IN ('pending','complete','needs_review')),
	CONSTRAINT "federation_agreement_sync_lease" CHECK (("federation_agreement_syncs"."lease_token" IS NULL) = ("federation_agreement_syncs"."lease_until" IS NULL)),
	CONSTRAINT "federation_agreement_sync_receipt" CHECK (("federation_agreement_syncs"."state" = 'complete') = ("federation_agreement_syncs"."verified_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_agreements" (
	"revision_id" uuid PRIMARY KEY NOT NULL,
	"source_site_id" uuid NOT NULL,
	"target_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"execution_user_id" uuid NOT NULL,
	"budget_domain_id" uuid,
	"epoch" uuid,
	"terms" jsonb NOT NULL,
	"terms_digest" varchar(71) NOT NULL,
	"source_approval_jws" text NOT NULL,
	"target_approval_jws" text NOT NULL,
	"state" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_agreement_budget_backing" CHECK (((("federation_agreements"."terms"->>'mode' IN ('bilateral_direct', 'bilateral_attested'))
        AND "federation_agreements"."budget_domain_id" IS NOT NULL AND "federation_agreements"."epoch" IS NOT NULL
        AND "federation_agreements"."budget_domain_id" = ("federation_agreements"."terms"->>'budgetDomainId')::uuid
        AND "federation_agreements"."epoch" = ("federation_agreements"."terms"->>'epoch')::uuid)
        OR ("federation_agreements"."terms"->>'mode' = 'ledger_coordinated'
        AND "federation_agreements"."budget_domain_id" IS NULL AND "federation_agreements"."epoch" IS NULL)) IS TRUE),
	CONSTRAINT "federation_agreement_state" CHECK ("federation_agreements"."state" IN ('active', 'suspended', 'revoked')),
	CONSTRAINT "federation_agreement_sites" CHECK ("federation_agreements"."source_site_id" <> "federation_agreements"."target_site_id")
);
--> statement-breakpoint
CREATE TABLE "federation_arbitration_decision_deliveries" (
	"local_site_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"receiving_site_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"receipt_jws" text,
	"acknowledged_at" timestamp with time zone,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arb_decision_delivery_pk" PRIMARY KEY("local_site_id","decision_id","receiving_site_id"),
	CONSTRAINT "federation_arbitration_decision_deliveries_delivery_id_unique" UNIQUE("delivery_id"),
	CONSTRAINT "arb_decision_delivery_state" CHECK ("federation_arbitration_decision_deliveries"."state" IN ('pending','received','needs_review') AND ("federation_arbitration_decision_deliveries"."state" = 'received') = ("federation_arbitration_decision_deliveries"."receipt_jws" IS NOT NULL AND "federation_arbitration_decision_deliveries"."acknowledged_at" IS NOT NULL)),
	CONSTRAINT "arb_decision_delivery_lease" CHECK (("federation_arbitration_decision_deliveries"."lease_token" IS NULL) = ("federation_arbitration_decision_deliveries"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_arbitration_decisions" (
	"local_site_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text NOT NULL,
	"approval_jws" text NOT NULL,
	"basis" jsonb NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_arbitration_decisions_local_site_id_decision_id_pk" PRIMARY KEY("local_site_id","decision_id"),
	CONSTRAINT "federation_arbitration_decision_identity" CHECK (("federation_arbitration_decisions"."payload"->'intent'->>'decisionId' = "federation_arbitration_decisions"."decision_id"::text AND "federation_arbitration_decisions"."payload"->'intent'->'binding'->>'caseId' = "federation_arbitration_decisions"."case_id"::text AND "federation_arbitration_decisions"."payload"->'intent'->'binding'->>'arbitratorSiteId' = "federation_arbitration_decisions"."local_site_id"::text) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_arbitration_policies" (
	"local_site_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"arbitrator_site_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revocation_payload" jsonb,
	"revocation_jws" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_arbitration_policies_local_site_id_policy_id_pk" PRIMARY KEY("local_site_id","policy_id"),
	CONSTRAINT "federation_arbitration_policy_identity" CHECK ((
      "federation_arbitration_policies"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_arbitration_policies"."payload"->>'kind' = 'commercial-arbitration-policy'
      AND "federation_arbitration_policies"."payload"->>'policyId' = "federation_arbitration_policies"."policy_id"::text
      AND "federation_arbitration_policies"."payload"->>'agreementRevisionId' = "federation_arbitration_policies"."agreement_revision_id"::text
      AND "federation_arbitration_policies"."payload"->>'arbitratorSiteId' = "federation_arbitration_policies"."arbitrator_site_id"::text
      AND ("federation_arbitration_policies"."payload"->>'sourceSiteId' = "federation_arbitration_policies"."local_site_id"::text OR "federation_arbitration_policies"."payload"->>'targetSiteId' = "federation_arbitration_policies"."local_site_id"::text)
      AND "federation_arbitration_policies"."payload"->>'sourceSiteId' <> "federation_arbitration_policies"."payload"->>'targetSiteId'
      AND "federation_arbitration_policies"."arbitrator_site_id"::text NOT IN ("federation_arbitration_policies"."payload"->>'sourceSiteId', "federation_arbitration_policies"."payload"->>'targetSiteId')
      AND ("federation_arbitration_policies"."counterparty_jws" IS NULL) = ("federation_arbitration_policies"."confirmed_at" IS NULL)
      AND ("federation_arbitration_policies"."revoked_at" IS NULL) = ("federation_arbitration_policies"."revoked_by" IS NULL)
      AND ("federation_arbitration_policies"."revocation_payload" IS NULL) = ("federation_arbitration_policies"."revocation_jws" IS NULL)
      AND ("federation_arbitration_policies"."revocation_payload" IS NULL OR ("federation_arbitration_policies"."revoked_at" IS NOT NULL
        AND "federation_arbitration_policies"."revocation_payload"->>'policyId' = "federation_arbitration_policies"."policy_id"::text
        AND "federation_arbitration_policies"."revocation_payload"->>'policyDigest' = "federation_arbitration_policies"."digest"
        AND "federation_arbitration_policies"."revocation_payload"->>'issuerSiteId' = "federation_arbitration_policies"."local_site_id"::text))
    ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_arbitration_resolutions" (
	"local_site_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"envelope" jsonb NOT NULL,
	"initiated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"commitment" jsonb,
	"commitment_jws" text,
	"counterparty_commitment" jsonb,
	"counterparty_commitment_jws" text,
	"execution_receipt" jsonb,
	"execution_receipt_jws" text,
	"held_amount" numeric(38, 0) DEFAULT '0' NOT NULL,
	"withdrawal_requested_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "arb_resolution_pk" PRIMARY KEY("local_site_id","decision_id"),
	CONSTRAINT "arb_resolution_withdrawal_request" CHECK (("federation_arbitration_resolutions"."withdrawal_requested_at" IS NULL OR (
        "federation_arbitration_resolutions"."commitment" IS NOT NULL AND "federation_arbitration_resolutions"."payload"->>'mode' IN ('bilateral_direct','bilateral_attested')
        AND "federation_arbitration_resolutions"."payload"->'outcome'->>'action' IN ('settle','adjust')
      )) IS TRUE),
	CONSTRAINT "arb_resolution_commitment" CHECK ((
      ("federation_arbitration_resolutions"."commitment" IS NULL) = ("federation_arbitration_resolutions"."commitment_jws" IS NULL)
      AND ("federation_arbitration_resolutions"."counterparty_commitment" IS NULL) = ("federation_arbitration_resolutions"."counterparty_commitment_jws" IS NULL)
      AND ("federation_arbitration_resolutions"."execution_receipt" IS NULL) = ("federation_arbitration_resolutions"."execution_receipt_jws" IS NULL)
      AND "federation_arbitration_resolutions"."held_amount" >= 0
      AND (("federation_arbitration_resolutions"."payload"->>'mode' = 'ledger_coordinated' OR "federation_arbitration_resolutions"."payload"->'outcome'->>'action' = 'resolve-without-financial-change')
        OR ("federation_arbitration_resolutions"."commitment" IS NOT NULL AND ("federation_arbitration_resolutions"."applied_at" IS NULL OR "federation_arbitration_resolutions"."execution_receipt" IS NOT NULL)))
    ) IS TRUE),
	CONSTRAINT "arb_resolution_identity" CHECK (("federation_arbitration_resolutions"."payload"->>'decisionId' = "federation_arbitration_resolutions"."decision_id"::text AND "federation_arbitration_resolutions"."payload"->>'caseId' = "federation_arbitration_resolutions"."case_id"::text
    AND "federation_arbitration_resolutions"."payload"->>'agreementRevisionId' = "federation_arbitration_resolutions"."agreement_revision_id"::text
    AND ("federation_arbitration_resolutions"."payload"->>'sourceSiteId' = "federation_arbitration_resolutions"."local_site_id"::text OR "federation_arbitration_resolutions"."payload"->>'targetSiteId' = "federation_arbitration_resolutions"."local_site_id"::text)
    AND ("federation_arbitration_resolutions"."payload"->'outcome'->>'action' = 'resolve-without-financial-change'
      OR "federation_arbitration_resolutions"."payload"->'outcome'->>'action' IN ('settle', 'adjust'))) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_arbitration_revocation_deliveries" (
	"local_site_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"receiving_site_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"notice_jws" text,
	"receipt_jws" text,
	"acknowledged_at" timestamp with time zone,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arb_revocation_delivery_pk" PRIMARY KEY("local_site_id","policy_id","receiving_site_id"),
	CONSTRAINT "arb_revocation_delivery_state" CHECK ("federation_arbitration_revocation_deliveries"."local_site_id" <> "federation_arbitration_revocation_deliveries"."receiving_site_id"
    AND "federation_arbitration_revocation_deliveries"."state" IN ('pending','received','needs_review') AND ("federation_arbitration_revocation_deliveries"."state" = 'received') = ("federation_arbitration_revocation_deliveries"."receipt_jws" IS NOT NULL)
    AND ("federation_arbitration_revocation_deliveries"."receipt_jws" IS NULL) = ("federation_arbitration_revocation_deliveries"."acknowledged_at" IS NULL) AND ("federation_arbitration_revocation_deliveries"."payload" IS NULL) = ("federation_arbitration_revocation_deliveries"."notice_jws" IS NULL)
    AND ("federation_arbitration_revocation_deliveries"."lease_token" IS NULL) = ("federation_arbitration_revocation_deliveries"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_arbitration_revocation_notices" (
	"local_site_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_digest" varchar(71) NOT NULL,
	"issuer_site_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"notice_digest" varchar(71) NOT NULL,
	"revocation_digest" varchar(71) NOT NULL,
	"payload" jsonb NOT NULL,
	"notice_jws" text NOT NULL,
	"receipt_jws" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arb_revocation_notice_pk" PRIMARY KEY("local_site_id","policy_id","policy_digest","issuer_site_id"),
	CONSTRAINT "arb_revocation_notice_identity" CHECK (("federation_arbitration_revocation_notices"."local_site_id" <> "federation_arbitration_revocation_notices"."issuer_site_id"
    AND "federation_arbitration_revocation_notices"."policy_digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_arbitration_revocation_notices"."notice_digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_arbitration_revocation_notices"."revocation_digest" ~ '^sha256:[a-f0-9]{64}$'
    AND "federation_arbitration_revocation_notices"."payload"->>'kind' = 'arbitration-revocation-notice' AND "federation_arbitration_revocation_notices"."payload"->>'noticeId' = "federation_arbitration_revocation_notices"."notice_id"::text
    AND "federation_arbitration_revocation_notices"."payload"->>'issuerSiteId' = "federation_arbitration_revocation_notices"."issuer_site_id"::text AND "federation_arbitration_revocation_notices"."payload"->>'receivingSiteId' = "federation_arbitration_revocation_notices"."local_site_id"::text
    AND "federation_arbitration_revocation_notices"."payload"->'policy'->>'policyId' = "federation_arbitration_revocation_notices"."policy_id"::text) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_asset_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_org_id" uuid NOT NULL,
	"origin_site_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"origin_id" uuid NOT NULL,
	"origin_revision" varchar(128) NOT NULL,
	"digest" varchar(71) NOT NULL,
	"software_revision_id" uuid,
	"data_version_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "federation_asset_digest" CHECK ("federation_asset_mappings"."digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "federation_asset_target" CHECK (("federation_asset_mappings"."kind" = 'dataset' AND "federation_asset_mappings"."data_version_id" IS NOT NULL AND "federation_asset_mappings"."software_revision_id" IS NULL)
    OR ("federation_asset_mappings"."kind" IN ('workflow', 'script', 'software', 'usecase') AND "federation_asset_mappings"."software_revision_id" IS NOT NULL AND "federation_asset_mappings"."data_version_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_attestation_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"transaction_id" varchar(64) NOT NULL,
	"recovery" text NOT NULL,
	"stage" varchar(24) DEFAULT 'proposal' NOT NULL,
	"validation_code" integer,
	"block_number" numeric(20, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_attestation_attempt" CHECK ("federation_attestation_attempts"."number" > 0 AND "federation_attestation_attempts"."transaction_id" ~ '^[a-f0-9]{64}$' AND octet_length("federation_attestation_attempts"."recovery") BETWEEN 1 AND 4194304),
	CONSTRAINT "federation_attestation_result" CHECK ((("federation_attestation_attempts"."stage" IN ('proposal','transaction','abandoned') AND "federation_attestation_attempts"."validation_code" IS NULL AND "federation_attestation_attempts"."block_number" IS NULL) OR ("federation_attestation_attempts"."stage" = 'anchored' AND "federation_attestation_attempts"."validation_code" = 0 AND "federation_attestation_attempts"."block_number" >= 0) OR ("federation_attestation_attempts"."stage" = 'invalid' AND "federation_attestation_attempts"."validation_code" BETWEEN 1 AND 255 AND "federation_attestation_attempts"."block_number" >= 0)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_attestation_outbox" (
	"evidence_id" uuid PRIMARY KEY NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"batch_id" uuid,
	"sequence" numeric(20, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_attestation_state" CHECK ((("federation_attestation_outbox"."state" = 'pending' AND "federation_attestation_outbox"."batch_id" IS NULL AND "federation_attestation_outbox"."sequence" IS NULL) OR ("federation_attestation_outbox"."state" IN ('batched','anchored') AND "federation_attestation_outbox"."batch_id" IS NOT NULL AND "federation_attestation_outbox"."sequence" > 0)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_budgets" (
	"domain_id" uuid NOT NULL,
	"epoch" uuid NOT NULL,
	"unit" varchar(64) NOT NULL,
	"limit" numeric(38, 0) NOT NULL,
	"available" numeric(38, 0) NOT NULL,
	"reserved" numeric(38, 0) DEFAULT '0' NOT NULL,
	"spent" numeric(38, 0) DEFAULT '0' NOT NULL,
	CONSTRAINT "federation_budgets_domain_id_epoch_pk" PRIMARY KEY("domain_id","epoch"),
	CONSTRAINT "federation_budget_conservation" CHECK ("federation_budgets"."limit"::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND "federation_budgets"."available"::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND "federation_budgets"."reserved"::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND "federation_budgets"."spent"::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND "federation_budgets"."limit" = "federation_budgets"."available" + "federation_budgets"."reserved" + "federation_budgets"."spent")
);
--> statement-breakpoint
CREATE TABLE "federation_cancellations" (
	"local_site_id" uuid NOT NULL,
	"sender_site_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"request_digest" varchar(71) NOT NULL,
	"cancellation_digest" varchar(71) NOT NULL,
	"request" jsonb NOT NULL,
	"request_jws" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_cancellations_local_site_id_sender_site_id_operation_id_pk" PRIMARY KEY("local_site_id","sender_site_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "federation_capabilities" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"capability" varchar(32) NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_capabilities_org_id_user_id_capability_pk" PRIMARY KEY("org_id","user_id","capability"),
	CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'payment.approve', 'arbitration.approve', 'arbitration.read', 'arbitration.decide', 'arbitration.execute', 'disclosure.approve', 'disclosure.receive', 'case.publish', 'dispute.read', 'dispute.open', 'dispute.resolve', 'attestation.recover', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'))
);
--> statement-breakpoint
CREATE TABLE "federation_case_arbitration_decisions" (
	"local_site_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text NOT NULL,
	"approval_jws" text NOT NULL,
	"submission_jws" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_case_arbitration_decisions_local_site_id_decision_id_pk" PRIMARY KEY("local_site_id","decision_id"),
	CONSTRAINT "federation_case_decision_identity" CHECK (("federation_case_arbitration_decisions"."digest" ~ '^sha256:[a-f0-9]{64}$'
    AND "federation_case_arbitration_decisions"."payload"->>'kind' = 'case-arbitration-decision'
    AND "federation_case_arbitration_decisions"."payload"->>'decisionId' = "federation_case_arbitration_decisions"."decision_id"::text
    AND "federation_case_arbitration_decisions"."payload"->'binding'->>'caseId' = "federation_case_arbitration_decisions"."case_id"::text
    AND "federation_case_arbitration_decisions"."payload"->'binding'->>'arbitratorSiteId' = "federation_case_arbitration_decisions"."local_site_id"::text) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_case_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"transaction_id" varchar(64) NOT NULL,
	"recovery" text NOT NULL,
	"stage" varchar(24) DEFAULT 'proposal' NOT NULL,
	"dispatch_authorized_at" timestamp with time zone,
	"validation_code" integer,
	"block_number" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_case_attempt_state" CHECK (("federation_case_attempts"."number" > 0 AND "federation_case_attempts"."transaction_id" ~ '^[a-f0-9]{64}$'
    AND "federation_case_attempts"."stage" IN ('proposal','transaction','committed','invalid','abandoned')
    AND ("federation_case_attempts"."dispatch_authorized_at" IS NULL OR "federation_case_attempts"."stage" IN ('transaction','committed','invalid'))
    AND (("federation_case_attempts"."stage" IN ('committed','invalid')) = ("federation_case_attempts"."validation_code" IS NOT NULL))
    AND (("federation_case_attempts"."stage" IN ('committed','invalid')) = ("federation_case_attempts"."block_number" IS NOT NULL))
    AND ("federation_case_attempts"."stage" <> 'committed' OR "federation_case_attempts"."validation_code" = 0)
    AND ("federation_case_attempts"."stage" <> 'invalid' OR "federation_case_attempts"."validation_code" BETWEEN 1 AND 255)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_case_publications" (
	"local_site_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revocation_payload" jsonb,
	"revocation_jws" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_case_publications_local_site_id_publication_id_pk" PRIMARY KEY("local_site_id","publication_id"),
	CONSTRAINT "federation_case_publication_identity" CHECK ((
      "federation_case_publications"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_case_publications"."payload"->>'kind' = 'case-evidence-publication'
      AND "federation_case_publications"."payload"->>'publicationId' = "federation_case_publications"."publication_id"::text
      AND "federation_case_publications"."payload"->'scope'->>'agreementRevisionId' = "federation_case_publications"."agreement_revision_id"::text
      AND "federation_case_publications"."payload"->'scope'->>'grantId' = "federation_case_publications"."grant_id"::text
      AND "federation_case_publications"."payload"->'scope'->>'caseId' = "federation_case_publications"."case_id"::text
      AND "federation_case_publications"."local_site_id"::text IN ("federation_case_publications"."payload"->'scope'->>'sourceSiteId', "federation_case_publications"."payload"->'scope'->>'targetSiteId')
      AND ("federation_case_publications"."counterparty_jws" IS NULL) = ("federation_case_publications"."confirmed_at" IS NULL)
      AND ("federation_case_publications"."revoked_at" IS NULL) = ("federation_case_publications"."revoked_by" IS NULL)
      AND ("federation_case_publications"."revoked_at" IS NULL) = ("federation_case_publications"."revocation_payload" IS NULL)
      AND ("federation_case_publications"."revoked_at" IS NULL) = ("federation_case_publications"."revocation_jws" IS NULL)
      AND ("federation_case_publications"."revocation_payload" IS NULL OR (
        "federation_case_publications"."revocation_payload"->>'kind' = 'case-publication-revocation'
        AND "federation_case_publications"."revocation_payload"->>'publicationId' = "federation_case_publications"."publication_id"::text
        AND "federation_case_publications"."revocation_payload"->>'publicationDigest' = "federation_case_publications"."digest"
        AND "federation_case_publications"."revocation_payload"->>'caseDomainId' = "federation_case_publications"."payload"->>'caseDomainId'
        AND "federation_case_publications"."revocation_payload"->>'issuerSiteId' = "federation_case_publications"."local_site_id"::text
      ))
    ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_case_revocation_deliveries" (
	"local_site_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"receiving_site_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"notice_jws" text,
	"receipt_jws" text,
	"acknowledged_at" timestamp with time zone,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_case_revocation_deliveries_local_site_id_publication_id_receiving_site_id_pk" PRIMARY KEY("local_site_id","publication_id","receiving_site_id"),
	CONSTRAINT "federation_case_revocation_delivery_state" CHECK ("federation_case_revocation_deliveries"."local_site_id" <> "federation_case_revocation_deliveries"."receiving_site_id"
    AND "federation_case_revocation_deliveries"."state" IN ('pending','received','needs_review') AND ("federation_case_revocation_deliveries"."state" = 'received') = ("federation_case_revocation_deliveries"."receipt_jws" IS NOT NULL)
    AND ("federation_case_revocation_deliveries"."receipt_jws" IS NULL) = ("federation_case_revocation_deliveries"."acknowledged_at" IS NULL) AND ("federation_case_revocation_deliveries"."payload" IS NULL) = ("federation_case_revocation_deliveries"."notice_jws" IS NULL)
    AND ("federation_case_revocation_deliveries"."lease_token" IS NULL) = ("federation_case_revocation_deliveries"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_case_revocation_notices" (
	"local_site_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"issuer_site_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"publication_digest" varchar(71) NOT NULL,
	"notice_digest" varchar(71) NOT NULL,
	"revocation_digest" varchar(71) NOT NULL,
	"payload" jsonb NOT NULL,
	"notice_jws" text NOT NULL,
	"receipt_jws" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_case_revocation_notices_local_site_id_publication_id_issuer_site_id_pk" PRIMARY KEY("local_site_id","publication_id","issuer_site_id"),
	CONSTRAINT "federation_case_revocation_notice_identity" CHECK (("federation_case_revocation_notices"."local_site_id" <> "federation_case_revocation_notices"."issuer_site_id"
    AND "federation_case_revocation_notices"."publication_digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_case_revocation_notices"."notice_digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_case_revocation_notices"."revocation_digest" ~ '^sha256:[a-f0-9]{64}$'
    AND "federation_case_revocation_notices"."payload"->>'kind' = 'case-revocation-notice' AND "federation_case_revocation_notices"."payload"->>'noticeId' = "federation_case_revocation_notices"."notice_id"::text
    AND "federation_case_revocation_notices"."payload"->>'issuerSiteId' = "federation_case_revocation_notices"."issuer_site_id"::text AND "federation_case_revocation_notices"."payload"->>'receivingSiteId' = "federation_case_revocation_notices"."local_site_id"::text
    AND "federation_case_revocation_notices"."payload"->'publication'->>'publicationId' = "federation_case_revocation_notices"."publication_id"::text) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_case_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_site_id" uuid NOT NULL,
	"publication_id" uuid,
	"arbitration_decision_id" uuid,
	"operation" varchar(32) NOT NULL,
	"input" jsonb,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"receipt" jsonb,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_case_submission_owner" CHECK ((
      ("federation_case_submissions"."operation" = 'record-arbitration-decision' AND "federation_case_submissions"."arbitration_decision_id" IS NOT NULL AND "federation_case_submissions"."publication_id" IS NULL)
      OR ("federation_case_submissions"."operation" IN ('record-case-evidence','revoke-case-publication') AND "federation_case_submissions"."publication_id" IS NOT NULL AND "federation_case_submissions"."arbitration_decision_id" IS NULL)) IS TRUE),
	CONSTRAINT "federation_case_submission_state" CHECK ("federation_case_submissions"."state" IN ('pending','committed','needs_review','closed')
    AND ("federation_case_submissions"."state" = 'committed') = ("federation_case_submissions"."receipt" IS NOT NULL)
    AND ("federation_case_submissions"."lease_token" IS NULL) = ("federation_case_submissions"."lease_until" IS NULL)),
	CONSTRAINT "federation_case_submission_input" CHECK (("federation_case_submissions"."operation" IN ('record-case-evidence','revoke-case-publication','record-arbitration-decision')
    AND ("federation_case_submissions"."input" IS NULL OR ("federation_case_submissions"."input"->>'operation' = "federation_case_submissions"."operation"
      AND "federation_case_submissions"."input"->>'recordId' IS NOT NULL AND "federation_case_submissions"."input"->>'domainId' IS NOT NULL
      AND "federation_case_submissions"."input"->>'digest' ~ '^sha256:[a-f0-9]{64}$'))
    AND ("federation_case_submissions"."receipt" IS NULL OR ("federation_case_submissions"."input" IS NOT NULL
      AND "federation_case_submissions"."receipt"->>'recordId' = "federation_case_submissions"."input"->>'recordId'
      AND "federation_case_submissions"."receipt"->>'digest' = "federation_case_submissions"."input"->>'digest'))) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_certificates" (
	"fingerprint" varchar(64) PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"certificate_pem" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "federation_certificate_interval" CHECK ("federation_certificates"."valid_from" < "federation_certificates"."valid_until"),
	CONSTRAINT "federation_certificate_fingerprint" CHECK ("federation_certificates"."fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "federation_closing_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"agreement_digest" varchar(71) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"outcomes" jsonb NOT NULL,
	"max_amount" numeric(38, 0) NOT NULL,
	"max_total_amount" numeric(38, 0) NOT NULL,
	"max_records" integer NOT NULL,
	"approved_amount" numeric(38, 0) DEFAULT '0' NOT NULL,
	"approved_records" integer DEFAULT 0 NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"granted_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "federation_closing_policy_kind" CHECK ("federation_closing_policies"."kind" IN ('bill','settlement','refund')),
	CONSTRAINT "federation_closing_policy_limits" CHECK ("federation_closing_policies"."max_amount" >= 0 AND "federation_closing_policies"."max_total_amount" >= "federation_closing_policies"."max_amount" AND "federation_closing_policies"."max_records" BETWEEN 1 AND 100000 AND "federation_closing_policies"."approved_amount" BETWEEN 0 AND "federation_closing_policies"."max_total_amount" AND "federation_closing_policies"."approved_records" BETWEEN 0 AND "federation_closing_policies"."max_records"),
	CONSTRAINT "federation_closing_policy_time" CHECK ("federation_closing_policies"."valid_until" > "federation_closing_policies"."valid_from" AND ("federation_closing_policies"."revoked_at" IS NULL) = ("federation_closing_policies"."revoked_by" IS NULL)),
	CONSTRAINT "federation_closing_policy_outcomes" CHECK (jsonb_typeof("federation_closing_policies"."outcomes") = 'array' AND jsonb_array_length("federation_closing_policies"."outcomes") BETWEEN 1 AND 3 AND "federation_closing_policies"."outcomes" <@ '["completed","failed","cancelled"]'::jsonb AND ("federation_closing_policies"."kind" <> 'refund' OR "federation_closing_policies"."outcomes" = '["cancelled"]'::jsonb))
);
--> statement-breakpoint
CREATE TABLE "federation_closing_tasks" (
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"reference_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"record_id" uuid,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"last_error" varchar(80),
	"completed_at" timestamp with time zone,
	CONSTRAINT "federation_closing_tasks_local_site_id_kind_reference_id_pk" PRIMARY KEY("local_site_id","kind","reference_id"),
	CONSTRAINT "federation_closing_task_kind" CHECK ("federation_closing_tasks"."kind" IN ('bill','settlement','refund')),
	CONSTRAINT "federation_closing_task_state" CHECK ("federation_closing_tasks"."state" IN ('pending','complete','needs_review') AND ("federation_closing_tasks"."state" <> 'complete' OR ("federation_closing_tasks"."record_id" IS NOT NULL AND "federation_closing_tasks"."completed_at" IS NOT NULL))),
	CONSTRAINT "federation_closing_task_lease" CHECK (("federation_closing_tasks"."lease_token" IS NULL) = ("federation_closing_tasks"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_adjustments" (
	"local_site_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text,
	"arbitration_decision_id" uuid,
	"counterparty_jws" text,
	"held_amount" numeric(38, 0) DEFAULT '0' NOT NULL,
	"approved_by" uuid NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_adjustments_local_site_id_adjustment_id_pk" PRIMARY KEY("local_site_id","adjustment_id"),
	CONSTRAINT "federation_adjustment_identity" CHECK ((
      "federation_commercial_adjustments"."number" > 0 AND "federation_commercial_adjustments"."held_amount" >= 0 AND "federation_commercial_adjustments"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_commercial_adjustments"."payload"->>'kind' = 'commercial-adjustment'
      AND "federation_commercial_adjustments"."payload"->>'adjustmentId' = "federation_commercial_adjustments"."adjustment_id"::text
      AND "federation_commercial_adjustments"."payload"->>'settlementId' = "federation_commercial_adjustments"."settlement_id"::text
      AND "federation_commercial_adjustments"."payload"->>'agreementRevisionId' = "federation_commercial_adjustments"."agreement_revision_id"::text
      AND ("federation_commercial_adjustments"."payload"->>'sourceSiteId' = "federation_commercial_adjustments"."local_site_id"::text OR "federation_commercial_adjustments"."payload"->>'targetSiteId' = "federation_commercial_adjustments"."local_site_id"::text)
      AND (( "federation_commercial_adjustments"."arbitration_decision_id" IS NULL AND "federation_commercial_adjustments"."approval_jws" IS NOT NULL)
        OR ("federation_commercial_adjustments"."arbitration_decision_id" IS NOT NULL AND "federation_commercial_adjustments"."approval_jws" IS NULL AND "federation_commercial_adjustments"."counterparty_jws" IS NULL))
      AND ("federation_commercial_adjustments"."applied_at" IS NULL OR "federation_commercial_adjustments"."counterparty_jws" IS NOT NULL OR "federation_commercial_adjustments"."arbitration_decision_id" IS NOT NULL)
      AND (("federation_commercial_adjustments"."number" = 1) = ("federation_commercial_adjustments"."payload"->'previous' = 'null'::jsonb))
    ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_agreements" (
	"local_site_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"terms" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_agreements_local_site_id_revision_id_pk" PRIMARY KEY("local_site_id","revision_id"),
	CONSTRAINT "federation_commercial_terms" CHECK (("federation_commercial_agreements"."digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_commercial_agreements"."terms"->'agreement'->>'agreementRevisionId' = "federation_commercial_agreements"."revision_id"::text AND ("federation_commercial_agreements"."terms"->'agreement'->>'sourceSiteId' = "federation_commercial_agreements"."local_site_id"::text OR "federation_commercial_agreements"."terms"->'agreement'->>'targetSiteId' = "federation_commercial_agreements"."local_site_id"::text)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_approval_syncs" (
	"local_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"record_kind" varchar(24) NOT NULL,
	"record_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "federation_commercial_approval_syncs_local_site_id_record_kind_record_id_pk" PRIMARY KEY("local_site_id","record_kind","record_id"),
	CONSTRAINT "federation_approval_sync_identity" CHECK (("federation_commercial_approval_syncs"."record_kind" IN ('agreement','reservation','release','bill','settlement','adjustment','refund','payment','arbitration-policy','disclosure-policy','disclosure','case-publication','dispute-resolution') AND ("federation_commercial_approval_syncs"."record_kind" <> 'agreement' OR "federation_commercial_approval_syncs"."record_id" = "federation_commercial_approval_syncs"."agreement_revision_id")) IS TRUE),
	CONSTRAINT "federation_approval_sync_state" CHECK ("federation_commercial_approval_syncs"."state" IN ('pending','complete','needs_review','closed')),
	CONSTRAINT "federation_approval_sync_lease" CHECK (("federation_commercial_approval_syncs"."lease_token" IS NULL) = ("federation_commercial_approval_syncs"."lease_until" IS NULL)),
	CONSTRAINT "federation_approval_sync_receipt" CHECK (("federation_commercial_approval_syncs"."state" = 'complete') = ("federation_commercial_approval_syncs"."verified_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"transaction_id" varchar(64) NOT NULL,
	"recovery" text NOT NULL,
	"stage" varchar(24) DEFAULT 'proposal' NOT NULL,
	"dispatch_authorized_at" timestamp with time zone,
	"validation_code" integer,
	"block_number" numeric(20, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_attempt" CHECK ("federation_commercial_attempts"."number" > 0 AND "federation_commercial_attempts"."transaction_id" ~ '^[a-f0-9]{64}$' AND octet_length("federation_commercial_attempts"."recovery") BETWEEN 1 AND 4194304),
	CONSTRAINT "federation_commercial_result" CHECK ((("federation_commercial_attempts"."stage" IN ('proposal','transaction','abandoned') AND "federation_commercial_attempts"."validation_code" IS NULL AND "federation_commercial_attempts"."block_number" IS NULL) OR ("federation_commercial_attempts"."stage" = 'committed' AND "federation_commercial_attempts"."validation_code" = 0 AND "federation_commercial_attempts"."block_number" >= 0) OR ("federation_commercial_attempts"."stage" = 'invalid' AND "federation_commercial_attempts"."validation_code" BETWEEN 1 AND 255 AND "federation_commercial_attempts"."block_number" >= 0)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_bills" (
	"local_site_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"authorization_policy_id" uuid,
	"approved_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_bills_local_site_id_bill_id_pk" PRIMARY KEY("local_site_id","bill_id"),
	CONSTRAINT "federation_bill_identity" CHECK (("federation_commercial_bills"."digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_commercial_bills"."attempt" > 0
    AND "federation_commercial_bills"."payload"->>'kind' = 'commercial-bill' AND "federation_commercial_bills"."payload"->>'billId' = "federation_commercial_bills"."bill_id"::text
    AND "federation_commercial_bills"."payload"->'request'->>'agreementRevisionId' = "federation_commercial_bills"."agreement_revision_id"::text
    AND "federation_commercial_bills"."payload"->'request'->>'taskId' = "federation_commercial_bills"."task_id"::text AND "federation_commercial_bills"."payload"->'request'->>'attempt' = "federation_commercial_bills"."attempt"::text
    AND ("federation_commercial_bills"."payload"->'request'->>'senderSiteId' = "federation_commercial_bills"."local_site_id"::text OR "federation_commercial_bills"."payload"->'request'->>'recipientSiteId' = "federation_commercial_bills"."local_site_id"::text)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_discounts" (
	"local_site_id" uuid NOT NULL,
	"discount_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"provider_jws" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_discounts_local_site_id_discount_id_pk" PRIMARY KEY("local_site_id","discount_id"),
	CONSTRAINT "federation_discount_identity" CHECK (("federation_commercial_discounts"."digest" ~ '^sha256:[a-f0-9]{64}$'
    AND "federation_commercial_discounts"."payload"->>'kind' = 'commercial-discount' AND "federation_commercial_discounts"."payload"->>'discountId' = "federation_commercial_discounts"."discount_id"::text
    AND "federation_commercial_discounts"."payload"->>'agreementRevisionId' = "federation_commercial_discounts"."agreement_revision_id"::text
    AND ("federation_commercial_discounts"."payload"->>'sourceSiteId' = "federation_commercial_discounts"."local_site_id"::text OR "federation_commercial_discounts"."payload"->>'targetSiteId' = "federation_commercial_discounts"."local_site_id"::text)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_execution_approvals" (
	"local_site_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"authorization_policy_id" uuid,
	"terminal_auto_state" varchar(24) DEFAULT 'pending' NOT NULL,
	"terminal_auto_next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_auto_error" varchar(64),
	"stop_id" uuid,
	"stop_requested_by" uuid,
	"stop_requested_at" timestamp with time zone,
	"stop_next_attempt_at" timestamp with time zone,
	"stop_last_error" varchar(64),
	"approved_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_execution_approvals_local_site_id_record_id_pk" PRIMARY KEY("local_site_id","record_id"),
	CONSTRAINT "federation_terminal_auto_state" CHECK ("federation_commercial_execution_approvals"."terminal_auto_state" IN ('pending','needs_review')),
	CONSTRAINT "federation_execution_stop_intent" CHECK ((("federation_commercial_execution_approvals"."stop_id" IS NULL AND "federation_commercial_execution_approvals"."stop_requested_by" IS NULL AND "federation_commercial_execution_approvals"."stop_requested_at" IS NULL AND "federation_commercial_execution_approvals"."stop_next_attempt_at" IS NULL AND "federation_commercial_execution_approvals"."stop_last_error" IS NULL)
        OR ("federation_commercial_execution_approvals"."stop_id" IS NOT NULL AND "federation_commercial_execution_approvals"."stop_requested_by" IS NOT NULL AND "federation_commercial_execution_approvals"."stop_requested_at" IS NOT NULL AND "federation_commercial_execution_approvals"."payload"->>'kind' = 'commercial-reservation' AND "federation_commercial_execution_approvals"."payload"->'request'->>'mode' = 'ledger_coordinated')) IS TRUE),
	CONSTRAINT "federation_execution_approval_payload" CHECK ((
      "federation_commercial_execution_approvals"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND (("federation_commercial_execution_approvals"."payload"->>'kind' = 'commercial-reservation'
        AND "federation_commercial_execution_approvals"."payload"->>'reservationId' = "federation_commercial_execution_approvals"."record_id"::text
        AND "federation_commercial_execution_approvals"."payload"->'request'->>'agreementRevisionId' = "federation_commercial_execution_approvals"."agreement_revision_id"::text)
      OR ("federation_commercial_execution_approvals"."payload"->>'kind' = 'commercial-release'
        AND "federation_commercial_execution_approvals"."payload"->>'releaseId' = "federation_commercial_execution_approvals"."record_id"::text))
    ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_history_recoveries" (
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"recovery_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text NOT NULL,
	"approval_jws" text NOT NULL,
	"approval_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_by" uuid NOT NULL,
	"counterparty_jws" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_history_recoveries_local_site_id_recovery_id_pk" PRIMARY KEY("local_site_id","recovery_id"),
	CONSTRAINT "commercial_history_binding" CHECK ((
      "federation_commercial_history_recoveries"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_commercial_history_recoveries"."payload"->>'kind' = 'commercial-history-recovery'
      AND "federation_commercial_history_recoveries"."payload"->>'recoveryId' = "federation_commercial_history_recoveries"."recovery_id"::text
      AND "federation_commercial_history_recoveries"."payload"->>'agreementRevisionId' = "federation_commercial_history_recoveries"."agreement_revision_id"::text
      AND "federation_commercial_history_recoveries"."local_site_id"::text IN ("federation_commercial_history_recoveries"."payload"->>'sourceSiteId', "federation_commercial_history_recoveries"."payload"->>'targetSiteId')
    ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_payments" (
	"local_site_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"current" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_payments_local_site_id_receipt_id_pk" PRIMARY KEY("local_site_id","receipt_id"),
	CONSTRAINT "federation_payment_identity" CHECK ((
      "federation_commercial_payments"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_commercial_payments"."payload"->>'kind' = 'commercial-payment'
      AND "federation_commercial_payments"."payload"->>'receiptId' = "federation_commercial_payments"."receipt_id"::text
      AND "federation_commercial_payments"."payload"->>'paymentId' = "federation_commercial_payments"."payment_id"::text
      AND "federation_commercial_payments"."payload"->>'billId' = "federation_commercial_payments"."bill_id"::text
      AND "federation_commercial_payments"."payload"->>'agreementRevisionId' = "federation_commercial_payments"."agreement_revision_id"::text
      AND ("federation_commercial_payments"."payload"->>'sourceSiteId' = "federation_commercial_payments"."local_site_id"::text OR "federation_commercial_payments"."payload"->>'targetSiteId' = "federation_commercial_payments"."local_site_id"::text)
      AND ("federation_commercial_payments"."counterparty_jws" IS NULL) = ("federation_commercial_payments"."confirmed_at" IS NULL)
      AND (NOT "federation_commercial_payments"."current" OR "federation_commercial_payments"."confirmed_at" IS NOT NULL)
    ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_refunds" (
	"local_site_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"authorization_policy_id" uuid,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_refunds_local_site_id_refund_id_pk" PRIMARY KEY("local_site_id","refund_id"),
	CONSTRAINT "federation_refund_identity" CHECK ((
    "federation_commercial_refunds"."digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_commercial_refunds"."payload"->>'kind' = 'commercial-refund'
    AND "federation_commercial_refunds"."payload"->>'refundId' = "federation_commercial_refunds"."refund_id"::text
    AND "federation_commercial_refunds"."payload"->'request'->>'agreementRevisionId' = "federation_commercial_refunds"."agreement_revision_id"::text
    AND "federation_commercial_refunds"."payload"->'request'->>'operationId' = "federation_commercial_refunds"."operation_id"::text
    AND "federation_commercial_refunds"."payload"->'request'->>'mode' IN ('bilateral_direct','bilateral_attested')
    AND "federation_commercial_refunds"."payload"->>'releasedAmount' = "federation_commercial_refunds"."payload"->'request'->>'maxAmount'
    AND ("federation_commercial_refunds"."payload"->'request'->>'senderSiteId' = "federation_commercial_refunds"."local_site_id"::text OR "federation_commercial_refunds"."payload"->'request'->>'recipientSiteId' = "federation_commercial_refunds"."local_site_id"::text)
    AND ("federation_commercial_refunds"."applied_at" IS NULL OR "federation_commercial_refunds"."counterparty_jws" IS NOT NULL)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_settlements" (
	"local_site_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text,
	"arbitration_decision_id" uuid,
	"counterparty_jws" text,
	"authorization_policy_id" uuid,
	"approved_by" uuid NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_settlements_local_site_id_settlement_id_pk" PRIMARY KEY("local_site_id","settlement_id"),
	CONSTRAINT "federation_settlement_identity" CHECK ((
      "federation_commercial_settlements"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_commercial_settlements"."payload"->>'kind' = 'commercial-settlement'
      AND "federation_commercial_settlements"."payload"->>'settlementId' = "federation_commercial_settlements"."settlement_id"::text
      AND "federation_commercial_settlements"."payload"->>'billId' = "federation_commercial_settlements"."bill_id"::text
      AND "federation_commercial_settlements"."payload"->>'agreementRevisionId' = "federation_commercial_settlements"."agreement_revision_id"::text
      AND ("federation_commercial_settlements"."payload"->>'sourceSiteId' = "federation_commercial_settlements"."local_site_id"::text OR "federation_commercial_settlements"."payload"->>'targetSiteId' = "federation_commercial_settlements"."local_site_id"::text)
      AND (( "federation_commercial_settlements"."arbitration_decision_id" IS NULL AND "federation_commercial_settlements"."approval_jws" IS NOT NULL)
        OR ("federation_commercial_settlements"."arbitration_decision_id" IS NOT NULL AND "federation_commercial_settlements"."approval_jws" IS NULL AND "federation_commercial_settlements"."counterparty_jws" IS NULL))
      AND ("federation_commercial_settlements"."applied_at" IS NULL OR "federation_commercial_settlements"."counterparty_jws" IS NOT NULL OR "federation_commercial_settlements"."arbitration_decision_id" IS NOT NULL)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_submission_state" CHECK ("federation_commercial_submissions"."state" IN ('pending','committed','needs_review','closed')),
	CONSTRAINT "federation_commercial_submission_input" CHECK (("federation_commercial_submissions"."input"->>'operation' IN ('register-agreement','record-usage','reserve-execution','release-execution','record-execution-terminal','record-discount','confirm-bill','settle-bill','adjust-settlement','record-refund','record-payment','record-dispute-freeze','record-dispute-resolution','authorize-dispute-resolution','resolve-dispute','record-historical-commercial','freeze-disputed-task','revoke-arbitration-policy','resolve-arbitrated-case','record-arbitration-resolution') AND "federation_commercial_submissions"."input"->>'recordId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'domainId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'digest' ~ '^sha256:[a-f0-9]{64}$') IS TRUE),
	CONSTRAINT "federation_commercial_submission_lease" CHECK (("federation_commercial_submissions"."lease_token" IS NULL) = ("federation_commercial_submissions"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_completion_claims" (
	"local_site_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"intent_id" varchar(96) NOT NULL,
	"digest" varchar(71) NOT NULL,
	"allocated_bytes" numeric(30, 0) NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"release_blocker" varchar(64),
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_completion_claims_local_site_id_kind_intent_id_pk" PRIMARY KEY("local_site_id","kind","intent_id"),
	CONSTRAINT "federation_completion_claim_kind" CHECK ("federation_completion_claims"."kind" IN ('task', 'market')),
	CONSTRAINT "federation_completion_claim_bytes" CHECK ("federation_completion_claims"."allocated_bytes" > 0 AND "federation_completion_claims"."allocated_bytes" < 1e30)
);
--> statement-breakpoint
CREATE TABLE "federation_completion_pools" (
	"local_site_id" uuid PRIMARY KEY NOT NULL,
	"reserve_id" uuid NOT NULL,
	"capacity_bytes" numeric(30, 0) NOT NULL,
	"task_bytes" numeric(30, 0) NOT NULL,
	"market_bytes" numeric(30, 0) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_completion_pool_bytes" CHECK ("federation_completion_pools"."capacity_bytes" > 0 AND "federation_completion_pools"."capacity_bytes" < 1e30 AND "federation_completion_pools"."task_bytes" > 0 AND "federation_completion_pools"."task_bytes" <= "federation_completion_pools"."capacity_bytes" AND "federation_completion_pools"."market_bytes" > 0 AND "federation_completion_pools"."market_bytes" <= "federation_completion_pools"."capacity_bytes")
);
--> statement-breakpoint
CREATE TABLE "federation_dataset_assets" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"source_site_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	CONSTRAINT "federation_dataset_asset_sites" CHECK ("federation_dataset_assets"."local_site_id" <> "federation_dataset_assets"."source_site_id")
);
--> statement-breakpoint
CREATE TABLE "federation_dataset_replicas" (
	"replica_id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"import_generation" uuid NOT NULL,
	"source_policy_id" uuid NOT NULL,
	"publication_name" varchar(255) NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"reference" jsonb NOT NULL,
	"lease" jsonb,
	"renew_after" timestamp with time zone NOT NULL,
	"renew_token" uuid,
	"last_error" varchar(32),
	"published_by" uuid NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "federation_dataset_replicas_location_id_unique" UNIQUE("location_id"),
	CONSTRAINT "federation_dataset_replicas_authorization_id_unique" UNIQUE("authorization_id"),
	CONSTRAINT "federation_dataset_replica_reference" CHECK (("federation_dataset_replicas"."reference"->>'kind' = 'dataset') IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_dataset_use_grants" (
	"local_site_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"query_digest" varchar(71) NOT NULL,
	"response_jws" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "federation_dataset_use_grants_local_site_id_query_id_pk" PRIMARY KEY("local_site_id","query_id"),
	CONSTRAINT "federation_dataset_use_grant_window" CHECK ("federation_dataset_use_grants"."expires_at" > "federation_dataset_use_grants"."issued_at" AND "federation_dataset_use_grants"."expires_at" <= "federation_dataset_use_grants"."issued_at" + interval '60 seconds'),
	CONSTRAINT "federation_dataset_use_grant_digest" CHECK ("federation_dataset_use_grants"."query_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "federation_dataset_use_policies" (
	"local_site_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"recipient_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"asset" jsonb NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "federation_dataset_use_policies_local_site_id_policy_id_pk" PRIMARY KEY("local_site_id","policy_id"),
	CONSTRAINT "federation_dataset_use_scope" CHECK (("federation_dataset_use_policies"."local_site_id" <> "federation_dataset_use_policies"."recipient_site_id" AND "federation_dataset_use_policies"."asset"->>'kind' = 'dataset' AND "federation_dataset_use_policies"."asset"->>'originSiteId' = "federation_dataset_use_policies"."local_site_id"::text AND "federation_dataset_use_policies"."expires_at" > "federation_dataset_use_policies"."approved_at") IS TRUE)
);
--> statement-breakpoint
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
CREATE TABLE "federation_disclosure_policies" (
	"local_site_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"recipient_site_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_disclosure_policies_local_site_id_policy_id_pk" PRIMARY KEY("local_site_id","policy_id"),
	CONSTRAINT "federation_disclosure_policy_identity" CHECK ((
      "federation_disclosure_policies"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_disclosure_policies"."payload"->>'kind' = 'commercial-disclosure-policy'
      AND "federation_disclosure_policies"."payload"->>'policyId' = "federation_disclosure_policies"."policy_id"::text
      AND "federation_disclosure_policies"."payload"->>'agreementRevisionId' = "federation_disclosure_policies"."agreement_revision_id"::text
      AND "federation_disclosure_policies"."payload"->>'recipientSiteId' = "federation_disclosure_policies"."recipient_site_id"::text
      AND ("federation_disclosure_policies"."payload"->>'sourceSiteId' = "federation_disclosure_policies"."local_site_id"::text OR "federation_disclosure_policies"."payload"->>'targetSiteId' = "federation_disclosure_policies"."local_site_id"::text)
      AND "federation_disclosure_policies"."payload"->>'sourceSiteId' <> "federation_disclosure_policies"."payload"->>'targetSiteId'
      AND "federation_disclosure_policies"."recipient_site_id"::text NOT IN ("federation_disclosure_policies"."payload"->>'sourceSiteId', "federation_disclosure_policies"."payload"->>'targetSiteId')
      AND ("federation_disclosure_policies"."counterparty_jws" IS NULL) = ("federation_disclosure_policies"."confirmed_at" IS NULL)
      AND ("federation_disclosure_policies"."revoked_at" IS NULL) = ("federation_disclosure_policies"."revoked_by" IS NULL)
    ) IS TRUE)
);
--> statement-breakpoint
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
CREATE TABLE "federation_disclosures" (
	"local_site_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"recipient_site_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_disclosures_local_site_id_grant_id_pk" PRIMARY KEY("local_site_id","grant_id"),
	CONSTRAINT "federation_disclosure_identity" CHECK ((
      "federation_disclosures"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_disclosures"."payload"->>'kind' = 'commercial-disclosure'
      AND "federation_disclosures"."payload"->'grant'->>'grantId' = "federation_disclosures"."grant_id"::text
      AND "federation_disclosures"."payload"->'grant'->>'caseId' = "federation_disclosures"."case_id"::text
      AND "federation_disclosures"."payload"->'grant'->>'policyId' = "federation_disclosures"."policy_id"::text
      AND "federation_disclosures"."payload"->'grant'->>'agreementRevisionId' = "federation_disclosures"."agreement_revision_id"::text
      AND "federation_disclosures"."payload"->'grant'->>'recipientSiteId' = "federation_disclosures"."recipient_site_id"::text
      AND "federation_disclosures"."local_site_id"::text IN ("federation_disclosures"."payload"->'grant'->>'sourceSiteId', "federation_disclosures"."payload"->'grant'->>'targetSiteId')
      AND "federation_disclosures"."payload"->'grant'->>'sourceSiteId' <> "federation_disclosures"."payload"->'grant'->>'targetSiteId'
      AND "federation_disclosures"."recipient_site_id"::text NOT IN ("federation_disclosures"."payload"->'grant'->>'sourceSiteId', "federation_disclosures"."payload"->'grant'->>'targetSiteId')
      AND ("federation_disclosures"."counterparty_jws" IS NULL) = ("federation_disclosures"."confirmed_at" IS NULL)
      AND ("federation_disclosures"."revoked_at" IS NULL) = ("federation_disclosures"."revoked_by" IS NULL)
    ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_dispute_deliveries" (
	"local_site_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"receipt_jws" text,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "federation_dispute_deliveries_local_site_id_case_id_pk" PRIMARY KEY("local_site_id","case_id"),
	CONSTRAINT "federation_dispute_delivery_state" CHECK ("federation_dispute_deliveries"."state" IN ('pending','received','needs_review')),
	CONSTRAINT "federation_dispute_delivery_lease" CHECK (
      ("federation_dispute_deliveries"."lease_token" IS NULL) = ("federation_dispute_deliveries"."lease_until" IS NULL)
      AND ("federation_dispute_deliveries"."state" = 'pending' OR "federation_dispute_deliveries"."lease_token" IS NULL)),
	CONSTRAINT "federation_dispute_delivery_receipt" CHECK (
      ("federation_dispute_deliveries"."state" = 'received') = ("federation_dispute_deliveries"."receipt_jws" IS NOT NULL)
      AND ("federation_dispute_deliveries"."receipt_jws" IS NULL) = ("federation_dispute_deliveries"."acknowledged_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_dispute_freezes" (
	"local_site_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"financial_view" jsonb,
	"ledger_receipt" jsonb,
	"digest" varchar(71),
	"approval_jws" text,
	"counterparty_jws" text,
	"confirmed_at" timestamp with time zone,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_dispute_freezes_local_site_id_case_id_pk" PRIMARY KEY("local_site_id","case_id"),
	CONSTRAINT "federation_dispute_freeze_state" CHECK ("federation_dispute_freezes"."state" IN ('pending','ledger_pending','confirmed','needs_review')),
	CONSTRAINT "federation_dispute_freeze_lease" CHECK (("federation_dispute_freezes"."lease_token" IS NULL) = ("federation_dispute_freezes"."lease_until" IS NULL) AND ("federation_dispute_freezes"."state" IN ('pending','ledger_pending') OR "federation_dispute_freezes"."lease_token" IS NULL)),
	CONSTRAINT "federation_dispute_freeze_original" CHECK (
    ("federation_dispute_freezes"."payload" IS NULL AND "federation_dispute_freezes"."financial_view" IS NULL AND "federation_dispute_freezes"."digest" IS NULL AND "federation_dispute_freezes"."approval_jws" IS NULL)
    OR ("federation_dispute_freezes"."payload" IS NOT NULL AND "federation_dispute_freezes"."financial_view" IS NOT NULL AND "federation_dispute_freezes"."digest" IS NOT NULL AND "federation_dispute_freezes"."approval_jws" IS NOT NULL
      AND ("federation_dispute_freezes"."digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_dispute_freezes"."payload"->>'kind' = 'commercial-dispute-freeze'
        AND "federation_dispute_freezes"."payload"->>'caseId' = "federation_dispute_freezes"."case_id"::text AND "federation_dispute_freezes"."financial_view"->>'caseId' = "federation_dispute_freezes"."case_id"::text
        AND "federation_dispute_freezes"."payload"->>'caseDigest' = "federation_dispute_freezes"."financial_view"->>'caseDigest'
        AND "federation_dispute_freezes"."payload"->>'headDigest' = "federation_dispute_freezes"."financial_view"->>'headDigest'
        AND "federation_dispute_freezes"."financial_view"->>'localReady' = 'true'
        AND "federation_dispute_freezes"."local_site_id"::text IN ("federation_dispute_freezes"."payload"->>'sourceSiteId', "federation_dispute_freezes"."payload"->>'targetSiteId')) IS TRUE)),
	CONSTRAINT "federation_dispute_freeze_confirmed" CHECK (
    ("federation_dispute_freezes"."state" = 'confirmed') = ("federation_dispute_freezes"."confirmed_at" IS NOT NULL)
    AND ("federation_dispute_freezes"."counterparty_jws" IS NULL OR ("federation_dispute_freezes"."approval_jws" IS NOT NULL AND
      ("federation_dispute_freezes"."state" = 'confirmed' OR ("federation_dispute_freezes"."payload"->>'mode' = 'ledger_coordinated' AND "federation_dispute_freezes"."state" IN ('ledger_pending','needs_review')))) IS TRUE)
    AND ("federation_dispute_freezes"."state" NOT IN ('confirmed','ledger_pending') OR "federation_dispute_freezes"."counterparty_jws" IS NOT NULL)
    AND ("federation_dispute_freezes"."state" <> 'ledger_pending' OR ("federation_dispute_freezes"."payload"->>'mode' = 'ledger_coordinated') IS TRUE)
    AND ("federation_dispute_freezes"."ledger_receipt" IS NULL OR ("federation_dispute_freezes"."payload"->>'mode' = 'ledger_coordinated'
      AND "federation_dispute_freezes"."ledger_receipt"->>'recordId' = "federation_dispute_freezes"."case_id"::text AND "federation_dispute_freezes"."ledger_receipt"->>'digest' = "federation_dispute_freezes"."digest"
      AND "federation_dispute_freezes"."state" = 'confirmed') IS TRUE)
    AND ("federation_dispute_freezes"."state" <> 'confirmed' OR ("federation_dispute_freezes"."approval_jws" IS NOT NULL AND
      ("federation_dispute_freezes"."payload"->>'mode' IN ('bilateral_direct','bilateral_attested') OR "federation_dispute_freezes"."ledger_receipt" IS NOT NULL)) IS TRUE))
);
--> statement-breakpoint
CREATE TABLE "federation_dispute_resolutions" (
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"resolution_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text NOT NULL,
	"approval_jws" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"counterparty_jws" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_dispute_resolutions_local_site_id_case_id_pk" PRIMARY KEY("local_site_id","case_id"),
	CONSTRAINT "dispute_resolution_binding" CHECK ((
      "federation_dispute_resolutions"."payload"->>'kind' = 'commercial-dispute-resolution'
      AND "federation_dispute_resolutions"."payload"->>'caseId' = "federation_dispute_resolutions"."case_id"::text
      AND "federation_dispute_resolutions"."payload"->>'resolutionId' = "federation_dispute_resolutions"."resolution_id"::text
      AND "federation_dispute_resolutions"."payload"->>'agreementRevisionId' = "federation_dispute_resolutions"."agreement_revision_id"::text
      AND "federation_dispute_resolutions"."payload"->>'mode' IN ('bilateral_direct','bilateral_attested','ledger_coordinated')
      AND ("federation_dispute_resolutions"."payload"->>'protocolVersion' = '1'
        AND "federation_dispute_resolutions"."payload"->>'mode' <> 'ledger_coordinated'
        AND "federation_dispute_resolutions"."payload"->>'decisionId' IS NOT NULL
        AND "federation_dispute_resolutions"."payload"->>'withdrawalDigest' ~ '^sha256:[a-f0-9]{64}$'
        OR "federation_dispute_resolutions"."payload"->>'protocolVersion' = '2'
        AND "federation_dispute_resolutions"."payload"->'decisionId' = 'null'::jsonb
        AND "federation_dispute_resolutions"."payload"->'withdrawalDigest' = 'null'::jsonb
        AND (CASE WHEN "federation_dispute_resolutions"."payload"->>'mode' = 'ledger_coordinated'
          THEN "federation_dispute_resolutions"."payload"->>'freezeDigest' ~ '^sha256:[a-f0-9]{64}$'
          ELSE "federation_dispute_resolutions"."payload"->'freezeDigest' = 'null'::jsonb END))
      AND "federation_dispute_resolutions"."local_site_id"::text IN ("federation_dispute_resolutions"."payload"->>'sourceSiteId', "federation_dispute_resolutions"."payload"->>'targetSiteId')
      AND ("federation_dispute_resolutions"."applied_at" IS NULL OR "federation_dispute_resolutions"."counterparty_jws" IS NOT NULL)
    ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_disputes" (
	"local_site_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"opening_jws" text NOT NULL,
	"opened_by" uuid,
	"acceptance_jws" text,
	"received_at" timestamp with time zone,
	"state" varchar(32) DEFAULT 'FREEZE_PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_disputes_local_site_id_case_id_pk" PRIMARY KEY("local_site_id","case_id"),
	CONSTRAINT "federation_dispute_identity" CHECK ((
      "federation_disputes"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_disputes"."attempt" > 0
      AND "federation_disputes"."payload"->>'kind' = 'commercial-dispute'
      AND "federation_disputes"."payload"->>'caseId' = "federation_disputes"."case_id"::text
      AND "federation_disputes"."payload"->>'agreementRevisionId' = "federation_disputes"."agreement_revision_id"::text
      AND "federation_disputes"."payload"->>'taskId' = "federation_disputes"."task_id"::text
      AND "federation_disputes"."payload"->>'attempt' = "federation_disputes"."attempt"::text
      AND "federation_disputes"."payload"->>'sourceSiteId' <> "federation_disputes"."payload"->>'targetSiteId'
      AND "federation_disputes"."local_site_id"::text IN ("federation_disputes"."payload"->>'sourceSiteId', "federation_disputes"."payload"->>'targetSiteId')
      AND "federation_disputes"."payload"->>'openingSiteId' IN ("federation_disputes"."payload"->>'sourceSiteId', "federation_disputes"."payload"->>'targetSiteId')
    ) IS TRUE),
	CONSTRAINT "federation_dispute_origin" CHECK ((
      ("federation_disputes"."payload"->>'openingSiteId' = "federation_disputes"."local_site_id"::text AND "federation_disputes"."opened_by" IS NOT NULL AND "federation_disputes"."acceptance_jws" IS NULL AND "federation_disputes"."received_at" IS NULL)
      OR ("federation_disputes"."payload"->>'openingSiteId' <> "federation_disputes"."local_site_id"::text AND "federation_disputes"."opened_by" IS NULL AND "federation_disputes"."acceptance_jws" IS NOT NULL AND "federation_disputes"."received_at" IS NOT NULL)
    ) IS TRUE),
	CONSTRAINT "federation_dispute_state" CHECK ("federation_disputes"."state" IN ('FREEZE_PENDING','DISPUTED','EVIDENCE_WAITING','DECIDED','APPLICATION_WAITING','RESOLVED'))
);
--> statement-breakpoint
CREATE TABLE "federation_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"kind" varchar(24) NOT NULL,
	"jws" text NOT NULL,
	"digest" varchar(71) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_evidence_kind" CHECK ("federation_evidence"."kind" IN ('delegation', 'acceptance'))
);
--> statement-breakpoint
CREATE TABLE "federation_evidence_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"domain_id" uuid NOT NULL,
	"issuer_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"first_sequence" numeric(20, 0) NOT NULL,
	"manifest" jsonb NOT NULL,
	"issuer_jws" text,
	"digest" varchar(71),
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_batch_state" CHECK ("federation_evidence_batches"."state" IN ('pending','anchored','needs_review')),
	CONSTRAINT "federation_batch_signature" CHECK ((("federation_evidence_batches"."issuer_jws" IS NULL AND "federation_evidence_batches"."digest" IS NULL) OR ("federation_evidence_batches"."issuer_jws" IS NOT NULL AND "federation_evidence_batches"."digest" ~ '^sha256:[a-f0-9]{64}$')) IS TRUE),
	CONSTRAINT "federation_batch_lease" CHECK (("federation_evidence_batches"."lease_token" IS NULL) = ("federation_evidence_batches"."lease_until" IS NULL)),
	CONSTRAINT "federation_batch_manifest" CHECK (("federation_evidence_batches"."first_sequence" > 0 AND "federation_evidence_batches"."manifest"->>'batchId' = "federation_evidence_batches"."id"::text AND "federation_evidence_batches"."manifest"->>'domainId' = "federation_evidence_batches"."domain_id"::text AND "federation_evidence_batches"."manifest"->>'issuerSiteId' = "federation_evidence_batches"."issuer_site_id"::text AND "federation_evidence_batches"."manifest"->>'agreementRevisionId' = "federation_evidence_batches"."agreement_revision_id"::text AND "federation_evidence_batches"."manifest"->'records'->0->>'sequence' = "federation_evidence_batches"."first_sequence"::text AND jsonb_array_length("federation_evidence_batches"."manifest"->'records') BETWEEN 1 AND 100) IS TRUE)
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
CREATE TABLE "federation_evidence_streams" (
	"domain_id" uuid NOT NULL,
	"issuer_site_id" uuid NOT NULL,
	"next_sequence" numeric(20, 0) DEFAULT '1' NOT NULL,
	CONSTRAINT "federation_evidence_streams_domain_id_issuer_site_id_pk" PRIMARY KEY("domain_id","issuer_site_id"),
	CONSTRAINT "federation_evidence_sequence_positive" CHECK ("federation_evidence_streams"."next_sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "federation_execution_terminals" (
	"local_site_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"evidence" jsonb NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"source_review" jsonb,
	"authorization_policy_id" uuid,
	"approved_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_execution_terminals_local_site_id_reservation_id_pk" PRIMARY KEY("local_site_id","reservation_id"),
	CONSTRAINT "federation_execution_terminal_identity" CHECK ((
      "federation_execution_terminals"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_execution_terminals"."payload"->>'kind' = 'commercial-terminal'
      AND "federation_execution_terminals"."payload"->>'terminalId' = "federation_execution_terminals"."terminal_id"::text
      AND "federation_execution_terminals"."payload"->>'reservationId' = "federation_execution_terminals"."reservation_id"::text
      AND (("federation_execution_terminals"."payload"->>'targetSiteId' = "federation_execution_terminals"."local_site_id"::text AND "federation_execution_terminals"."source_review" IS NULL)
        OR ("federation_execution_terminals"."payload"->>'sourceSiteId' = "federation_execution_terminals"."local_site_id"::text AND "federation_execution_terminals"."source_review" IS NOT NULL AND "federation_execution_terminals"."counterparty_jws" IS NOT NULL))
      AND "federation_execution_terminals"."evidence"->>'reservationId' = "federation_execution_terminals"."reservation_id"::text
      AND "federation_execution_terminals"."evidence"->>'activationId' = "federation_execution_terminals"."payload"->>'activationId'
      AND "federation_execution_terminals"."evidence"->'workflow'->>'status' = "federation_execution_terminals"."payload"->>'outcome'
    ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_input_attempts" (
	"generation" uuid PRIMARY KEY NOT NULL,
	"media_claim_id" uuid,
	"transfer_id" uuid NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"state" varchar(24) DEFAULT 'preparing' NOT NULL,
	"storage_key" varchar(512) NOT NULL,
	"allocation_started_at" timestamp with time zone,
	"reconciliation" jsonb,
	"cleanup_token" uuid,
	"upload_id" text,
	"parts" jsonb,
	"completion_started_at" timestamp with time zone,
	"completion_settled_at" timestamp with time zone,
	"destination_version_id" text,
	"destination_etag" varchar(255),
	"verified_at" timestamp with time zone,
	"lease_until" timestamp with time zone NOT NULL,
	"last_error" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_input_attempt_state" CHECK ("federation_input_attempts"."state" IN ('preparing', 'copying', 'assembling', 'verifying', 'verified', 'available', 'cleanup_pending', 'cleaned')),
	CONSTRAINT "federation_input_attempt_upload" CHECK ("federation_input_attempts"."state" NOT IN ('copying', 'assembling', 'verifying', 'verified', 'available') OR ("federation_input_attempts"."upload_id" IS NOT NULL AND "federation_input_attempts"."allocation_started_at" IS NOT NULL)),
	CONSTRAINT "federation_input_attempt_parts" CHECK ("federation_input_attempts"."state" NOT IN ('assembling', 'verifying', 'verified', 'available') OR "federation_input_attempts"."parts" IS NOT NULL),
	CONSTRAINT "federation_input_completion_started" CHECK ("federation_input_attempts"."completion_started_at" IS NULL OR ("federation_input_attempts"."upload_id" IS NOT NULL AND "federation_input_attempts"."parts" IS NOT NULL)),
	CONSTRAINT "federation_input_completion_settled" CHECK ("federation_input_attempts"."completion_settled_at" IS NULL OR ("federation_input_attempts"."completion_started_at" IS NOT NULL AND "federation_input_attempts"."destination_etag" IS NOT NULL)),
	CONSTRAINT "federation_input_attempt_destination" CHECK ("federation_input_attempts"."state" NOT IN ('verifying', 'verified', 'available') OR ("federation_input_attempts"."completion_settled_at" IS NOT NULL AND "federation_input_attempts"."destination_version_id" IS NOT NULL AND "federation_input_attempts"."destination_version_id" != 'null')),
	CONSTRAINT "federation_input_attempt_verified" CHECK ("federation_input_attempts"."state" NOT IN ('verified', 'available') OR "federation_input_attempts"."verified_at" IS NOT NULL),
	CONSTRAINT "federation_input_attempt_allocated" CHECK ("federation_input_attempts"."upload_id" IS NULL OR "federation_input_attempts"."allocation_started_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "federation_input_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"manifest" jsonb NOT NULL,
	"delivery" varchar(16) DEFAULT 'network' NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"next_publish_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_input_import_delivery" CHECK ("federation_input_imports"."delivery" IN ('network', 'media')),
	CONSTRAINT "federation_input_import_published" CHECK ("federation_input_imports"."state" != 'available' OR ("federation_input_imports"."published_at" IS NOT NULL AND "federation_input_imports"."reserved_bytes" = 0)),
	CONSTRAINT "federation_input_import_digest" CHECK ("federation_input_imports"."manifest_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "federation_input_import_state" CHECK ("federation_input_imports"."state" IN ('pending', 'transferring', 'available', 'cancelling', 'cancelled')),
	CONSTRAINT "federation_input_import_quota" CHECK ("federation_input_imports"."reserved_bytes" BETWEEN 0 AND 9007199254740991 AND ("federation_input_imports"."state" != 'cancelled' OR "federation_input_imports"."reserved_bytes" = 0))
);
--> statement-breakpoint
CREATE TABLE "federation_input_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"descriptor" varchar(128) NOT NULL,
	"path" varchar(255) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"part_size" bigint NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_input_transfer_state" CHECK ("federation_input_transfers"."state" IN ('pending', 'copying', 'assembling', 'verifying', 'verified', 'available', 'cleanup_pending', 'cancelled')),
	CONSTRAINT "federation_input_transfer_size" CHECK ("federation_input_transfers"."size_bytes" BETWEEN 0 AND 5497558138880 AND "federation_input_transfers"."part_size" BETWEEN 5242880 AND 5368709120 AND ceil("federation_input_transfers"."size_bytes"::numeric / "federation_input_transfers"."part_size") <= 10000),
	CONSTRAINT "federation_input_transfer_hash" CHECK ("federation_input_transfers"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "federation_market_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"transaction_id" varchar(64) NOT NULL,
	"recovery" text NOT NULL,
	"stage" varchar(24) DEFAULT 'proposal' NOT NULL,
	"validation_code" integer,
	"block_number" numeric(20, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_market_attempt" CHECK ("federation_market_attempts"."number" > 0 AND "federation_market_attempts"."transaction_id" ~ '^[a-f0-9]{64}$' AND octet_length("federation_market_attempts"."recovery") BETWEEN 1 AND 4194304),
	CONSTRAINT "federation_market_result" CHECK ((("federation_market_attempts"."stage" IN ('proposal','transaction','abandoned') AND "federation_market_attempts"."validation_code" IS NULL AND "federation_market_attempts"."block_number" IS NULL) OR ("federation_market_attempts"."stage" = 'committed' AND "federation_market_attempts"."validation_code" = 0 AND "federation_market_attempts"."block_number" >= 0) OR ("federation_market_attempts"."stage" = 'invalid' AND "federation_market_attempts"."validation_code" BETWEEN 1 AND 255 AND "federation_market_attempts"."block_number" >= 0)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_market_requests" (
	"local_site_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"demand_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"direction" varchar(16) NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"source_jws" text,
	"source_fingerprint" varchar(64),
	"receipt_jws" text,
	"requested_by" uuid,
	"market_submission_id" uuid,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "federation_market_requests_local_site_id_reservation_id_pk" PRIMARY KEY("local_site_id","reservation_id"),
	CONSTRAINT "federation_market_request_state" CHECK ("federation_market_requests"."state" IN ('pending','complete','needs_review','closed') AND (("federation_market_requests"."state" = 'complete') = ("federation_market_requests"."completed_at" IS NOT NULL))),
	CONSTRAINT "federation_market_request_direction" CHECK ("federation_market_requests"."direction" IN ('outbound','inbound') AND ("federation_market_requests"."direction" <> 'inbound' OR ("federation_market_requests"."source_jws" IS NOT NULL AND "federation_market_requests"."source_fingerprint" IS NOT NULL))),
	CONSTRAINT "federation_market_request_lease" CHECK (("federation_market_requests"."lease_token" IS NULL) = ("federation_market_requests"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_market_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"authorization_policy_id" uuid,
	"demand_id" uuid NOT NULL,
	"digest" varchar(71) NOT NULL,
	"input" jsonb NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closure_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_market_submission_state" CHECK ("federation_market_submissions"."state" IN ('pending','committed','needs_review','closed')),
	CONSTRAINT "federation_market_submission_input" CHECK (("federation_market_submissions"."digest" ~ '^sha256:[a-f0-9]{64}$' AND (
        ("federation_market_submissions"."input"->>'operation' = 'publish-demand' AND "federation_market_submissions"."input"->'demand'->>'demandId' = "federation_market_submissions"."id"::text AND "federation_market_submissions"."input"->'demand'->>'demandId' = "federation_market_submissions"."demand_id"::text AND "federation_market_submissions"."input"->'demand'->>'sourceSiteId' = "federation_market_submissions"."local_site_id"::text)
        OR ("federation_market_submissions"."input"->>'operation' = 'claim-demand' AND "federation_market_submissions"."input"->'claim'->>'claimId' = "federation_market_submissions"."id"::text AND "federation_market_submissions"."input"->'claim'->>'demandId' = "federation_market_submissions"."demand_id"::text AND "federation_market_submissions"."input"->'claim'->>'providerSiteId' = "federation_market_submissions"."local_site_id"::text)
        OR ("federation_market_submissions"."input"->>'operation' = 'cancel-open-demand' AND "federation_market_submissions"."input"->'cancellation'->>'cancellationId' = "federation_market_submissions"."id"::text AND "federation_market_submissions"."input"->'cancellation'->>'demandId' = "federation_market_submissions"."demand_id"::text)
        OR ("federation_market_submissions"."input"->>'operation' = 'close-unreserved-demand' AND "federation_market_submissions"."input"->'closure'->>'closureId' = "federation_market_submissions"."id"::text AND "federation_market_submissions"."input"->'closure'->>'demandId' = "federation_market_submissions"."demand_id"::text AND "federation_market_submissions"."input"->'closure'->>'issuerSiteId' = "federation_market_submissions"."local_site_id"::text)
        OR ("federation_market_submissions"."input"->>'operation' = 'activate-demand' AND "federation_market_submissions"."input"->'activation'->>'activationId' = "federation_market_submissions"."id"::text AND "federation_market_submissions"."input"->'activation'->>'demandId' = "federation_market_submissions"."demand_id"::text)
        OR ("federation_market_submissions"."input"->>'operation' = 'authorize-execution' AND "federation_market_submissions"."input"->'authorization'->>'authorizationId' = "federation_market_submissions"."id"::text AND "federation_market_submissions"."input"->'authorization'->>'demandId' = "federation_market_submissions"."demand_id"::text AND "federation_market_submissions"."input"->'authorization'->'gate'->>'demandId' = "federation_market_submissions"."demand_id"::text AND "federation_market_submissions"."input"->'authorization'->>'issuerSiteId' = "federation_market_submissions"."local_site_id"::text)
        OR ("federation_market_submissions"."input"->>'operation' = 'request-execution-stop' AND "federation_market_submissions"."input"->'stop'->>'stopId' = "federation_market_submissions"."id"::text AND "federation_market_submissions"."input"->'stop'->>'demandId' = "federation_market_submissions"."demand_id"::text AND "federation_market_submissions"."input"->'stop'->>'issuerSiteId' = "federation_market_submissions"."local_site_id"::text)
        OR ("federation_market_submissions"."input"->>'operation' = 'close-demand' AND "federation_market_submissions"."input"->'closure'->>'closureId' = "federation_market_submissions"."id"::text AND "federation_market_submissions"."input"->'closure'->>'demandId' = "federation_market_submissions"."demand_id"::text AND "federation_market_submissions"."input"->'closure'->'gate'->>'demandId' = "federation_market_submissions"."demand_id"::text AND (("federation_market_submissions"."input"->'closure'->'gate'->>'state' = 'TERMINAL' AND "federation_market_submissions"."input"->'closure'->'gate'->'terminal'->>'terminalId' = "federation_market_submissions"."id"::text) OR ("federation_market_submissions"."input"->'closure'->'gate'->>'state' = 'REVOKED' AND "federation_market_submissions"."input"->'closure'->'gate'->>'version' = '2' AND "federation_market_submissions"."input"->'closure'->>'expectedVersion' = "federation_market_submissions"."input"->'closure'->'gate'->>'claimVersion')))
      )) IS TRUE),
	CONSTRAINT "federation_market_submission_lease" CHECK (("federation_market_submissions"."lease_token" IS NULL) = ("federation_market_submissions"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_materials" (
	"local_org_id" uuid NOT NULL,
	"origin_site_id" uuid NOT NULL,
	"digest" varchar(71) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"content" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_materials_local_org_id_origin_site_id_digest_pk" PRIMARY KEY("local_org_id","origin_site_id","digest"),
	CONSTRAINT "federation_material_kind" CHECK ("federation_materials"."kind" IN ('inputs', 'environment-lock')),
	CONSTRAINT "federation_material_digest" CHECK ("federation_materials"."digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "federation_material_size" CHECK (octet_length("federation_materials"."content") <= 1048576)
);
--> statement-breakpoint
CREATE TABLE "federation_media_devices" (
	"local_site_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"asset_tag" varchar(128) NOT NULL,
	"capacity_bytes" bigint NOT NULL,
	"registration_digest" varchar(71) NOT NULL,
	"state" varchar(16) DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_media_devices_local_site_id_device_id_pk" PRIMARY KEY("local_site_id","device_id"),
	CONSTRAINT "federation_media_device_state" CHECK ("federation_media_devices"."state" IN ('active','retired','destroyed') AND "federation_media_devices"."version" > 0 AND "federation_media_devices"."capacity_bytes" BETWEEN 1 AND 9007199254740991 AND "federation_media_devices"."registration_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "federation_media_export_operations" (
	"local_site_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"state" varchar(16) NOT NULL,
	"sha256" varchar(64),
	"size_bytes" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_media_export_operations_local_site_id_package_id_pk" PRIMARY KEY("local_site_id","package_id"),
	CONSTRAINT "federation_media_export_operations_generation_unique" UNIQUE("generation"),
	CONSTRAINT "federation_media_export_operation_result" CHECK ((
      "federation_media_export_operations"."state" IN ('queued', 'exported', 'failed') AND
      (CASE WHEN "federation_media_export_operations"."state" = 'exported' THEN "federation_media_export_operations"."sha256" ~ '^[a-f0-9]{64}$' AND "federation_media_export_operations"."size_bytes" BETWEEN 1 AND 6597069766656
       ELSE "federation_media_export_operations"."sha256" IS NULL AND "federation_media_export_operations"."size_bytes" IS NULL END)
    ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_media_exports" (
	"local_site_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"recipient_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"version_id" uuid,
	"location_id" uuid,
	"task_selection" jsonb,
	"source" jsonb NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"manifest_jws" text NOT NULL,
	"recipient" varchar(62) NOT NULL,
	"identity_encrypted" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "federation_media_exports_local_site_id_package_id_pk" PRIMARY KEY("local_site_id","package_id"),
	CONSTRAINT "federation_media_export_selector" CHECK (((
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
      )) IS TRUE),
	CONSTRAINT "federation_media_export_identity" CHECK ((
      "federation_media_exports"."manifest"->>'kind' = 'media-manifest'
      AND "federation_media_exports"."manifest"->>'packageId' = "federation_media_exports"."package_id"::text
      AND "federation_media_exports"."manifest"->>'senderSiteId' = "federation_media_exports"."local_site_id"::text
      AND "federation_media_exports"."manifest"->>'recipientSiteId' = "federation_media_exports"."recipient_site_id"::text
      AND "federation_media_exports"."manifest"->>'agreementRevisionId' = "federation_media_exports"."agreement_revision_id"::text
      AND "federation_media_exports"."local_site_id" <> "federation_media_exports"."recipient_site_id"
      AND "federation_media_exports"."manifest_digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_media_exports"."recipient" ~ '^age1[0-9a-z]{58}$'
      AND octet_length("federation_media_exports"."identity_encrypted") BETWEEN 1 AND 1024
      AND "federation_media_exports"."expires_at" > "federation_media_exports"."approved_at"
      AND "federation_media_exports"."expires_at" <= "federation_media_exports"."approved_at" + interval '7 days'
      AND (("federation_media_exports"."revoked_at" IS NULL) = ("federation_media_exports"."revocation_reason" IS NULL))) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_media_handoffs" (
	"local_site_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"version" integer NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_media_handoffs_local_site_id_event_id_pk" PRIMARY KEY("local_site_id","event_id"),
	CONSTRAINT "federation_media_handoff_identity" CHECK (("federation_media_handoffs"."version" > 1 AND "federation_media_handoffs"."payload"->>'eventId' = "federation_media_handoffs"."event_id"::text AND ("federation_media_handoffs"."payload"->>'expectedVersion')::int = "federation_media_handoffs"."version" - 1 AND "federation_media_handoffs"."payload"->>'state' IN ('dispatched','received','returning','returned','closed','cancelled','lost','damaged')) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_media_import_authorizations" (
	"authorization_id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"managed_root_id" uuid NOT NULL,
	"max_bytes" bigint NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "federation_media_import_limits" CHECK ((
      "federation_media_import_authorizations"."max_bytes" BETWEEN 0 AND 5497558138880
      AND "federation_media_import_authorizations"."expires_at" > "federation_media_import_authorizations"."approved_at"
      AND "federation_media_import_authorizations"."expires_at" <= "federation_media_import_authorizations"."approved_at" + interval '7 days'
      AND (("federation_media_import_authorizations"."revoked_at" IS NULL) = ("federation_media_import_authorizations"."revocation_reason" IS NULL))) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_media_import_operations" (
	"authorization_id" uuid PRIMARY KEY NOT NULL,
	"generation" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"state" varchar(16) NOT NULL,
	"latest_grant" jsonb,
	"verified_bytes" bigint,
	"verified_at" timestamp with time zone,
	"receipt" jsonb,
	"receipt_jws" text,
	"receipt_ack" jsonb,
	"receipt_ack_jws" text,
	"receipt_token" uuid,
	"receipt_next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"receipt_last_error" varchar(32),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_media_import_operations_generation_unique" UNIQUE("generation"),
	CONSTRAINT "federation_media_import_operation_state" CHECK (("federation_media_import_operations"."state" IN ('queued','verified','failed') AND
    (CASE WHEN "federation_media_import_operations"."state" = 'verified' THEN "federation_media_import_operations"."verified_at" IS NOT NULL AND "federation_media_import_operations"."latest_grant" IS NOT NULL AND "federation_media_import_operations"."verified_bytes" BETWEEN 0 AND 5497558138880
     ELSE "federation_media_import_operations"."verified_at" IS NULL AND "federation_media_import_operations"."verified_bytes" IS NULL END)) IS TRUE),
	CONSTRAINT "federation_media_import_operation_binding" CHECK ("federation_media_import_operations"."latest_grant" IS NULL OR (
    "federation_media_import_operations"."latest_grant"->'binding'->>'generation' = "federation_media_import_operations"."generation"::text AND
    "federation_media_import_operations"."latest_grant"->'binding'->>'authorizationId' = "federation_media_import_operations"."authorization_id"::text) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_media_key_grants" (
	"local_site_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"query_digest" varchar(71) NOT NULL,
	"response_jws" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_media_key_grants_local_site_id_query_id_pk" PRIMARY KEY("local_site_id","query_id"),
	CONSTRAINT "federation_media_key_grant_window" CHECK ("federation_media_key_grants"."expires_at" > "federation_media_key_grants"."created_at" AND "federation_media_key_grants"."expires_at" <= "federation_media_key_grants"."created_at" + interval '60 seconds'),
	CONSTRAINT "federation_media_key_grant_digest" CHECK ("federation_media_key_grants"."query_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "federation_media_packages" (
	"local_site_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"sender_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"task_input_import_id" uuid,
	"task_result_import_id" uuid,
	"manifest" jsonb NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"manifest_jws" text NOT NULL,
	"registered_by" uuid NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "federation_media_packages_local_site_id_package_id_pk" PRIMARY KEY("local_site_id","package_id"),
	CONSTRAINT "federation_media_package_target" CHECK ((("federation_media_packages"."task_input_import_id" IS NULL OR ("federation_media_packages"."manifest"->'subject'->>'kind' = 'task-input' AND "federation_media_packages"."task_result_import_id" IS NULL))
        AND ("federation_media_packages"."task_result_import_id" IS NULL OR ("federation_media_packages"."manifest"->'subject'->>'kind' = 'task-result' AND "federation_media_packages"."task_input_import_id" IS NULL))) IS TRUE),
	CONSTRAINT "federation_media_package_identity" CHECK ((
      "federation_media_packages"."manifest"->>'kind' = 'media-manifest'
      AND "federation_media_packages"."manifest"->>'packageId' = "federation_media_packages"."package_id"::text
      AND "federation_media_packages"."manifest"->>'senderSiteId' = "federation_media_packages"."sender_site_id"::text
      AND "federation_media_packages"."manifest"->>'recipientSiteId' = "federation_media_packages"."local_site_id"::text
      AND "federation_media_packages"."manifest"->>'agreementRevisionId' = "federation_media_packages"."agreement_revision_id"::text
      AND "federation_media_packages"."sender_site_id" <> "federation_media_packages"."local_site_id"
      AND "federation_media_packages"."manifest_digest" ~ '^sha256:[a-f0-9]{64}$'
      AND octet_length("federation_media_packages"."manifest_jws") BETWEEN 1 AND 524288
      AND (("federation_media_packages"."revoked_at" IS NULL) = ("federation_media_packages"."revocation_reason" IS NULL))) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_media_receipts" (
	"local_site_id" uuid NOT NULL,
	"sender_site_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"receipt" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"receipt_jws" text NOT NULL,
	"acknowledgement" jsonb NOT NULL,
	"acknowledgement_jws" text NOT NULL,
	CONSTRAINT "federation_media_receipts_local_site_id_sender_site_id_receipt_id_pk" PRIMARY KEY("local_site_id","sender_site_id","receipt_id"),
	CONSTRAINT "federation_media_receipt_scope" CHECK (("federation_media_receipts"."local_site_id" <> "federation_media_receipts"."sender_site_id" AND "federation_media_receipts"."digest" ~ '^sha256:[a-f0-9]{64}$' AND
    "federation_media_receipts"."receipt"->>'receiptId' = "federation_media_receipts"."receipt_id"::text AND "federation_media_receipts"."receipt"->>'packageId' = "federation_media_receipts"."package_id"::text AND
    "federation_media_receipts"."receipt"->>'senderSiteId' = "federation_media_receipts"."sender_site_id"::text AND "federation_media_receipts"."receipt"->>'recipientSiteId' = "federation_media_receipts"."local_site_id"::text AND
    "federation_media_receipts"."acknowledgement"->>'receiptDigest' = "federation_media_receipts"."digest") IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_media_shipment_devices" (
	"local_site_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "federation_media_shipment_devices_local_site_id_shipment_id_device_id_pk" PRIMARY KEY("local_site_id","shipment_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "federation_media_shipments" (
	"local_site_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"sender_site_id" uuid NOT NULL,
	"recipient_site_id" uuid NOT NULL,
	"packages" jsonb NOT NULL,
	"registration_digest" varchar(71) NOT NULL,
	"state" varchar(16) DEFAULT 'prepared' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_media_shipments_local_site_id_shipment_id_pk" PRIMARY KEY("local_site_id","shipment_id"),
	CONSTRAINT "federation_media_shipment_identity" CHECK (("federation_media_shipments"."sender_site_id" <> "federation_media_shipments"."recipient_site_id" AND "federation_media_shipments"."local_site_id" IN ("federation_media_shipments"."sender_site_id","federation_media_shipments"."recipient_site_id") AND "federation_media_shipments"."version" > 0 AND "federation_media_shipments"."registration_digest" ~ '^sha256:[a-f0-9]{64}$' AND jsonb_typeof("federation_media_shipments"."packages") = 'array' AND jsonb_array_length("federation_media_shipments"."packages") BETWEEN 1 AND 100 AND "federation_media_shipments"."state" IN ('prepared','dispatched','received','returning','returned','closed','cancelled','lost','damaged')) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_outbound" (
	"local_site_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"submitted_by" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"budget_domain_id" uuid NOT NULL,
	"epoch" uuid NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"settled_amount" numeric(38, 0),
	"adjustment_held_amount" numeric(38, 0) DEFAULT '0' NOT NULL,
	"endpoint" text NOT NULL,
	"request" jsonb NOT NULL,
	"request_digest" varchar(71) NOT NULL,
	"request_jws" text NOT NULL,
	"receipt" jsonb,
	"receipt_jws" text,
	"status_report" jsonb,
	"status_report_jws" text,
	"status_verified_at" timestamp with time zone,
	"status_last_error" varchar(64),
	"status_claim" uuid,
	"status_next_attempt_at" timestamp with time zone DEFAULT now(),
	"cancel_request" jsonb,
	"cancel_jws" text,
	"cancel_digest" varchar(71),
	"cancel_requested_by" uuid,
	"cancel_state" varchar(24),
	"cancel_receipt" jsonb,
	"cancel_receipt_jws" text,
	"cancel_last_error" varchar(64),
	"cancel_lease_owner" uuid,
	"cancel_lease_until" timestamp with time zone,
	"cancel_next_attempt_at" timestamp with time zone,
	"state" varchar(24) DEFAULT 'queued' NOT NULL,
	"last_error" varchar(64),
	"lease_owner" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_outbound_local_site_id_operation_id_pk" PRIMARY KEY("local_site_id","operation_id"),
	CONSTRAINT "federation_outbound_status_report" CHECK (("federation_outbound"."status_report" IS NULL AND "federation_outbound"."status_report_jws" IS NULL AND "federation_outbound"."status_verified_at" IS NULL)
        OR ("federation_outbound"."status_report" IS NOT NULL AND "federation_outbound"."status_report_jws" IS NOT NULL AND "federation_outbound"."status_verified_at" IS NOT NULL AND "federation_outbound"."state" = 'accepted')),
	CONSTRAINT "federation_outbound_state" CHECK ("federation_outbound"."state" IN ('queued', 'sending', 'accepted', 'needs_review')),
	CONSTRAINT "federation_outbound_cancel_intent" CHECK (
      ("federation_outbound"."cancel_state" IS NULL AND "federation_outbound"."cancel_request" IS NULL AND "federation_outbound"."cancel_jws" IS NULL AND "federation_outbound"."cancel_digest" IS NULL AND "federation_outbound"."cancel_requested_by" IS NULL)
      OR ("federation_outbound"."cancel_state" IS NOT NULL AND "federation_outbound"."cancel_state" IN ('queued','sending','pending','stopped','needs_review') AND "federation_outbound"."cancel_request" IS NOT NULL AND "federation_outbound"."cancel_jws" IS NOT NULL AND "federation_outbound"."cancel_digest" IS NOT NULL AND "federation_outbound"."cancel_requested_by" IS NOT NULL AND "federation_outbound"."cancel_next_attempt_at" IS NOT NULL)),
	CONSTRAINT "federation_outbound_cancel_stopped" CHECK ("federation_outbound"."cancel_state" IS DISTINCT FROM 'stopped' OR ("federation_outbound"."cancel_receipt" IS NOT NULL AND "federation_outbound"."cancel_receipt_jws" IS NOT NULL AND coalesce("federation_outbound"."cancel_receipt"->>'state' = 'stopped', false))),
	CONSTRAINT "federation_outbound_amount" CHECK ("federation_outbound"."adjustment_held_amount" >= 0 AND "federation_outbound"."adjustment_held_amount" <= "federation_outbound"."amount" AND ("federation_outbound"."adjustment_held_amount" = 0 OR "federation_outbound"."settled_amount" IS NOT NULL) AND ("federation_outbound"."settled_amount" IS NULL OR ("federation_outbound"."settled_amount" >= 0 AND "federation_outbound"."settled_amount" + "federation_outbound"."adjustment_held_amount" <= "federation_outbound"."amount")) AND "federation_outbound"."amount"::text ~ '^(0|[1-9][0-9]{0,37})$' AND "federation_outbound"."attempt" > 0),
	CONSTRAINT "federation_outbound_receipt" CHECK (("federation_outbound"."state" = 'accepted' AND "federation_outbound"."receipt" IS NOT NULL AND "federation_outbound"."receipt_jws" IS NOT NULL) OR ("federation_outbound"."state" <> 'accepted' AND "federation_outbound"."receipt" IS NULL AND "federation_outbound"."receipt_jws" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_preparations" (
	"reservation_id" uuid PRIMARY KEY NOT NULL,
	"state" varchar(16) NOT NULL,
	"blocker" varchar(64),
	"mappings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_preparation_state" CHECK (("federation_preparations"."state" = 'resolved' AND "federation_preparations"."blocker" IS NULL) OR ("federation_preparations"."state" IN ('waiting', 'blocked') AND "federation_preparations"."blocker" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_received_arbitration_decisions" (
	"local_site_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"delivery_jws" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"execution_withdrawal" jsonb,
	"execution_withdrawal_jws" text,
	CONSTRAINT "arb_received_decision_pk" PRIMARY KEY("local_site_id","decision_id"),
	CONSTRAINT "arb_received_execution_withdrawal" CHECK ((("federation_received_arbitration_decisions"."execution_withdrawal" IS NULL) = ("federation_received_arbitration_decisions"."execution_withdrawal_jws" IS NULL)
      AND ("federation_received_arbitration_decisions"."execution_withdrawal" IS NULL OR (
        "federation_received_arbitration_decisions"."execution_withdrawal"->>'kind' = 'arbitration-execution-withdrawal-receipt'
        AND "federation_received_arbitration_decisions"."execution_withdrawal"->'resolution'->>'decisionId' = "federation_received_arbitration_decisions"."decision_id"::text
        AND "federation_received_arbitration_decisions"."execution_withdrawal"->'resolution'->>'caseId' = "federation_received_arbitration_decisions"."case_id"::text
        AND "federation_received_arbitration_decisions"."execution_withdrawal"->'resolution'->>'decisionDigest' = "federation_received_arbitration_decisions"."payload"->>'decisionDigest'
        AND "federation_received_arbitration_decisions"."execution_withdrawal"->'resolution'->>'mode' IN ('bilateral_direct','bilateral_attested')
      ))) IS TRUE),
	CONSTRAINT "arb_received_decision_identity" CHECK (("federation_received_arbitration_decisions"."payload"->>'receivingSiteId' = "federation_received_arbitration_decisions"."local_site_id"::text AND "federation_received_arbitration_decisions"."payload"->>'decisionId' = "federation_received_arbitration_decisions"."decision_id"::text AND "federation_received_arbitration_decisions"."payload"->>'caseId' = "federation_received_arbitration_decisions"."case_id"::text) IS TRUE)
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
CREATE TABLE "federation_received_usage" (
	"local_site_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"report" jsonb NOT NULL,
	"report_jws" text NOT NULL,
	"digest" varchar(71) NOT NULL,
	"correction_evidence" jsonb,
	"page_jws" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_received_usage_local_site_id_report_id_pk" PRIMARY KEY("local_site_id","report_id"),
	CONSTRAINT "federation_received_usage_identity" CHECK (("federation_received_usage"."number" > 0 AND "federation_received_usage"."report"->>'reportId' = "federation_received_usage"."report_id"::text AND "federation_received_usage"."digest" ~ '^sha256:[a-f0-9]{64}$') IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_reservation_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_digest" varchar(71) NOT NULL,
	"allow_market_publish" boolean DEFAULT false NOT NULL,
	"allow_market_claim" boolean DEFAULT false NOT NULL,
	"allow_activation" boolean DEFAULT false NOT NULL,
	"allow_execution_confirmation" boolean DEFAULT false NOT NULL,
	"max_task_amount" numeric(38, 0) NOT NULL,
	"max_total_amount" numeric(38, 0) NOT NULL,
	"max_tasks" integer NOT NULL,
	"authorized_amount" numeric(38, 0) DEFAULT '0' NOT NULL,
	"authorized_tasks" integer DEFAULT 0 NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"granted_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "federation_reservation_policy_valid" CHECK ((
      "federation_reservation_policies"."valid_until" > "federation_reservation_policies"."valid_from" AND "federation_reservation_policies"."agreement_digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_reservation_policies"."max_task_amount" >= 0 AND "federation_reservation_policies"."max_total_amount" >= "federation_reservation_policies"."max_task_amount"
      AND "federation_reservation_policies"."max_tasks" BETWEEN 1 AND 100000
      AND "federation_reservation_policies"."authorized_amount" BETWEEN 0 AND "federation_reservation_policies"."max_total_amount"
      AND "federation_reservation_policies"."authorized_tasks" BETWEEN 0 AND "federation_reservation_policies"."max_tasks"
      AND (("federation_reservation_policies"."revoked_at" IS NULL) = ("federation_reservation_policies"."revoked_by" IS NULL))) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_reservation_proposals" (
	"local_site_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"direction" varchar(16) NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"source_jws" text,
	"source_fingerprint" varchar(64),
	"requested_by" uuid,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"receipt_jws" text,
	"execution_state" varchar(24) DEFAULT 'idle' NOT NULL,
	"execution_error" varchar(64),
	"execution_next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"execution_lease_token" uuid,
	"execution_lease_until" timestamp with time zone,
	"activation_id" uuid,
	"confirmation_id" uuid,
	"approved_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_reservation_proposals_local_site_id_reservation_id_pk" PRIMARY KEY("local_site_id","reservation_id"),
	CONSTRAINT "federation_execution_automation_state" CHECK (("federation_reservation_proposals"."execution_state" IN ('idle','pending','complete','needs_review','closed')
      AND (("federation_reservation_proposals"."execution_lease_token" IS NULL) = ("federation_reservation_proposals"."execution_lease_until" IS NULL))) IS TRUE),
	CONSTRAINT "federation_reservation_proposal_identity" CHECK ((
      "federation_reservation_proposals"."payload"->>'kind' = 'commercial-reservation' AND "federation_reservation_proposals"."payload"->>'reservationId' = "federation_reservation_proposals"."reservation_id"::text
      AND "federation_reservation_proposals"."payload"->'request'->>'agreementRevisionId' = "federation_reservation_proposals"."agreement_revision_id"::text
      AND "federation_reservation_proposals"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND (("federation_reservation_proposals"."direction" = 'outbound' AND "federation_reservation_proposals"."requested_by" IS NOT NULL AND "federation_reservation_proposals"."source_fingerprint" IS NULL)
        OR ("federation_reservation_proposals"."direction" = 'inbound' AND "federation_reservation_proposals"."requested_by" IS NULL AND "federation_reservation_proposals"."source_fingerprint" ~ '^[a-f0-9]{64}$' AND "federation_reservation_proposals"."source_jws" IS NOT NULL))) IS TRUE),
	CONSTRAINT "federation_reservation_proposal_state" CHECK ((
      "federation_reservation_proposals"."state" IN ('pending','sending','delivered','approved','needs_review','closed')
      AND (("federation_reservation_proposals"."lease_token" IS NULL) = ("federation_reservation_proposals"."lease_until" IS NULL))
      AND ("federation_reservation_proposals"."state" <> 'pending' OR "federation_reservation_proposals"."approved_at" IS NULL)
      AND ("federation_reservation_proposals"."state" NOT IN ('sending','delivered') OR ("federation_reservation_proposals"."direction" = 'outbound' AND "federation_reservation_proposals"."approved_at" IS NOT NULL AND "federation_reservation_proposals"."source_jws" IS NOT NULL))
      AND ("federation_reservation_proposals"."state" <> 'approved' OR ("federation_reservation_proposals"."direction" = 'inbound' AND "federation_reservation_proposals"."approved_at" IS NOT NULL))
      AND (("federation_reservation_proposals"."delivered_at" IS NULL) = ("federation_reservation_proposals"."receipt_jws" IS NULL))
      AND ("federation_reservation_proposals"."state" <> 'delivered' OR "federation_reservation_proposals"."delivered_at" IS NOT NULL)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"sender_site_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"request_digest" varchar(71) NOT NULL,
	"request_jws" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"settled_amount" numeric(38, 0),
	"receipt" jsonb NOT NULL,
	"receipt_jws" text,
	"state" varchar(24) DEFAULT 'pending_signature' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_reservation_amount" CHECK (("federation_reservations"."settled_amount" IS NULL OR ("federation_reservations"."settled_amount" >= 0 AND "federation_reservations"."settled_amount" <= "federation_reservations"."amount")) AND "federation_reservations"."amount"::text ~ '^(0|[1-9][0-9]{0,37})$' AND "federation_reservations"."attempt" > 0),
	CONSTRAINT "federation_reservation_signature" CHECK (
      ("federation_reservations"."state" = 'pending_signature' AND "federation_reservations"."receipt_jws" IS NULL)
      OR ("federation_reservations"."state" = 'reserved' AND "federation_reservations"."receipt_jws" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_result_attempts" (
	"generation" uuid PRIMARY KEY NOT NULL,
	"media_claim_id" uuid,
	"transfer_id" uuid NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"state" varchar(24) DEFAULT 'preparing' NOT NULL,
	"storage_key" varchar(512) NOT NULL,
	"upload_id" text,
	"parts" jsonb,
	"destination_version_id" text,
	"destination_etag" varchar(255),
	"verified_at" timestamp with time zone,
	"lease_until" timestamp with time zone NOT NULL,
	"last_error" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_result_attempt_state" CHECK ("federation_result_attempts"."state" IN ('preparing','copying','assembling','verifying','verified','available','cleanup_pending','cleaned')),
	CONSTRAINT "federation_result_attempt_upload" CHECK ("federation_result_attempts"."state" NOT IN ('copying','assembling','verifying','verified','available') OR "federation_result_attempts"."upload_id" IS NOT NULL),
	CONSTRAINT "federation_result_attempt_destination" CHECK ("federation_result_attempts"."state" NOT IN ('verifying','verified','available') OR "federation_result_attempts"."destination_etag" IS NOT NULL),
	CONSTRAINT "federation_result_attempt_verified" CHECK ("federation_result_attempts"."state" NOT IN ('verified','available') OR "federation_result_attempts"."verified_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "federation_result_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"report" jsonb NOT NULL,
	"delivery" varchar(16) DEFAULT 'network' NOT NULL,
	"report_jws" text NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"receipt" jsonb,
	"receipt_jws" text,
	"receipt_ack" jsonb,
	"receipt_ack_jws" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" varchar(64),
	"receipt_next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"receipt_last_error" varchar(64),
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_result_import_delivery" CHECK ("federation_result_imports"."delivery" IN ('network', 'media')),
	CONSTRAINT "federation_result_import_receipt" CHECK (("federation_result_imports"."receipt" IS NULL OR "federation_result_imports"."state" = 'available') AND ("federation_result_imports"."receipt_jws" IS NULL OR "federation_result_imports"."receipt" IS NOT NULL) AND (("federation_result_imports"."receipt_ack" IS NULL AND "federation_result_imports"."receipt_ack_jws" IS NULL) OR ("federation_result_imports"."receipt_ack" IS NOT NULL AND "federation_result_imports"."receipt_ack_jws" IS NOT NULL AND "federation_result_imports"."receipt_jws" IS NOT NULL))),
	CONSTRAINT "federation_result_import_reservation" CHECK ("federation_result_imports"."reserved_bytes" >= 0),
	CONSTRAINT "federation_result_import_state" CHECK ("federation_result_imports"."state" IN ('pending','transferring','verifying','available','cancelled','needs_review'))
);
--> statement-breakpoint
CREATE TABLE "federation_result_receipts" (
	"local_site_id" uuid NOT NULL,
	"sender_site_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"receipt" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"receipt_jws" text NOT NULL,
	"acknowledgement" jsonb NOT NULL,
	"acknowledgement_jws" text NOT NULL,
	CONSTRAINT "federation_result_receipts_local_site_id_sender_site_id_receipt_id_pk" PRIMARY KEY("local_site_id","sender_site_id","receipt_id")
);
--> statement-breakpoint
CREATE TABLE "federation_result_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"output_id" varchar(71) NOT NULL,
	"path" varchar(255) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"part_size" bigint NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_result_transfer_state" CHECK ("federation_result_transfers"."state" IN ('pending','copying','assembling','verifying','verified','available','cleanup_pending','cancelled')),
	CONSTRAINT "federation_result_transfer_size" CHECK ("federation_result_transfers"."size_bytes" >= 0 AND "federation_result_transfers"."size_bytes" <= 5497558138880 AND "federation_result_transfers"."part_size" >= 5242880 AND "federation_result_transfers"."part_size" <= 5368709120),
	CONSTRAINT "federation_result_transfer_hash" CHECK ("federation_result_transfers"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "federation_signing_keys" (
	"site_id" uuid NOT NULL,
	"key_id" varchar(128) NOT NULL,
	"public_key_pem" text NOT NULL,
	"allowed_kinds" jsonb NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "federation_signing_keys_site_id_key_id_pk" PRIMARY KEY("site_id","key_id"),
	CONSTRAINT "federation_key_interval" CHECK ("federation_signing_keys"."valid_from" < "federation_signing_keys"."valid_until")
);
--> statement-breakpoint
CREATE TABLE "federation_sites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"endpoint" text NOT NULL,
	"state" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_site_state" CHECK ("federation_sites"."state" IN ('active', 'suspended', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "federation_task_media_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_input_import_id" uuid,
	"task_result_import_id" uuid,
	"authorization_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"upload_grant_token" uuid,
	"upload_grant" jsonb,
	CONSTRAINT "federation_task_media_claim_direction" CHECK (num_nonnulls("federation_task_media_claims"."task_input_import_id", "federation_task_media_claims"."task_result_import_id") = 1),
	CONSTRAINT "federation_task_media_claim_time" CHECK ("federation_task_media_claims"."released_at" IS NULL OR "federation_task_media_claims"."released_at" >= "federation_task_media_claims"."claimed_at"),
	CONSTRAINT "federation_task_media_upload_grant" CHECK ("federation_task_media_claims"."upload_grant" IS NULL OR ("federation_task_media_claims"."upload_grant_token" IS NOT NULL AND
        "federation_task_media_claims"."upload_grant"->'binding'->>'authorizationId' = "federation_task_media_claims"."authorization_id"::text AND
        "federation_task_media_claims"."upload_grant"->'binding'->>'generation' = "federation_task_media_claims"."generation"::text) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_terminal_chunks" (
	"local_site_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"offset" integer NOT NULL,
	"bytes" text NOT NULL,
	CONSTRAINT "federation_terminal_chunks_local_site_id_reservation_id_offset_pk" PRIMARY KEY("local_site_id","reservation_id","offset"),
	CONSTRAINT "federation_terminal_chunk_size" CHECK ("federation_terminal_chunks"."offset" BETWEEN 0 AND 16777215 AND "federation_terminal_chunks"."offset" % 65536 = 0 AND octet_length("federation_terminal_chunks"."bytes") BETWEEN 4 AND 87384)
);
--> statement-breakpoint
CREATE TABLE "federation_terminal_evidence" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"evidence" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_terminal_digest" CHECK ("federation_terminal_evidence"."digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "federation_terminal_identity" CHECK (coalesce(
      "federation_terminal_evidence"."evidence"->>'version' = '1'
      AND "federation_terminal_evidence"."evidence"->>'jobId' = "federation_terminal_evidence"."job_id"::text
      AND "federation_terminal_evidence"."evidence"->>'reservationId' = "federation_terminal_evidence"."reservation_id"::text
      AND "federation_terminal_evidence"."evidence"->>'runId' = "federation_terminal_evidence"."workflow_run_id"::text
      AND "federation_terminal_evidence"."evidence"->>'status' IN ('completed','failed','cancelled'), false))
);
--> statement-breakpoint
CREATE TABLE "federation_terminal_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_digest" varchar(71) NOT NULL,
	"outcomes" jsonb NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"granted_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "federation_terminal_policy_valid" CHECK (("federation_terminal_policies"."valid_until" > "federation_terminal_policies"."valid_from" AND "federation_terminal_policies"."agreement_digest" ~ '^sha256:[a-f0-9]{64}$' AND jsonb_typeof("federation_terminal_policies"."outcomes") = 'array' AND jsonb_array_length("federation_terminal_policies"."outcomes") BETWEEN 1 AND 3 AND "federation_terminal_policies"."outcomes" <@ '["completed","failed","cancelled"]'::jsonb AND (("federation_terminal_policies"."revoked_at" IS NULL) = ("federation_terminal_policies"."revoked_by" IS NULL))) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_terminal_syncs" (
	"local_site_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"terminal_id" uuid,
	"proposal_digest" varchar(71),
	"total_bytes" integer,
	"next_offset" integer DEFAULT 0 NOT NULL,
	"proposal" jsonb,
	"acknowledgement_jws" text,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "federation_terminal_syncs_local_site_id_reservation_id_pk" PRIMARY KEY("local_site_id","reservation_id"),
	CONSTRAINT "federation_terminal_sync_state" CHECK ("federation_terminal_syncs"."state" IN ('pending','ready','complete','needs_review')),
	CONSTRAINT "federation_terminal_sync_lease" CHECK (("federation_terminal_syncs"."lease_token" IS NULL) = ("federation_terminal_syncs"."lease_until" IS NULL)),
	CONSTRAINT "federation_terminal_sync_content" CHECK (((
    ("federation_terminal_syncs"."terminal_id" IS NULL AND "federation_terminal_syncs"."proposal_digest" IS NULL AND "federation_terminal_syncs"."total_bytes" IS NULL AND "federation_terminal_syncs"."next_offset" = 0 AND "federation_terminal_syncs"."proposal" IS NULL)
    OR ("federation_terminal_syncs"."terminal_id" IS NOT NULL AND "federation_terminal_syncs"."proposal_digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_terminal_syncs"."total_bytes" BETWEEN 1 AND 16777216
      AND "federation_terminal_syncs"."next_offset" BETWEEN 1 AND "federation_terminal_syncs"."total_bytes"
      AND (("federation_terminal_syncs"."proposal" IS NULL AND "federation_terminal_syncs"."next_offset" % 65536 = 0) OR
        ("federation_terminal_syncs"."proposal"->'payload'->>'terminalId' = "federation_terminal_syncs"."terminal_id"::text AND "federation_terminal_syncs"."next_offset" = "federation_terminal_syncs"."total_bytes")))
    ) AND ("federation_terminal_syncs"."state" <> 'ready' OR "federation_terminal_syncs"."proposal" IS NOT NULL)
      AND (("federation_terminal_syncs"."state" = 'complete') = ("federation_terminal_syncs"."acknowledgement_jws" IS NOT NULL))) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_unreserved_closures" (
	"local_site_id" uuid NOT NULL,
	"demand_id" uuid NOT NULL,
	"origin_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_unreserved_closures_local_site_id_demand_id_pk" PRIMARY KEY("local_site_id","demand_id"),
	CONSTRAINT "federation_unreserved_closure_identity" CHECK ((
      "federation_unreserved_closures"."digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_unreserved_closures"."payload"->>'status' = 'CLOSED'
      AND "federation_unreserved_closures"."payload"->'demand'->>'demandId' = "federation_unreserved_closures"."demand_id"::text
      AND "federation_unreserved_closures"."payload"->'unreservedClosure'->>'demandId' = "federation_unreserved_closures"."demand_id"::text
      AND "federation_unreserved_closures"."payload"->'unreservedClosure'->>'claimId' = "federation_unreserved_closures"."payload"->'claim'->>'claimId'
      AND ("federation_unreserved_closures"."payload"->'demand'->>'sourceSiteId' = "federation_unreserved_closures"."local_site_id"::text
        OR "federation_unreserved_closures"."payload"->'claim'->>'providerSiteId' = "federation_unreserved_closures"."local_site_id"::text)
    ) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_usage_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"report" jsonb NOT NULL,
	"correction_evidence" jsonb,
	"report_jws" text NOT NULL,
	"digest" varchar(71) NOT NULL,
	"evidence_set" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_usage_report_identity" CHECK (coalesce("federation_usage_reports"."number" > 0 AND "federation_usage_reports"."report"->>'reportId' = "federation_usage_reports"."id"::text
    AND "federation_usage_reports"."evidence_set"->>'reservationId' = "federation_usage_reports"."reservation_id"::text AND "federation_usage_reports"."digest" ~ '^sha256:[a-f0-9]{64}$',false))
);
--> statement-breakpoint
CREATE TABLE "federation_usage_syncs" (
	"local_site_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"number" integer DEFAULT 0 NOT NULL,
	"last_report_id" uuid,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"provider_state" varchar(24),
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "federation_usage_syncs_local_site_id_operation_id_pk" PRIMARY KEY("local_site_id","operation_id"),
	CONSTRAINT "federation_usage_sync_state" CHECK ("federation_usage_syncs"."state" IN ('pending','needs_review') AND "federation_usage_syncs"."number" >= 0 AND (("federation_usage_syncs"."number" = 0) = ("federation_usage_syncs"."last_report_id" IS NULL)) AND (("federation_usage_syncs"."lease_token" IS NULL) = ("federation_usage_syncs"."lease_until" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "federation_usage_tasks" (
	"reservation_id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" varchar(64),
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_usage_task_state" CHECK ("federation_usage_tasks"."state" IN ('pending','missing_data','needs_review','reported'))
);
--> statement-breakpoint
CREATE TABLE "federation_workflow_bindings" (
	"reservation_id" uuid PRIMARY KEY NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"snapshot_digest" varchar(71) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_workflow_snapshot_digest" CHECK ("federation_workflow_bindings"."snapshot_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "federation_workflow_input_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"path_hash" varchar(64) NOT NULL,
	"path" text NOT NULL,
	"node_id" varchar(1024) NOT NULL,
	"local_org_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"intent_digest" varchar(71) NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"bindings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_input_export_path" CHECK ("federation_workflow_input_exports"."path_hash" ~ '^[a-f0-9]{64}$' AND octet_length("federation_workflow_input_exports"."path") BETWEEN 1 AND 16384),
	CONSTRAINT "federation_input_export_digest" CHECK ("federation_workflow_input_exports"."intent_digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_workflow_input_exports"."manifest_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "federation_input_export_bindings" CHECK (jsonb_typeof("federation_workflow_input_exports"."bindings") = 'array' AND jsonb_array_length("federation_workflow_input_exports"."bindings") <= 256)
);
--> statement-breakpoint
CREATE TABLE "job_dispatch_outbox" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"dispatch_epoch" integer NOT NULL,
	"payload_base64" text NOT NULL,
	"workflow_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "job_dispatch_outbox_epoch" CHECK ("job_dispatch_outbox"."dispatch_epoch" > 0)
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_delegations" (
	"run_id" uuid NOT NULL,
	"path_hash" varchar(64) NOT NULL,
	"path" text NOT NULL,
	"node_id" text NOT NULL,
	"local_site_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"intent_digest" varchar(64) NOT NULL,
	"request" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_execution_delegations_run_id_path_hash_pk" PRIMARY KEY("run_id","path_hash"),
	CONSTRAINT "workflow_execution_delegation_hash" CHECK ("workflow_execution_delegations"."path_hash" ~ '^[0-9a-f]{64}$' AND "workflow_execution_delegations"."intent_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workflow_execution_delegation_request" CHECK ("workflow_execution_delegations"."request"->>'operationId' = "workflow_execution_delegations"."operation_id"::text AND "workflow_execution_delegations"."request"->>'senderSiteId' = "workflow_execution_delegations"."local_site_id"::text)
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_jobs" (
	"run_id" uuid NOT NULL,
	"path_hash" varchar(64) NOT NULL,
	"path" text NOT NULL,
	"node_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"intent" jsonb NOT NULL,
	"published_files" jsonb,
	"dispatch_state" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_execution_jobs_run_id_path_hash_pk" PRIMARY KEY("run_id","path_hash"),
	CONSTRAINT "workflow_execution_job_hash" CHECK ("workflow_execution_jobs"."path_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workflow_execution_job_dispatch_state" CHECK ("workflow_execution_jobs"."dispatch_state" IN ('pending', 'acknowledged'))
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_journal" (
	"run_id" uuid NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"key" text NOT NULL,
	"entry" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_execution_journal_run_id_key_hash_pk" PRIMARY KEY("run_id","key_hash"),
	CONSTRAINT "workflow_execution_journal_hash" CHECK ("workflow_execution_journal"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workflow_execution_journal_kind" CHECK ("workflow_execution_journal"."entry"->>'kind' IN ('definition', 'version', 'node'))
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_leases" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"token" uuid,
	"expires_at" timestamp with time zone,
	CONSTRAINT "workflow_execution_lease_pair" CHECK (("workflow_execution_leases"."token" IS NULL) = ("workflow_execution_leases"."expires_at" IS NULL))
);
--> statement-breakpoint
DROP INDEX "job_cancellations_job_idx";--> statement-breakpoint
DROP INDEX "workflow_artifacts_run_node_descriptor_idx";--> statement-breakpoint
ALTER TABLE "job_cancellations" ADD COLUMN "requires_installation_stop" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "sandbox_stats_recorded_at" timestamp;--> statement-breakpoint
ALTER TABLE "netdrive_files" ADD COLUMN "storage_version_id" varchar(2048);--> statement-breakpoint
ALTER TABLE "software_operations" ADD COLUMN "replay_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "software_operations" ADD COLUMN "federation_job_id" uuid;--> statement-breakpoint
ALTER TABLE "software_operations" ADD COLUMN "next_dispatch_at" timestamp;--> statement-breakpoint
ALTER TABLE "software_operations" ADD COLUMN "manifest_digest" varchar(71);--> statement-breakpoint
ALTER TABLE "workflow_artifacts" ADD COLUMN "producer_job_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_artifacts" ADD COLUMN "file_members" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "waiting_invocations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_artifact_files" ADD CONSTRAINT "workflow_artifact_files_artifact_id_workflow_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."workflow_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_artifact_files" ADD CONSTRAINT "workflow_artifact_files_netdrive_file_id_netdrive_files_id_fk" FOREIGN KEY ("netdrive_file_id") REFERENCES "public"."netdrive_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_accounting_collections" ADD CONSTRAINT "federation_accounting_collections_job_id_federation_terminal_evidence_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."federation_terminal_evidence"("job_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_agreement_approvals" ADD CONSTRAINT "federation_agreement_approvals_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_agreement_approvals" ADD CONSTRAINT "federation_agreement_approvals_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_agreement_approvals" ADD CONSTRAINT "federation_agreement_approvals_execution_user_id_users_id_fk" FOREIGN KEY ("execution_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_agreement_approvals" ADD CONSTRAINT "federation_agreement_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_agreement_syncs" ADD CONSTRAINT "federation_agreement_sync_approval_fk" FOREIGN KEY ("local_site_id","revision_id") REFERENCES "public"."federation_agreement_approvals"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_agreements" ADD CONSTRAINT "federation_agreements_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_agreements" ADD CONSTRAINT "federation_agreements_execution_user_id_users_id_fk" FOREIGN KEY ("execution_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_agreements" ADD CONSTRAINT "federation_agreements_budget_domain_id_epoch_federation_budgets_domain_id_epoch_fk" FOREIGN KEY ("budget_domain_id","epoch") REFERENCES "public"."federation_budgets"("domain_id","epoch") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_decision_deliveries" ADD CONSTRAINT "federation_arbitration_decision_deliveries_receiving_site_id_federation_sites_id_fk" FOREIGN KEY ("receiving_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_decision_deliveries" ADD CONSTRAINT "arb_decision_delivery_original_fk" FOREIGN KEY ("local_site_id","decision_id") REFERENCES "public"."federation_arbitration_decisions"("local_site_id","decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_decisions" ADD CONSTRAINT "federation_arbitration_decisions_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_decisions" ADD CONSTRAINT "federation_arbitration_decisions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_decisions" ADD CONSTRAINT "federation_arbitration_decision_case_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_evidence_cases"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" ADD CONSTRAINT "federation_arbitration_policies_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" ADD CONSTRAINT "federation_arbitration_policies_arbitrator_site_id_federation_sites_id_fk" FOREIGN KEY ("arbitrator_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" ADD CONSTRAINT "federation_arbitration_policies_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" ADD CONSTRAINT "federation_arbitration_policies_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" ADD CONSTRAINT "federation_arbitration_policies_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD CONSTRAINT "federation_arbitration_resolutions_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD CONSTRAINT "federation_arbitration_resolutions_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD CONSTRAINT "arb_resolution_received_fk" FOREIGN KEY ("local_site_id","decision_id") REFERENCES "public"."federation_received_arbitration_decisions"("local_site_id","decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_revocation_deliveries" ADD CONSTRAINT "arb_revocation_delivery_policy_fk" FOREIGN KEY ("local_site_id","policy_id") REFERENCES "public"."federation_arbitration_policies"("local_site_id","policy_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_asset_mappings" ADD CONSTRAINT "federation_asset_mappings_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_asset_mappings" ADD CONSTRAINT "federation_asset_mappings_origin_site_id_federation_sites_id_fk" FOREIGN KEY ("origin_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_asset_mappings" ADD CONSTRAINT "federation_asset_mappings_software_revision_id_software_asset_revisions_id_fk" FOREIGN KEY ("software_revision_id") REFERENCES "public"."software_asset_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_asset_mappings" ADD CONSTRAINT "federation_asset_mappings_data_version_id_data_asset_versions_id_fk" FOREIGN KEY ("data_version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_asset_mappings" ADD CONSTRAINT "federation_asset_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_attestation_attempts" ADD CONSTRAINT "federation_attestation_attempts_batch_id_federation_evidence_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."federation_evidence_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_attestation_outbox" ADD CONSTRAINT "federation_attestation_outbox_evidence_id_federation_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."federation_evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_attestation_outbox" ADD CONSTRAINT "federation_attestation_outbox_batch_id_federation_evidence_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."federation_evidence_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_cancellations" ADD CONSTRAINT "federation_cancellations_agreement_revision_id_federation_agreements_revision_id_fk" FOREIGN KEY ("agreement_revision_id") REFERENCES "public"."federation_agreements"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capabilities_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capabilities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capabilities_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_arbitration_decisions" ADD CONSTRAINT "federation_case_arbitration_decisions_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_arbitration_decisions" ADD CONSTRAINT "federation_case_arbitration_decisions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_arbitration_decisions" ADD CONSTRAINT "federation_case_decision_original_fk" FOREIGN KEY ("local_site_id","decision_id") REFERENCES "public"."federation_arbitration_decisions"("local_site_id","decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_attempts" ADD CONSTRAINT "federation_case_attempts_submission_id_federation_case_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."federation_case_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_publications" ADD CONSTRAINT "federation_case_publications_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_publications" ADD CONSTRAINT "federation_case_publications_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_publications" ADD CONSTRAINT "federation_case_publications_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_publications" ADD CONSTRAINT "federation_case_publications_local_site_id_grant_id_federation_disclosures_local_site_id_grant_id_fk" FOREIGN KEY ("local_site_id","grant_id") REFERENCES "public"."federation_disclosures"("local_site_id","grant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_publications" ADD CONSTRAINT "federation_case_publications_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_revocation_deliveries" ADD CONSTRAINT "federation_case_revocation_delivery_publication_fk" FOREIGN KEY ("local_site_id","publication_id") REFERENCES "public"."federation_case_publications"("local_site_id","publication_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_submissions" ADD CONSTRAINT "federation_case_submission_publication_fk" FOREIGN KEY ("local_site_id","publication_id") REFERENCES "public"."federation_case_publications"("local_site_id","publication_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_submissions" ADD CONSTRAINT "federation_case_submission_decision_fk" FOREIGN KEY ("local_site_id","arbitration_decision_id") REFERENCES "public"."federation_case_arbitration_decisions"("local_site_id","decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_certificates" ADD CONSTRAINT "federation_certificates_site_id_federation_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_closing_policies" ADD CONSTRAINT "federation_closing_policies_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_closing_policies" ADD CONSTRAINT "federation_closing_policies_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_closing_policies" ADD CONSTRAINT "federation_closing_policies_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_closing_policies" ADD CONSTRAINT "federation_closing_policies_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_closing_tasks" ADD CONSTRAINT "federation_closing_tasks_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_closing_tasks" ADD CONSTRAINT "federation_closing_tasks_policy_id_federation_closing_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."federation_closing_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_closing_tasks" ADD CONSTRAINT "federation_closing_tasks_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" ADD CONSTRAINT "federation_commercial_adjustments_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" ADD CONSTRAINT "federation_commercial_adjustments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" ADD CONSTRAINT "federation_commercial_adjustments_local_site_id_arbitration_decision_id_federation_arbitration_resolutions_local_site_id_decision_id_fk" FOREIGN KEY ("local_site_id","arbitration_decision_id") REFERENCES "public"."federation_arbitration_resolutions"("local_site_id","decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" ADD CONSTRAINT "federation_commercial_adjustments_local_site_id_settlement_id_federation_commercial_settlements_local_site_id_settlement_id_fk" FOREIGN KEY ("local_site_id","settlement_id") REFERENCES "public"."federation_commercial_settlements"("local_site_id","settlement_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" ADD CONSTRAINT "federation_commercial_adjustments_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_agreements" ADD CONSTRAINT "federation_commercial_agreements_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_agreements" ADD CONSTRAINT "federation_commercial_agreements_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_agreements" ADD CONSTRAINT "federation_commercial_agreements_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_approval_syncs" ADD CONSTRAINT "federation_approval_sync_contract_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_attempts" ADD CONSTRAINT "federation_commercial_attempts_submission_id_federation_commercial_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."federation_commercial_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_bills" ADD CONSTRAINT "federation_commercial_bills_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_bills" ADD CONSTRAINT "federation_commercial_bills_authorization_policy_id_federation_closing_policies_id_fk" FOREIGN KEY ("authorization_policy_id") REFERENCES "public"."federation_closing_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_bills" ADD CONSTRAINT "federation_commercial_bills_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_bills" ADD CONSTRAINT "federation_commercial_bills_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_discounts" ADD CONSTRAINT "federation_commercial_discounts_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_discounts" ADD CONSTRAINT "federation_commercial_discounts_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_discounts" ADD CONSTRAINT "federation_commercial_discounts_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD CONSTRAINT "federation_commercial_execution_approvals_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD CONSTRAINT "federation_commercial_execution_approvals_authorization_policy_id_federation_reservation_policies_id_fk" FOREIGN KEY ("authorization_policy_id") REFERENCES "public"."federation_reservation_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD CONSTRAINT "federation_commercial_execution_approvals_stop_requested_by_users_id_fk" FOREIGN KEY ("stop_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD CONSTRAINT "federation_commercial_execution_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD CONSTRAINT "federation_commercial_execution_approvals_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_history_recoveries" ADD CONSTRAINT "federation_commercial_history_recoveries_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_history_recoveries" ADD CONSTRAINT "federation_commercial_history_recoveries_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_history_recoveries" ADD CONSTRAINT "federation_commercial_history_recoveries_submission_id_federation_commercial_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."federation_commercial_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_history_recoveries" ADD CONSTRAINT "federation_commercial_history_recoveries_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_history_recoveries" ADD CONSTRAINT "federation_commercial_history_recoveries_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_payments" ADD CONSTRAINT "federation_commercial_payments_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_payments" ADD CONSTRAINT "federation_commercial_payments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_payments" ADD CONSTRAINT "federation_commercial_payments_local_site_id_bill_id_federation_commercial_bills_local_site_id_bill_id_fk" FOREIGN KEY ("local_site_id","bill_id") REFERENCES "public"."federation_commercial_bills"("local_site_id","bill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_payments" ADD CONSTRAINT "federation_commercial_payments_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_refunds" ADD CONSTRAINT "federation_commercial_refunds_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_refunds" ADD CONSTRAINT "federation_commercial_refunds_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_refunds" ADD CONSTRAINT "federation_commercial_refunds_authorization_policy_id_federation_closing_policies_id_fk" FOREIGN KEY ("authorization_policy_id") REFERENCES "public"."federation_closing_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_refunds" ADD CONSTRAINT "federation_commercial_refunds_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD CONSTRAINT "federation_commercial_settlements_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD CONSTRAINT "federation_commercial_settlements_authorization_policy_id_federation_closing_policies_id_fk" FOREIGN KEY ("authorization_policy_id") REFERENCES "public"."federation_closing_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD CONSTRAINT "federation_commercial_settlements_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD CONSTRAINT "federation_commercial_settlements_local_site_id_arbitration_decision_id_federation_arbitration_resolutions_local_site_id_decision_id_fk" FOREIGN KEY ("local_site_id","arbitration_decision_id") REFERENCES "public"."federation_arbitration_resolutions"("local_site_id","decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD CONSTRAINT "federation_commercial_settlements_local_site_id_bill_id_federation_commercial_bills_local_site_id_bill_id_fk" FOREIGN KEY ("local_site_id","bill_id") REFERENCES "public"."federation_commercial_bills"("local_site_id","bill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD CONSTRAINT "federation_commercial_settlements_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" ADD CONSTRAINT "federation_commercial_submissions_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_completion_claims" ADD CONSTRAINT "federation_completion_claims_local_site_id_federation_completion_pools_local_site_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_completion_pools"("local_site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_assets" ADD CONSTRAINT "federation_dataset_assets_asset_id_data_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."data_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_assets" ADD CONSTRAINT "federation_dataset_assets_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_assets" ADD CONSTRAINT "federation_dataset_assets_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_assets" ADD CONSTRAINT "federation_dataset_assets_source_site_id_federation_sites_id_fk" FOREIGN KEY ("source_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_replicas" ADD CONSTRAINT "federation_dataset_replicas_asset_id_federation_dataset_assets_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."federation_dataset_assets"("asset_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_replicas" ADD CONSTRAINT "federation_dataset_replicas_version_id_data_asset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_replicas" ADD CONSTRAINT "federation_dataset_replicas_location_id_data_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."data_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_replicas" ADD CONSTRAINT "federation_dataset_replicas_authorization_id_federation_media_import_authorizations_authorization_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."federation_media_import_authorizations"("authorization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_replicas" ADD CONSTRAINT "federation_dataset_replicas_agreement_revision_id_federation_agreements_revision_id_fk" FOREIGN KEY ("agreement_revision_id") REFERENCES "public"."federation_agreements"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_replicas" ADD CONSTRAINT "federation_dataset_replicas_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_use_grants" ADD CONSTRAINT "federation_dataset_use_grants_local_site_id_policy_id_federation_dataset_use_policies_local_site_id_policy_id_fk" FOREIGN KEY ("local_site_id","policy_id") REFERENCES "public"."federation_dataset_use_policies"("local_site_id","policy_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_use_policies" ADD CONSTRAINT "federation_dataset_use_policies_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_use_policies" ADD CONSTRAINT "federation_dataset_use_policies_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_use_policies" ADD CONSTRAINT "federation_dataset_use_policies_recipient_site_id_federation_sites_id_fk" FOREIGN KEY ("recipient_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_use_policies" ADD CONSTRAINT "federation_dataset_use_policies_version_id_data_asset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_use_policies" ADD CONSTRAINT "federation_dataset_use_policies_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_use_policies" ADD CONSTRAINT "federation_dataset_use_approval" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_agreement_approvals"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosure_downloads" ADD CONSTRAINT "federation_disclosure_download_grant_fk" FOREIGN KEY ("local_site_id","grant_id") REFERENCES "public"."federation_disclosures"("local_site_id","grant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosure_policies" ADD CONSTRAINT "federation_disclosure_policies_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosure_policies" ADD CONSTRAINT "federation_disclosure_policies_recipient_site_id_federation_sites_id_fk" FOREIGN KEY ("recipient_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosure_policies" ADD CONSTRAINT "federation_disclosure_policies_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosure_policies" ADD CONSTRAINT "federation_disclosure_policies_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosure_policies" ADD CONSTRAINT "federation_disclosure_policies_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosure_read_authorizations" ADD CONSTRAINT "federation_disclosure_read_grant_fk" FOREIGN KEY ("local_site_id","grant_id") REFERENCES "public"."federation_disclosures"("local_site_id","grant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_recipient_site_id_federation_sites_id_fk" FOREIGN KEY ("recipient_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_local_site_id_case_id_federation_disputes_local_site_id_case_id_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_disputes"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_local_site_id_policy_id_federation_disclosure_policies_local_site_id_policy_id_fk" FOREIGN KEY ("local_site_id","policy_id") REFERENCES "public"."federation_disclosure_policies"("local_site_id","policy_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dispute_deliveries" ADD CONSTRAINT "federation_dispute_delivery_case_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_disputes"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dispute_freezes" ADD CONSTRAINT "federation_dispute_freeze_case_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_disputes"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dispute_resolutions" ADD CONSTRAINT "dispute_resolution_case_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_disputes"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disputes" ADD CONSTRAINT "federation_disputes_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disputes" ADD CONSTRAINT "federation_disputes_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disputes" ADD CONSTRAINT "federation_disputes_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence" ADD CONSTRAINT "federation_evidence_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence_batches" ADD CONSTRAINT "federation_evidence_batches_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence_batches" ADD CONSTRAINT "federation_evidence_batches_agreement_revision_id_federation_agreements_revision_id_fk" FOREIGN KEY ("agreement_revision_id") REFERENCES "public"."federation_agreements"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence_batches" ADD CONSTRAINT "federation_evidence_batches_domain_id_issuer_site_id_federation_evidence_streams_domain_id_issuer_site_id_fk" FOREIGN KEY ("domain_id","issuer_site_id") REFERENCES "public"."federation_evidence_streams"("domain_id","issuer_site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence_cases" ADD CONSTRAINT "federation_evidence_cases_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence_cases" ADD CONSTRAINT "federation_evidence_cases_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence_cases" ADD CONSTRAINT "federation_evidence_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_execution_terminals" ADD CONSTRAINT "federation_execution_terminals_authorization_policy_id_federation_terminal_policies_id_fk" FOREIGN KEY ("authorization_policy_id") REFERENCES "public"."federation_terminal_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_execution_terminals" ADD CONSTRAINT "federation_execution_terminals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_execution_terminals" ADD CONSTRAINT "federation_execution_terminals_local_site_id_reservation_id_federation_commercial_execution_approvals_local_site_id_record_id_fk" FOREIGN KEY ("local_site_id","reservation_id") REFERENCES "public"."federation_commercial_execution_approvals"("local_site_id","record_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_input_attempts" ADD CONSTRAINT "federation_input_attempts_media_claim_id_federation_task_media_claims_id_fk" FOREIGN KEY ("media_claim_id") REFERENCES "public"."federation_task_media_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_input_attempts" ADD CONSTRAINT "federation_input_attempts_transfer_id_federation_input_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."federation_input_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_input_attempts" ADD CONSTRAINT "federation_input_attempts_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_input_imports" ADD CONSTRAINT "federation_input_imports_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_input_imports" ADD CONSTRAINT "federation_input_imports_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_input_imports" ADD CONSTRAINT "federation_input_imports_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_input_transfers" ADD CONSTRAINT "federation_input_transfers_import_id_federation_input_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."federation_input_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_attempts" ADD CONSTRAINT "federation_market_attempts_submission_id_federation_market_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."federation_market_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_requests" ADD CONSTRAINT "federation_market_requests_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_requests" ADD CONSTRAINT "federation_market_requests_policy_id_federation_reservation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."federation_reservation_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_requests" ADD CONSTRAINT "federation_market_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_requests" ADD CONSTRAINT "federation_market_requests_market_submission_id_federation_market_submissions_id_fk" FOREIGN KEY ("market_submission_id") REFERENCES "public"."federation_market_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_requests" ADD CONSTRAINT "federation_market_request_contract_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_submissions" ADD CONSTRAINT "federation_market_submissions_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_submissions" ADD CONSTRAINT "federation_market_submissions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_submissions" ADD CONSTRAINT "federation_market_submissions_authorization_policy_id_federation_reservation_policies_id_fk" FOREIGN KEY ("authorization_policy_id") REFERENCES "public"."federation_reservation_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_materials" ADD CONSTRAINT "federation_materials_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_materials" ADD CONSTRAINT "federation_materials_origin_site_id_federation_sites_id_fk" FOREIGN KEY ("origin_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_materials" ADD CONSTRAINT "federation_materials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_devices" ADD CONSTRAINT "federation_media_devices_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_devices" ADD CONSTRAINT "federation_media_devices_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_devices" ADD CONSTRAINT "federation_media_devices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_export_operations" ADD CONSTRAINT "federation_media_export_operations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_export_operations" ADD CONSTRAINT "federation_media_export_operations_local_site_id_package_id_federation_media_exports_local_site_id_package_id_fk" FOREIGN KEY ("local_site_id","package_id") REFERENCES "public"."federation_media_exports"("local_site_id","package_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_exports_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_exports_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_exports_recipient_site_id_federation_sites_id_fk" FOREIGN KEY ("recipient_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_exports_version_id_data_asset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_exports_location_id_data_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."data_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_exports_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_export_approval" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_agreement_approvals"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_handoffs" ADD CONSTRAINT "federation_media_handoffs_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_handoffs" ADD CONSTRAINT "federation_media_handoffs_local_site_id_shipment_id_federation_media_shipments_local_site_id_shipment_id_fk" FOREIGN KEY ("local_site_id","shipment_id") REFERENCES "public"."federation_media_shipments"("local_site_id","shipment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_import_authorizations" ADD CONSTRAINT "federation_media_import_authorizations_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_import_authorizations" ADD CONSTRAINT "federation_media_import_authorizations_managed_root_id_cluster_file_roots_id_fk" FOREIGN KEY ("managed_root_id") REFERENCES "public"."cluster_file_roots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_import_authorizations" ADD CONSTRAINT "federation_media_import_authorizations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_import_authorizations" ADD CONSTRAINT "federation_media_import_authorizations_local_site_id_package_id_federation_media_packages_local_site_id_package_id_fk" FOREIGN KEY ("local_site_id","package_id") REFERENCES "public"."federation_media_packages"("local_site_id","package_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_import_operations" ADD CONSTRAINT "federation_media_import_operations_authorization_id_federation_media_import_authorizations_authorization_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."federation_media_import_authorizations"("authorization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_import_operations" ADD CONSTRAINT "federation_media_import_operations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_key_grants" ADD CONSTRAINT "federation_media_key_grants_local_site_id_package_id_federation_media_exports_local_site_id_package_id_fk" FOREIGN KEY ("local_site_id","package_id") REFERENCES "public"."federation_media_exports"("local_site_id","package_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_packages" ADD CONSTRAINT "federation_media_packages_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_packages" ADD CONSTRAINT "federation_media_packages_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_packages" ADD CONSTRAINT "federation_media_packages_sender_site_id_federation_sites_id_fk" FOREIGN KEY ("sender_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_packages" ADD CONSTRAINT "federation_media_packages_task_input_import_id_federation_input_imports_id_fk" FOREIGN KEY ("task_input_import_id") REFERENCES "public"."federation_input_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_packages" ADD CONSTRAINT "federation_media_packages_task_result_import_id_federation_result_imports_id_fk" FOREIGN KEY ("task_result_import_id") REFERENCES "public"."federation_result_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_packages" ADD CONSTRAINT "federation_media_packages_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_receipts" ADD CONSTRAINT "federation_media_receipts_sender_site_id_federation_sites_id_fk" FOREIGN KEY ("sender_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_receipts" ADD CONSTRAINT "federation_media_receipts_local_site_id_package_id_federation_media_exports_local_site_id_package_id_fk" FOREIGN KEY ("local_site_id","package_id") REFERENCES "public"."federation_media_exports"("local_site_id","package_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipment_devices" ADD CONSTRAINT "federation_media_shipment_devices_local_site_id_shipment_id_federation_media_shipments_local_site_id_shipment_id_fk" FOREIGN KEY ("local_site_id","shipment_id") REFERENCES "public"."federation_media_shipments"("local_site_id","shipment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipment_devices" ADD CONSTRAINT "federation_media_shipment_devices_local_site_id_device_id_federation_media_devices_local_site_id_device_id_fk" FOREIGN KEY ("local_site_id","device_id") REFERENCES "public"."federation_media_devices"("local_site_id","device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipments" ADD CONSTRAINT "federation_media_shipments_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipments" ADD CONSTRAINT "federation_media_shipments_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipments" ADD CONSTRAINT "federation_media_shipments_sender_site_id_federation_sites_id_fk" FOREIGN KEY ("sender_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipments" ADD CONSTRAINT "federation_media_shipments_recipient_site_id_federation_sites_id_fk" FOREIGN KEY ("recipient_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_shipments" ADD CONSTRAINT "federation_media_shipments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD CONSTRAINT "federation_outbound_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD CONSTRAINT "federation_outbound_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD CONSTRAINT "federation_outbound_cancel_requested_by_users_id_fk" FOREIGN KEY ("cancel_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD CONSTRAINT "federation_outbound_local_site_id_agreement_revision_id_federation_agreement_approvals_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_agreement_approvals"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_preparations" ADD CONSTRAINT "federation_preparations_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_received_arbitration_decisions" ADD CONSTRAINT "federation_received_arbitration_decisions_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_received_arbitration_decisions" ADD CONSTRAINT "arb_received_decision_case_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_disputes"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_received_disclosures" ADD CONSTRAINT "federation_received_disclosures_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_received_disclosures" ADD CONSTRAINT "federation_received_disclosure_case_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_evidence_cases"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_received_usage" ADD CONSTRAINT "federation_received_usage_sync_fk" FOREIGN KEY ("local_site_id","operation_id") REFERENCES "public"."federation_usage_syncs"("local_site_id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_policies" ADD CONSTRAINT "federation_reservation_policies_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_policies" ADD CONSTRAINT "federation_reservation_policies_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_policies" ADD CONSTRAINT "federation_reservation_policies_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_policies" ADD CONSTRAINT "federation_reservation_policies_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_reservation_proposals_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_reservation_proposals_policy_id_federation_reservation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."federation_reservation_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_reservation_proposals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_reservation_proposals_activation_id_federation_market_submissions_id_fk" FOREIGN KEY ("activation_id") REFERENCES "public"."federation_market_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_reservation_proposals_confirmation_id_federation_market_submissions_id_fk" FOREIGN KEY ("confirmation_id") REFERENCES "public"."federation_market_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_reservation_proposals_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservations" ADD CONSTRAINT "federation_reservations_agreement_revision_id_federation_agreements_revision_id_fk" FOREIGN KEY ("agreement_revision_id") REFERENCES "public"."federation_agreements"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_result_attempts" ADD CONSTRAINT "federation_result_attempts_media_claim_id_federation_task_media_claims_id_fk" FOREIGN KEY ("media_claim_id") REFERENCES "public"."federation_task_media_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_result_attempts" ADD CONSTRAINT "federation_result_attempts_transfer_id_federation_result_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."federation_result_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_result_attempts" ADD CONSTRAINT "federation_result_attempts_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD CONSTRAINT "federation_result_imports_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD CONSTRAINT "federation_result_imports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD CONSTRAINT "federation_result_imports_local_site_id_operation_id_federation_outbound_local_site_id_operation_id_fk" FOREIGN KEY ("local_site_id","operation_id") REFERENCES "public"."federation_outbound"("local_site_id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_result_receipts" ADD CONSTRAINT "federation_result_receipts_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_result_transfers" ADD CONSTRAINT "federation_result_transfers_import_id_federation_result_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."federation_result_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_signing_keys" ADD CONSTRAINT "federation_signing_keys_site_id_federation_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_task_media_claims" ADD CONSTRAINT "federation_task_media_claims_task_input_import_id_federation_input_imports_id_fk" FOREIGN KEY ("task_input_import_id") REFERENCES "public"."federation_input_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_task_media_claims" ADD CONSTRAINT "federation_task_media_claims_task_result_import_id_federation_result_imports_id_fk" FOREIGN KEY ("task_result_import_id") REFERENCES "public"."federation_result_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_task_media_claims" ADD CONSTRAINT "federation_task_media_claims_authorization_id_federation_media_import_operations_authorization_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."federation_media_import_operations"("authorization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_chunks" ADD CONSTRAINT "federation_terminal_chunk_sync_fk" FOREIGN KEY ("local_site_id","reservation_id") REFERENCES "public"."federation_terminal_syncs"("local_site_id","reservation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_evidence" ADD CONSTRAINT "federation_terminal_evidence_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_evidence" ADD CONSTRAINT "federation_terminal_evidence_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_evidence" ADD CONSTRAINT "federation_terminal_evidence_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_policies" ADD CONSTRAINT "federation_terminal_policies_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_policies" ADD CONSTRAINT "federation_terminal_policies_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_policies" ADD CONSTRAINT "federation_terminal_policies_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_policies" ADD CONSTRAINT "federation_terminal_policies_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_syncs" ADD CONSTRAINT "federation_terminal_sync_approval_fk" FOREIGN KEY ("local_site_id","reservation_id") REFERENCES "public"."federation_commercial_execution_approvals"("local_site_id","record_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_unreserved_closures" ADD CONSTRAINT "federation_unreserved_closures_origin_id_federation_market_submissions_id_fk" FOREIGN KEY ("origin_id") REFERENCES "public"."federation_market_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_usage_reports" ADD CONSTRAINT "federation_usage_reports_reservation_id_federation_usage_tasks_reservation_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_usage_tasks"("reservation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_usage_syncs" ADD CONSTRAINT "federation_usage_sync_outbound_fk" FOREIGN KEY ("local_site_id","operation_id") REFERENCES "public"."federation_outbound"("local_site_id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_usage_tasks" ADD CONSTRAINT "federation_usage_tasks_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_usage_tasks" ADD CONSTRAINT "federation_usage_tasks_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_usage_tasks" ADD CONSTRAINT "federation_usage_tasks_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_workflow_bindings" ADD CONSTRAINT "federation_workflow_bindings_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_workflow_bindings" ADD CONSTRAINT "federation_workflow_bindings_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_workflow_input_exports" ADD CONSTRAINT "federation_workflow_input_exports_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_workflow_input_exports" ADD CONSTRAINT "federation_workflow_input_exports_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_workflow_input_exports" ADD CONSTRAINT "federation_workflow_input_exports_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_dispatch_outbox" ADD CONSTRAINT "job_dispatch_outbox_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_dispatch_outbox" ADD CONSTRAINT "job_dispatch_outbox_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_dispatch_outbox" ADD CONSTRAINT "job_dispatch_outbox_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_delegations" ADD CONSTRAINT "workflow_execution_delegations_run_id_workflow_execution_leases_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_execution_leases"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_jobs" ADD CONSTRAINT "workflow_execution_jobs_run_id_workflow_execution_leases_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_execution_leases"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_jobs" ADD CONSTRAINT "workflow_execution_jobs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_journal" ADD CONSTRAINT "workflow_execution_journal_run_id_workflow_execution_leases_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_execution_leases"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_leases" ADD CONSTRAINT "workflow_execution_leases_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_accounting_due" ON "federation_accounting_collections" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_approval_org" ON "federation_agreement_approvals" USING btree ("local_org_id","created_at");--> statement-breakpoint
CREATE INDEX "federation_agreement_sync_pending" ON "federation_agreement_syncs" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_agreement_budget_epoch" ON "federation_agreements" USING btree ("budget_domain_id","epoch");--> statement-breakpoint
CREATE INDEX "arb_decision_delivery_pending" ON "federation_arbitration_decision_deliveries" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_arbitration_decision_case" ON "federation_arbitration_decisions" USING btree ("local_site_id","case_id");--> statement-breakpoint
CREATE INDEX "federation_arbitration_policy_org" ON "federation_arbitration_policies" USING btree ("local_site_id","local_org_id","agreement_revision_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "arb_resolution_case" ON "federation_arbitration_resolutions" USING btree ("local_site_id","case_id");--> statement-breakpoint
CREATE INDEX "arb_revocation_delivery_pending" ON "federation_arbitration_revocation_deliveries" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "arb_revocation_notice_id" ON "federation_arbitration_revocation_notices" USING btree ("local_site_id","notice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_asset_origin" ON "federation_asset_mappings" USING btree ("local_org_id","origin_site_id","kind","origin_id","origin_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_attestation_tx" ON "federation_attestation_attempts" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_attestation_attempt_number" ON "federation_attestation_attempts" USING btree ("batch_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_outbox_batch_sequence" ON "federation_attestation_outbox" USING btree ("batch_id","sequence");--> statement-breakpoint
CREATE INDEX "federation_outbox_pending" ON "federation_attestation_outbox" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_case_decision_case" ON "federation_case_arbitration_decisions" USING btree ("local_site_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_case_attempt_number" ON "federation_case_attempts" USING btree ("submission_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_case_attempt_transaction" ON "federation_case_attempts" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "federation_case_publication_org" ON "federation_case_publications" USING btree ("local_site_id","local_org_id","agreement_revision_id","case_id","created_at");--> statement-breakpoint
CREATE INDEX "federation_case_revocation_delivery_pending" ON "federation_case_revocation_deliveries" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_case_revocation_notice_id" ON "federation_case_revocation_notices" USING btree ("local_site_id","notice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_case_submission_decision" ON "federation_case_submissions" USING btree ("local_site_id","arbitration_decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_case_submission_record" ON "federation_case_submissions" USING btree ("local_site_id","publication_id","operation");--> statement-breakpoint
CREATE INDEX "federation_case_submission_pending" ON "federation_case_submissions" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_certificate_site" ON "federation_certificates" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_closing_policy_active" ON "federation_closing_policies" USING btree ("local_site_id","agreement_revision_id","kind") WHERE "federation_closing_policies"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "federation_closing_task_due" ON "federation_closing_tasks" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_adjustment_sequence" ON "federation_commercial_adjustments" USING btree ("local_site_id","settlement_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_adjustment_predecessor" ON "federation_commercial_adjustments" USING btree ("local_site_id","settlement_id",coalesce("payload"->'previous'->>'adjustmentId', 'initial'));--> statement-breakpoint
CREATE INDEX "federation_adjustment_org" ON "federation_commercial_adjustments" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
CREATE INDEX "federation_commercial_org" ON "federation_commercial_agreements" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
CREATE INDEX "federation_approval_sync_pending" ON "federation_commercial_approval_syncs" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_commercial_tx" ON "federation_commercial_attempts" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_commercial_attempt_number" ON "federation_commercial_attempts" USING btree ("submission_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_bill_task_attempt" ON "federation_commercial_bills" USING btree ("local_site_id","agreement_revision_id","task_id","attempt");--> statement-breakpoint
CREATE INDEX "federation_bill_org" ON "federation_commercial_bills" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
CREATE INDEX "federation_discount_org" ON "federation_commercial_discounts" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
CREATE INDEX "federation_terminal_auto_pending" ON "federation_commercial_execution_approvals" USING btree ("local_site_id","terminal_auto_state","terminal_auto_next_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_execution_stop_id" ON "federation_commercial_execution_approvals" USING btree ("stop_id");--> statement-breakpoint
CREATE INDEX "federation_execution_stop_pending" ON "federation_commercial_execution_approvals" USING btree ("local_site_id","stop_next_attempt_at") WHERE "federation_commercial_execution_approvals"."stop_next_attempt_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "federation_execution_approval_org" ON "federation_commercial_execution_approvals" USING btree ("local_site_id","local_org_id","agreement_revision_id","created_at");--> statement-breakpoint
CREATE INDEX "federation_execution_approval_operation" ON "federation_commercial_execution_approvals" USING btree ("local_site_id","local_org_id",("payload"->'request'->>'operationId')) WHERE "federation_commercial_execution_approvals"."payload"->>'kind' = 'commercial-reservation';--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_history_original" ON "federation_commercial_history_recoveries" USING btree ("local_site_id","submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_payment_current" ON "federation_commercial_payments" USING btree ("local_site_id","payment_id") WHERE "federation_commercial_payments"."current";--> statement-breakpoint
CREATE UNIQUE INDEX "federation_payment_successor" ON "federation_commercial_payments" USING btree ("local_site_id","payment_id",coalesce("payload"->'previous'->>'receiptId', ''));--> statement-breakpoint
CREATE INDEX "federation_payment_bill" ON "federation_commercial_payments" USING btree ("local_site_id","bill_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_refund_operation" ON "federation_commercial_refunds" USING btree ("local_site_id","operation_id");--> statement-breakpoint
CREATE INDEX "federation_refund_org" ON "federation_commercial_refunds" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_settlement_bill" ON "federation_commercial_settlements" USING btree ("local_site_id","bill_id");--> statement-breakpoint
CREATE INDEX "federation_settlement_org" ON "federation_commercial_settlements" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_commercial_record" ON "federation_commercial_submissions" USING btree ("local_site_id",("input"->>'operation'),("input"->>'recordId'));--> statement-breakpoint
CREATE INDEX "federation_commercial_pending" ON "federation_commercial_submissions" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_completion_active" ON "federation_completion_claims" USING btree ("local_site_id","next_check_at") WHERE "federation_completion_claims"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_dataset_asset_origin" ON "federation_dataset_assets" USING btree ("local_site_id","local_org_id","source_site_id","source_asset_id");--> statement-breakpoint
CREATE INDEX "federation_dataset_replica_renewal" ON "federation_dataset_replicas" USING btree ("renew_after");--> statement-breakpoint
CREATE INDEX "federation_dataset_use_org" ON "federation_dataset_use_policies" USING btree ("local_site_id","local_org_id","approved_at");--> statement-breakpoint
CREATE INDEX "federation_disclosure_policy_org" ON "federation_disclosure_policies" USING btree ("local_site_id","local_org_id","agreement_revision_id","created_at");--> statement-breakpoint
CREATE INDEX "federation_disclosure_case" ON "federation_disclosures" USING btree ("local_site_id","local_org_id","agreement_revision_id","case_id","created_at");--> statement-breakpoint
CREATE INDEX "federation_dispute_delivery_pending" ON "federation_dispute_deliveries" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_dispute_freeze_pending" ON "federation_dispute_freezes" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_resolution_identity" ON "federation_dispute_resolutions" USING btree ("local_site_id","resolution_id");--> statement-breakpoint
CREATE INDEX "federation_dispute_task" ON "federation_disputes" USING btree ("local_site_id","agreement_revision_id","task_id","attempt");--> statement-breakpoint
CREATE INDEX "federation_dispute_org" ON "federation_disputes" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_evidence_reservation_kind" ON "federation_evidence" USING btree ("reservation_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_batch_sequence" ON "federation_evidence_batches" USING btree ("domain_id","issuer_site_id","first_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_batch_unresolved_stream" ON "federation_evidence_batches" USING btree ("domain_id","issuer_site_id") WHERE "federation_evidence_batches"."state" <> 'anchored';--> statement-breakpoint
CREATE INDEX "federation_batch_pending" ON "federation_evidence_batches" USING btree ("issuer_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_batch_agreement" ON "federation_evidence_batches" USING btree ("agreement_revision_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_execution_terminal_id" ON "federation_execution_terminals" USING btree ("local_site_id","terminal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_input_attempt_storage" ON "federation_input_attempts" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_input_attempt_active_member" ON "federation_input_attempts" USING btree ("transfer_id") WHERE "federation_input_attempts"."state" != 'cleaned';--> statement-breakpoint
CREATE UNIQUE INDEX "federation_input_attempt_active_agent" ON "federation_input_attempts" USING btree ("agent_id") WHERE "federation_input_attempts"."state" IN ('preparing', 'copying', 'assembling', 'verifying');--> statement-breakpoint
CREATE INDEX "federation_input_attempt_lease" ON "federation_input_attempts" USING btree ("state","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_input_import_reservation" ON "federation_input_imports" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "federation_input_import_pending" ON "federation_input_imports" USING btree ("local_site_id","next_check_at") WHERE "federation_input_imports"."state" IN ('pending', 'transferring', 'available');--> statement-breakpoint
CREATE INDEX "federation_input_import_publication" ON "federation_input_imports" USING btree ("local_site_id","next_publish_at") WHERE "federation_input_imports"."state" IN ('pending', 'transferring');--> statement-breakpoint
CREATE UNIQUE INDEX "federation_input_transfer_member" ON "federation_input_transfers" USING btree ("import_id","descriptor","path");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_market_tx" ON "federation_market_attempts" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_market_attempt_number" ON "federation_market_attempts" USING btree ("submission_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_market_request_demand" ON "federation_market_requests" USING btree ("local_site_id","demand_id");--> statement-breakpoint
CREATE INDEX "federation_market_request_pending" ON "federation_market_requests" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_market_request_policy" ON "federation_market_requests" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "federation_market_org" ON "federation_market_submissions" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
CREATE INDEX "federation_market_demand" ON "federation_market_submissions" USING btree ("local_site_id","demand_id");--> statement-breakpoint
CREATE INDEX "federation_market_closure_check" ON "federation_market_submissions" USING btree ("local_site_id","closure_check_at") WHERE "federation_market_submissions"."state" = 'committed' AND "federation_market_submissions"."input"->>'operation' IN ('publish-demand','claim-demand');--> statement-breakpoint
CREATE INDEX "federation_market_pending" ON "federation_market_submissions" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_market_activation" ON "federation_market_submissions" USING btree ("local_site_id",("input"->'activation'->'gate'->>'reservationId')) WHERE "federation_market_submissions"."input"->>'operation' = 'activate-demand';--> statement-breakpoint
CREATE INDEX "federation_market_execution_confirmation" ON "federation_market_submissions" USING btree ("local_site_id","local_org_id",("input"->'authorization'->'gate'->>'reservationId'),"created_at") WHERE "federation_market_submissions"."input"->>'operation' = 'authorize-execution';--> statement-breakpoint
CREATE UNIQUE INDEX "federation_market_execution_stop" ON "federation_market_submissions" USING btree ("local_site_id",("input"->'stop'->>'activationId'),"demand_id") WHERE "federation_market_submissions"."input"->>'operation' = 'request-execution-stop';--> statement-breakpoint
CREATE UNIQUE INDEX "federation_market_execution_closure" ON "federation_market_submissions" USING btree ("local_site_id",("input"->'closure'->'gate'->'terminal'->>'activationId')) WHERE "federation_market_submissions"."input"->>'operation' = 'close-demand';--> statement-breakpoint
CREATE UNIQUE INDEX "federation_media_device_tag" ON "federation_media_devices" USING btree ("local_site_id","local_org_id","asset_tag");--> statement-breakpoint
CREATE INDEX "federation_media_export_pending" ON "federation_media_export_operations" USING btree ("local_site_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "federation_media_export_org" ON "federation_media_exports" USING btree ("local_site_id","local_org_id","approved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_media_handoff_version" ON "federation_media_handoffs" USING btree ("local_site_id","shipment_id","version");--> statement-breakpoint
CREATE INDEX "federation_media_import_package" ON "federation_media_import_authorizations" USING btree ("local_site_id","package_id","approved_at");--> statement-breakpoint
CREATE INDEX "federation_media_import_pending" ON "federation_media_import_operations" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "federation_media_import_receipt_pending" ON "federation_media_import_operations" USING btree ("receipt_next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_media_package_org" ON "federation_media_packages" USING btree ("local_site_id","local_org_id","registered_at");--> statement-breakpoint
CREATE INDEX "federation_media_receipt_package" ON "federation_media_receipts" USING btree ("local_site_id","package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_media_device_active_shipment" ON "federation_media_shipment_devices" USING btree ("local_site_id","device_id") WHERE "federation_media_shipment_devices"."active";--> statement-breakpoint
CREATE INDEX "federation_media_shipment_org" ON "federation_media_shipments" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_outbound_task_attempt" ON "federation_outbound" USING btree ("local_site_id","agreement_revision_id","task_id","attempt");--> statement-breakpoint
CREATE INDEX "federation_outbound_delivery" ON "federation_outbound" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_outbound_status" ON "federation_outbound" USING btree ("local_site_id","status_next_attempt_at","operation_id") WHERE "federation_outbound"."state" = 'accepted' AND "federation_outbound"."status_next_attempt_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "federation_outbound_cancel" ON "federation_outbound" USING btree ("local_site_id","cancel_state","cancel_next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_outbound_budget" ON "federation_outbound" USING btree ("local_site_id","budget_domain_id","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "arb_received_decision_case" ON "federation_received_arbitration_decisions" USING btree ("local_site_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_received_usage_sequence" ON "federation_received_usage" USING btree ("local_site_id","operation_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_reservation_policy_active" ON "federation_reservation_policies" USING btree ("local_site_id","agreement_revision_id") WHERE "federation_reservation_policies"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "federation_execution_automation_pending" ON "federation_reservation_proposals" USING btree ("local_site_id","execution_state","execution_next_at");--> statement-breakpoint
CREATE INDEX "federation_reservation_proposal_pending" ON "federation_reservation_proposals" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_reservation_proposal_org" ON "federation_reservation_proposals" USING btree ("local_site_id","local_org_id","agreement_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_request_operation" ON "federation_reservations" USING btree ("sender_site_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_task_attempt" ON "federation_reservations" USING btree ("agreement_revision_id","task_id","attempt");--> statement-breakpoint
CREATE INDEX "federation_reservation_recovery" ON "federation_reservations" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_result_attempt_storage" ON "federation_result_attempts" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_result_attempt_active_member" ON "federation_result_attempts" USING btree ("transfer_id") WHERE "federation_result_attempts"."state" NOT IN ('cleaned','cleanup_pending');--> statement-breakpoint
CREATE UNIQUE INDEX "federation_result_attempt_active_agent" ON "federation_result_attempts" USING btree ("agent_id") WHERE "federation_result_attempts"."state" IN ('preparing','copying','assembling','verifying');--> statement-breakpoint
CREATE INDEX "federation_result_attempt_lease" ON "federation_result_attempts" USING btree ("state","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_result_import_manifest" ON "federation_result_imports" USING btree ("local_site_id","operation_id","requested_by","manifest_digest") WHERE "federation_result_imports"."state" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "federation_result_import_owner" ON "federation_result_imports" USING btree ("local_site_id","local_org_id","requested_by","created_at");--> statement-breakpoint
CREATE INDEX "federation_result_receipt_reservation" ON "federation_result_receipts" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_result_transfer_member" ON "federation_result_transfers" USING btree ("import_id","output_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_task_media_claim_generation" ON "federation_task_media_claims" USING btree ("authorization_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_task_media_claim_input" ON "federation_task_media_claims" USING btree ("task_input_import_id") WHERE "federation_task_media_claims"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_task_media_claim_result" ON "federation_task_media_claims" USING btree ("task_result_import_id") WHERE "federation_task_media_claims"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "federation_terminal_reservation" ON "federation_terminal_evidence" USING btree ("reservation_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_terminal_policy_active" ON "federation_terminal_policies" USING btree ("local_site_id","agreement_revision_id") WHERE "federation_terminal_policies"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "federation_terminal_sync_pending" ON "federation_terminal_syncs" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_usage_report_sequence" ON "federation_usage_reports" USING btree ("reservation_id","number");--> statement-breakpoint
CREATE INDEX "federation_usage_sync_pending" ON "federation_usage_syncs" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_usage_pending" ON "federation_usage_tasks" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_workflow_run" ON "federation_workflow_bindings" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_input_export_invocation" ON "federation_workflow_input_exports" USING btree ("run_id","path_hash");--> statement-breakpoint
CREATE INDEX "job_dispatch_outbox_pending" ON "job_dispatch_outbox" USING btree ("next_attempt_at") WHERE "job_dispatch_outbox"."acknowledged_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_execution_delegation_operation" ON "workflow_execution_delegations" USING btree ("local_site_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_execution_job_unique" ON "workflow_execution_jobs" USING btree ("job_id");--> statement-breakpoint
ALTER TABLE "workflow_artifacts" ADD CONSTRAINT "workflow_artifacts_producer_job_id_jobs_id_fk" FOREIGN KEY ("producer_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_cancellations_job_agent_idx" ON "job_cancellations" USING btree ("job_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_artifacts_job_descriptor_idx" ON "workflow_artifacts" USING btree ("producer_job_id","descriptor") WHERE "workflow_artifacts"."producer_job_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_artifacts_run_node_descriptor_idx" ON "workflow_artifacts" USING btree ("workflow_run_id","producer_node_id","descriptor") WHERE "workflow_artifacts"."producer_job_id" IS NULL;--> statement-breakpoint
ALTER TABLE "software_operations" ADD CONSTRAINT "software_operations_federation_authority_check" CHECK ("software_operations"."federation_job_id" IS NULL OR ("software_operations"."action" = 'install' AND "software_operations"."replay_enabled" AND "software_operations"."requested_by" IS NOT NULL AND "software_operations"."manifest_digest" IS NOT NULL));
import type { FederationAcceptance, FederationAgreement } from "@kuintessence/shared/federation";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { orgs, users } from "./schema";

export const federationSites = pgTable(
  "federation_sites",
  {
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    endpoint: text("endpoint").notNull(),
    state: varchar("state", { length: 16 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("federation_site_state", sql`${t.state} IN ('active', 'suspended', 'revoked')`)],
);

/** Rotation adds a new record; key IDs and certificate fingerprints are never reassigned. */
export const federationSigningKeys = pgTable(
  "federation_signing_keys",
  {
    siteId: uuid("site_id")
      .notNull()
      .references(() => federationSites.id),
    keyId: varchar("key_id", { length: 128 }).notNull(),
    publicKeyPem: text("public_key_pem").notNull(),
    allowedKinds: jsonb("allowed_kinds")
      .$type<("agreement" | "delegation" | "acceptance")[]>()
      .notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.keyId] }),
    check("federation_key_interval", sql`${t.validFrom} < ${t.validUntil}`),
  ],
);

export const federationCertificates = pgTable(
  "federation_certificates",
  {
    fingerprint: varchar("fingerprint", { length: 64 }).primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => federationSites.id),
    certificatePem: text("certificate_pem").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("federation_certificate_site").on(t.siteId),
    check("federation_certificate_interval", sql`${t.validFrom} < ${t.validUntil}`),
    check("federation_certificate_fingerprint", sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const federationBudgets = pgTable(
  "federation_budgets",
  {
    domainId: uuid("domain_id").notNull(),
    epoch: uuid("epoch").notNull(),
    unit: varchar("unit", { length: 64 }).notNull(),
    limit: numeric("limit", { precision: 38, scale: 0 }).notNull(),
    available: numeric("available", { precision: 38, scale: 0 }).notNull(),
    reserved: numeric("reserved", { precision: 38, scale: 0 }).notNull().default("0"),
  },
  (t) => [
    primaryKey({ columns: [t.domainId, t.epoch] }),
    check(
      "federation_budget_conservation",
      sql`${t.limit}::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND ${t.available}::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND ${t.reserved}::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND ${t.limit} = ${t.available} + ${t.reserved}`,
    ),
  ],
);

export const federationAgreements = pgTable(
  "federation_agreements",
  {
    revisionId: uuid("revision_id").primaryKey(),
    sourceSiteId: uuid("source_site_id").notNull(),
    targetSiteId: uuid("target_site_id").notNull(),
    localOrgId: uuid("local_org_id")
      .notNull()
      .references(() => orgs.id),
    executionUserId: uuid("execution_user_id")
      .notNull()
      .references(() => users.id),
    budgetDomainId: uuid("budget_domain_id").notNull(),
    epoch: uuid("epoch").notNull(),
    terms: jsonb("terms").$type<FederationAgreement>().notNull(),
    termsDigest: varchar("terms_digest", { length: 71 }).notNull(),
    sourceApprovalJws: text("source_approval_jws").notNull(),
    targetApprovalJws: text("target_approval_jws").notNull(),
    state: varchar("state", { length: 16 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.budgetDomainId, t.epoch],
      foreignColumns: [federationBudgets.domainId, federationBudgets.epoch],
    }),
    uniqueIndex("federation_agreement_budget_epoch").on(t.budgetDomainId, t.epoch),
    check("federation_agreement_state", sql`${t.state} IN ('active', 'suspended', 'revoked')`),
    check("federation_agreement_sites", sql`${t.sourceSiteId} <> ${t.targetSiteId}`),
  ],
);

/** The signed request is also the durable inbox entry; an unsigned receipt never permits dispatch. */
export const federationReservations = pgTable(
  "federation_reservations",
  {
    id: uuid("id").primaryKey(),
    agreementRevisionId: uuid("agreement_revision_id")
      .notNull()
      .references(() => federationAgreements.revisionId),
    senderSiteId: uuid("sender_site_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    taskId: uuid("task_id").notNull(),
    attempt: integer("attempt").notNull(),
    requestDigest: varchar("request_digest", { length: 71 }).notNull(),
    requestJws: text("request_jws").notNull(),
    amount: numeric("amount", { precision: 38, scale: 0 }).notNull(),
    receipt: jsonb("receipt").$type<FederationAcceptance>().notNull(),
    receiptJws: text("receipt_jws"),
    state: varchar("state", { length: 24 }).notNull().default("pending_signature"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_request_operation").on(t.senderSiteId, t.operationId),
    uniqueIndex("federation_task_attempt").on(t.agreementRevisionId, t.taskId, t.attempt),
    index("federation_reservation_recovery").on(t.state, t.createdAt),
    check(
      "federation_reservation_amount",
      sql`${t.amount}::text ~ '^(0|[1-9][0-9]{0,37})$' AND ${t.attempt} > 0`,
    ),
    check(
      "federation_reservation_signature",
      sql`
      (${t.state} = 'pending_signature' AND ${t.receiptJws} IS NULL)
      OR (${t.state} = 'reserved' AND ${t.receiptJws} IS NOT NULL)`,
    ),
  ],
);

/** Independent of raw metering retention. There is deliberately no cascade deletion. */
export const federationEvidence = pgTable(
  "federation_evidence",
  {
    id: uuid("id").primaryKey(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => federationReservations.id),
    kind: varchar("kind", { length: 24 }).notNull(),
    jws: text("jws").notNull(),
    digest: varchar("digest", { length: 71 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federation_evidence_reservation_kind").on(t.reservationId, t.kind),
    check("federation_evidence_kind", sql`${t.kind} IN ('delegation', 'acceptance')`),
  ],
);

export const federationAttestationOutbox = pgTable(
  "federation_attestation_outbox",
  {
    evidenceId: uuid("evidence_id")
      .primaryKey()
      .references(() => federationEvidence.id),
    state: varchar("state", { length: 24 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("federation_attestation_state", sql`${t.state} = 'pending'`)],
);

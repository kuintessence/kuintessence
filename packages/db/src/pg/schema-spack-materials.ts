import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** Append-only union of all Server configurations, including replaced bindings. */
export const spackMaterialBindings = pgTable(
  "spack_material_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spec: varchar("spec", { length: 500 }).notNull(),
    repositoryId: varchar("repository_id", { length: 64 }).notNull(),
    manifestDigest: varchar("manifest_digest", { length: 71 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bindingIdx: uniqueIndex("spack_material_bindings_binding_idx").on(
      t.spec,
      t.repositoryId,
      t.manifestDigest,
    ),
    releaseIdx: index("spack_material_bindings_release_idx").on(t.repositoryId, t.manifestDigest),
    specCheck: check("spack_material_bindings_spec_check", sql`length(trim(${t.spec})) > 0`),
    repositoryCheck: check(
      "spack_material_bindings_repository_check",
      sql`${t.repositoryId} ~ '^[a-f0-9]{64}$'`,
    ),
    digestCheck: check(
      "spack_material_bindings_digest_check",
      sql`${t.manifestDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  }),
);

/** Immutable via the reference API; never cascade away orphan protection. */
export const spackMaterialOperationReferences = pgTable(
  "spack_material_operation_references",
  {
    // No operation, agent or requester FK: deleted parents must leave protective references.
    operationId: uuid("operation_id").primaryKey(),
    agentId: varchar("agent_id", { length: 255 }).notNull(),
    requestedBy: varchar("requested_by", { length: 255 }).notNull(),
    spec: varchar("spec", { length: 500 }).notNull(),
    repositoryId: varchar("repository_id", { length: 64 }).notNull(),
    manifestDigest: varchar("manifest_digest", { length: 71 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    releaseIdx: index("spack_material_operation_references_release_idx").on(
      t.repositoryId,
      t.manifestDigest,
    ),
    specCheck: check(
      "spack_material_operation_references_spec_check",
      sql`length(trim(${t.spec})) > 0`,
    ),
    repositoryCheck: check(
      "spack_material_operation_references_repository_check",
      sql`${t.repositoryId} ~ '^[a-f0-9]{64}$'`,
    ),
    digestCheck: check(
      "spack_material_operation_references_digest_check",
      sql`${t.manifestDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  }),
);

export interface SpackMaterialRolloutEvidence {
  legacyProcessesStoppedAndDrained: true;
  legacyAccessRevoked: true;
  legacyInventoryComplete: true;
}

/** Append-only operator journal. Never delete history to return to observation mode. */
export const spackMaterialRollouts = pgTable(
  "spack_material_rollouts",
  {
    revision: integer("revision").primaryKey(),
    epoch: uuid("epoch").notNull(),
    phase: varchar("phase", { length: 16 }).notNull(),
    action: varchar("action", { length: 16 }).notNull(),
    operatorId: uuid("operator_id").notNull(),
    inventoryDigest: varchar("inventory_digest", { length: 71 }).notNull(),
    evidence: jsonb("evidence").$type<SpackMaterialRolloutEvidence>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    revisionCheck: check("spack_material_rollouts_revision_check", sql`${t.revision} > 0`),
    transitionCheck: check(
      "spack_material_rollouts_transition_check",
      sql`(${t.phase} = 'paused' and ${t.action} in ('pause', 'reconcile') and ${t.evidence} is null)
        or (${t.phase} = 'ready' and ${t.action} = 'activate' and ${t.evidence} is not null)`,
    ),
    digestCheck: check(
      "spack_material_rollouts_digest_check",
      sql`${t.inventoryDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  }),
);

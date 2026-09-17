import { readFile } from "node:fs/promises";
import { v1 } from "@authzed/authzed-node";
import { auditLog, authzOutbox, authzShadowDiffs, type PgDb } from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Logger } from "pino";

export type AuthzMode = "off" | "shadow" | "enforce";
export type AuthzTupleOperation = "touch_schema" | "create" | "delete";

export interface AuthzObjectRef {
  type: string;
  id: string;
}

export interface AuthzSubjectRef extends AuthzObjectRef {
  relation?: string | null;
}

export interface AuthzTuple {
  operation: Exclude<AuthzTupleOperation, "touch_schema">;
  resource: AuthzObjectRef;
  relation: string;
  subject: AuthzSubjectRef;
  payload?: Record<string, unknown>;
}

export interface PendingRelationshipLookup {
  operation: AuthzTuple["operation"];
  resourceType: string;
  relation: string;
  subject: AuthzSubjectRef;
}

export interface AuthzCheck {
  actorUserId?: string | null;
  actorEmail?: string | null;
  resource: AuthzObjectRef;
  permission: string;
  subject: AuthzSubjectRef;
  context?: Record<string, unknown>;
}

export interface ShadowCheckInput extends AuthzCheck {
  localAllowed: boolean;
}

export interface AuthzHealth {
  mode: AuthzMode;
  configured: boolean;
  healthy: boolean;
  schemaWritten: boolean;
  schemaMatches: boolean;
  error: string | null;
}

export interface AuthzReplaceResult {
  purgedResourceTypes: string[];
  tupleCount: number;
}

export interface ProcessOutboxOptions {
  forcePending?: boolean;
  resourceType?: string;
  resourceId?: string;
}

type SpiceClient = ReturnType<typeof v1.NewClient>;

export interface AuthzServiceOptions {
  mode: AuthzMode;
  endpoint: string;
  token: string;
  schemaPath: string;
  db: PgDb;
  logger?: Logger;
  platformAdminDegrade: boolean;
}

const MAX_OUTBOX_ATTEMPTS = 5;
const OUTBOX_PROCESSING_LEASE_MS = 5 * 60_000;
const WRITE_RELATIONSHIPS_BATCH_SIZE = 500;
export const MANAGED_AUTHZ_RESOURCE_TYPES = [
  "platform",
  "organization",
  "provider",
  "agent",
  "queue",
  "software_asset",
  "data_asset",
  "job",
  "workflow",
  "netdrive_file",
  "cluster_file_root",
  "ssh_credential",
  "ssh_session",
  "ssh_recording",
] as const;

export class AuthzService {
  private readonly client: SpiceClient | null;
  private schemaWritten = false;
  private lastError: string | null = null;

  constructor(private readonly options: AuthzServiceOptions) {
    this.client =
      options.mode === "off"
        ? null
        : v1.NewClient(
            options.token,
            options.endpoint,
            v1.ClientSecurity.INSECURE_PLAINTEXT_CREDENTIALS,
          );
  }

  get mode(): AuthzMode {
    return this.options.mode;
  }

  close(): void {
    this.client?.close();
  }

  async writeSchemaFromDisk(): Promise<void> {
    if (!this.client) return;
    const schema = await this.readSchemaFromDisk();
    await this.client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema }));
    this.schemaWritten = true;
    this.lastError = null;
  }

  async health(): Promise<AuthzHealth> {
    if (!this.client) {
      return {
        mode: this.options.mode,
        configured: false,
        healthy: false,
        schemaWritten: false,
        schemaMatches: false,
        error: null,
      };
    }
    try {
      const [desiredSchema, currentSchema] = await Promise.all([
        this.readSchemaFromDisk(),
        this.client.promises.readSchema(v1.ReadSchemaRequest.create({})),
      ]);
      const schemaMatches =
        normalizedSchema(currentSchema.schemaText) === normalizedSchema(desiredSchema);
      return {
        mode: this.options.mode,
        configured: true,
        healthy: true,
        schemaWritten: this.schemaWritten,
        schemaMatches,
        error: null,
      };
    } catch (err) {
      const message = errorMessage(err);
      this.lastError = message;
      return {
        mode: this.options.mode,
        configured: true,
        healthy: false,
        schemaWritten: this.schemaWritten,
        schemaMatches: false,
        error: message,
      };
    }
  }

  async check(input: AuthzCheck): Promise<boolean> {
    if (!this.client) return true;
    try {
      const response = await this.client.promises.checkPermission(
        v1.CheckPermissionRequest.create({
          resource: objectRef(input.resource),
          permission: input.permission,
          subject: subjectRef(input.subject),
          consistency: fullyConsistent(),
          withTracing: false,
        }),
      );
      this.lastError = null;
      return response.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
    } catch (err) {
      this.lastError = errorMessage(err);
      throw err;
    }
  }

  async checkBulk(inputs: AuthzCheck[]): Promise<boolean[]> {
    if (!this.client) return inputs.map(() => true);
    if (inputs.length === 0) return [];
    try {
      const response = await this.client.promises.checkBulkPermissions(
        v1.CheckBulkPermissionsRequest.create({
          consistency: fullyConsistent(),
          withTracing: false,
          items: inputs.map((input) =>
            v1.CheckBulkPermissionsRequestItem.create({
              resource: objectRef(input.resource),
              permission: input.permission,
              subject: subjectRef(input.subject),
            }),
          ),
        }),
      );
      if (response.pairs.length !== inputs.length) {
        throw new Error(
          `SpiceDB bulk check returned ${response.pairs.length} results for ${inputs.length} inputs`,
        );
      }
      this.lastError = null;
      return response.pairs.map((pair, index) => {
        if (pair.response.oneofKind === "item") {
          return (
            pair.response.item.permissionship ===
            v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
          );
        }
        if (pair.response.oneofKind === "error") {
          throw new Error(
            `SpiceDB bulk check item ${index} failed: ${pair.response.error.message}`,
          );
        }
        throw new Error(`SpiceDB bulk check item ${index} returned no response`);
      });
    } catch (err) {
      this.lastError = errorMessage(err);
      throw err;
    }
  }

  async lookupResources(input: {
    resourceType: string;
    permission: string;
    subject: AuthzSubjectRef;
    limit?: number;
  }): Promise<string[]> {
    if (!this.client) return [];
    try {
      const responses = await this.client.promises.lookupResources(
        v1.LookupResourcesRequest.create({
          resourceObjectType: input.resourceType,
          permission: input.permission,
          subject: subjectRef(input.subject),
          consistency: fullyConsistent(),
          optionalLimit: input.limit ?? 0,
        }),
      );
      const resourceIds: string[] = [];
      const seen = new Set<string>();
      for (const response of responses) {
        if (response.resourceObjectId.length === 0 || seen.has(response.resourceObjectId)) {
          continue;
        }
        seen.add(response.resourceObjectId);
        resourceIds.push(response.resourceObjectId);
      }
      this.lastError = null;
      return resourceIds;
    } catch (err) {
      this.lastError = errorMessage(err);
      throw err;
    }
  }

  async writeRelationships(tuples: AuthzTuple[]): Promise<void> {
    if (!this.client || tuples.length === 0) return;
    await this.client.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: tuples.map((tuple) =>
          v1.RelationshipUpdate.create({
            operation:
              tuple.operation === "create"
                ? v1.RelationshipUpdate_Operation.TOUCH
                : v1.RelationshipUpdate_Operation.DELETE,
            relationship: v1.Relationship.create({
              resource: objectRef(tuple.resource),
              relation: tuple.relation,
              subject: subjectRef(tuple.subject),
            }),
          }),
        ),
      }),
    );
    this.lastError = null;
  }

  async replaceAllRelationships(tuples: AuthzTuple[]): Promise<AuthzReplaceResult> {
    if (!this.client) {
      return { purgedResourceTypes: [], tupleCount: tuples.length };
    }
    await this.writeSchemaFromDisk();
    const purgedResourceTypes: string[] = [];
    try {
      for (const resourceType of MANAGED_AUTHZ_RESOURCE_TYPES) {
        await this.client.promises.deleteRelationships(
          v1.DeleteRelationshipsRequest.create({
            relationshipFilter: v1.RelationshipFilter.create({ resourceType }),
          }),
        );
        purgedResourceTypes.push(resourceType);
      }
      for (const chunk of chunks(tuples, WRITE_RELATIONSHIPS_BATCH_SIZE)) {
        await this.writeRelationships(chunk);
      }
      this.lastError = null;
      return { purgedResourceTypes, tupleCount: tuples.length };
    } catch (err) {
      this.lastError = errorMessage(err);
      throw err;
    }
  }

  async enqueue(tuple: AuthzTuple): Promise<void> {
    await this.options.db.insert(authzOutbox).values({
      operation: tuple.operation,
      resourceType: tuple.resource.type,
      resourceId: tuple.resource.id,
      relation: tuple.relation,
      subjectType: tuple.subject.type,
      subjectId: tuple.subject.id,
      subjectRelation: tuple.subject.relation ?? null,
      payload: tuple.payload ?? {},
    });
  }

  async enqueueMany(tuples: AuthzTuple[]): Promise<void> {
    const coalesced = coalesceAuthzTuples(tuples);
    if (coalesced.length === 0) return;
    await this.options.db.insert(authzOutbox).values(
      coalesced.map((tuple) => ({
        operation: tuple.operation,
        resourceType: tuple.resource.type,
        resourceId: tuple.resource.id,
        relation: tuple.relation,
        subjectType: tuple.subject.type,
        subjectId: tuple.subject.id,
        subjectRelation: tuple.subject.relation ?? null,
        payload: tuple.payload ?? {},
      })),
    );
  }

  async hasPendingRelationship(tuple: AuthzTuple): Promise<boolean> {
    const subjectRelation = tuple.subject.relation
      ? eq(authzOutbox.subjectRelation, tuple.subject.relation)
      : isNull(authzOutbox.subjectRelation);
    const [row] = await this.options.db
      .select({ id: authzOutbox.id })
      .from(authzOutbox)
      .where(
        and(
          eq(authzOutbox.operation, tuple.operation),
          eq(authzOutbox.resourceType, tuple.resource.type),
          eq(authzOutbox.resourceId, tuple.resource.id),
          eq(authzOutbox.relation, tuple.relation),
          eq(authzOutbox.subjectType, tuple.subject.type),
          eq(authzOutbox.subjectId, tuple.subject.id),
          subjectRelation,
          inArray(authzOutbox.status, ["pending", "processing"]),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async lookupPendingRelationshipResources(input: PendingRelationshipLookup): Promise<string[]> {
    const subjectRelation = input.subject.relation
      ? eq(authzOutbox.subjectRelation, input.subject.relation)
      : isNull(authzOutbox.subjectRelation);
    const rows = await this.options.db
      .select({ resourceId: authzOutbox.resourceId })
      .from(authzOutbox)
      .where(
        and(
          eq(authzOutbox.operation, input.operation),
          eq(authzOutbox.resourceType, input.resourceType),
          eq(authzOutbox.relation, input.relation),
          eq(authzOutbox.subjectType, input.subject.type),
          eq(authzOutbox.subjectId, input.subject.id),
          subjectRelation,
          inArray(authzOutbox.status, ["pending", "processing"]),
        ),
      );
    return [...new Set(rows.map((row) => row.resourceId))];
  }

  async enqueueSchemaTouch(): Promise<void> {
    await this.options.db.insert(authzOutbox).values({
      operation: "touch_schema",
      resourceType: "platform",
      resourceId: "root",
      relation: "schema",
      subjectType: "platform",
      subjectId: "root",
      payload: {},
    });
  }

  async processOutbox(
    batchSize: number,
    options: ProcessOutboxOptions = {},
  ): Promise<{ processed: number; dead: number }> {
    if (!this.client) return { processed: 0, dead: 0 };
    const now = new Date();
    const statusWhere = options.forcePending
      ? or(
          eq(authzOutbox.status, "pending"),
          and(eq(authzOutbox.status, "processing"), lte(authzOutbox.nextAttemptAt, now)),
        )
      : and(
          lte(authzOutbox.nextAttemptAt, now),
          or(eq(authzOutbox.status, "pending"), eq(authzOutbox.status, "processing")),
        );
    const eligibleWhere =
      options.resourceType && options.resourceId
        ? and(
            statusWhere,
            eq(authzOutbox.resourceType, options.resourceType),
            eq(authzOutbox.resourceId, options.resourceId),
          )
        : statusWhere;
    const priorResourceMutation = noEarlierResourceMutation();
    let processed = 0;
    let dead = 0;
    let remaining = batchSize;
    while (remaining > 0) {
      const rows = await this.options.db
        .select()
        .from(authzOutbox)
        .where(and(eligibleWhere, priorResourceMutation))
        .orderBy(asc(authzOutbox.sequence))
        .limit(remaining);
      if (rows.length === 0) break;

      let claimedAny = false;
      for (const row of rows) {
        const claimed = await this.options.db
          .update(authzOutbox)
          .set({
            status: "processing",
            attempts: row.attempts + 1,
            nextAttemptAt: new Date(Date.now() + OUTBOX_PROCESSING_LEASE_MS),
          })
          .where(and(eq(authzOutbox.id, row.id), eligibleWhere, priorResourceMutation))
          .returning({ id: authzOutbox.id });
        if (claimed.length === 0) continue;
        claimedAny = true;
        remaining -= 1;
        try {
          if (row.operation === "touch_schema") {
            await this.writeSchemaFromDisk();
          } else {
            await this.writeRelationships([
              {
                operation: row.operation === "delete" ? "delete" : "create",
                resource: { type: row.resourceType, id: row.resourceId },
                relation: row.relation,
                subject: {
                  type: row.subjectType,
                  id: row.subjectId,
                  relation: row.subjectRelation,
                },
                payload: row.payload,
              },
            ]);
          }
          await this.options.db
            .update(authzOutbox)
            .set({ status: "succeeded", processedAt: new Date(), lastError: null })
            .where(eq(authzOutbox.id, row.id));
          processed += 1;
        } catch (err) {
          const nextAttempts = row.attempts + 1;
          const nextStatus = nextAttempts >= MAX_OUTBOX_ATTEMPTS ? "dead" : "pending";
          if (nextStatus === "dead") dead += 1;
          await this.options.db
            .update(authzOutbox)
            .set({
              status: nextStatus,
              lastError: errorMessage(err),
              nextAttemptAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** nextAttempts)),
            })
            .where(eq(authzOutbox.id, row.id));
        }
      }
      if (!claimedAny) break;
    }
    return { processed, dead };
  }

  async shadowCheck(input: ShadowCheckInput): Promise<boolean> {
    if (this.options.mode !== "shadow") return input.localAllowed;
    try {
      const spiceAllowed = await this.check(input);
      if (spiceAllowed !== input.localAllowed) {
        await this.recordDiff(input, spiceAllowed, null);
      }
    } catch (err) {
      await this.recordDiff(input, false, errorMessage(err));
      this.options.logger?.warn({ err }, "SpiceDB shadow check failed");
    }
    return input.localAllowed;
  }

  async requirePermission(input: AuthzCheck, isPlatformAdmin: boolean): Promise<void> {
    if (this.options.mode === "off") return;
    try {
      const allowed = await this.check(input);
      if (!allowed) {
        throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
      }
    } catch (err) {
      if (
        this.options.platformAdminDegrade &&
        isPlatformAdmin &&
        !(err instanceof AppError && err.statusCode === 403)
      ) {
        this.options.logger?.warn(
          { err, actor: authzActorForAudit(input) },
          "Platform administrator degraded through local authorization because SpiceDB failed",
        );
        await this.recordDegradedFallback(input, errorMessage(err));
        return;
      }
      if (err instanceof AppError) throw err;
      throw new AppError(
        ErrorCode.FORBIDDEN,
        `Authorization unavailable: ${errorMessage(err)}`,
        403,
      );
    }
  }

  async recordDiff(
    input: ShadowCheckInput,
    spiceAllowed: boolean,
    spiceError: string | null,
  ): Promise<void> {
    await this.options.db.insert(authzShadowDiffs).values({
      actorUserId: input.actorUserId ?? null,
      actorEmail: input.actorEmail ?? null,
      resourceType: input.resource.type,
      resourceId: input.resource.id,
      permission: input.permission,
      localAllowed: input.localAllowed,
      spiceAllowed,
      spiceError,
      context: input.context ?? {},
    });
  }

  private async recordDegradedFallback(input: AuthzCheck, spiceError: string): Promise<void> {
    await this.options.db.insert(auditLog).values({
      actor: authzActorForAudit(input),
      action: "authz.degraded_fallback",
      target: `${input.resource.type}:${input.resource.id}#${input.permission}`,
      diff: {
        before: {
          spiceAllowed: "unavailable",
          spiceError,
        },
        after: {
          localPlatformAdminFallback: true,
          subject: input.subject,
          context: input.context ?? {},
        },
      },
    });
  }

  getLastError(): string | null {
    return this.lastError;
  }

  private async readSchemaFromDisk(): Promise<string> {
    return readFile(this.options.schemaPath, "utf8");
  }
}

function noEarlierResourceMutation() {
  return sql`NOT EXISTS (
    SELECT 1
    FROM authz_outbox AS earlier
    WHERE earlier.resource_type = ${authzOutbox.resourceType}
      AND earlier.resource_id = ${authzOutbox.resourceId}
      AND earlier.status IN ('pending', 'processing', 'dead')
      AND earlier.sequence < ${authzOutbox.sequence}
  )`;
}

export function coalesceAuthzTuples(tuples: AuthzTuple[]): AuthzTuple[] {
  const latest = new Map<string, AuthzTuple>();
  for (const tuple of tuples) {
    const key = [
      tuple.resource.type,
      tuple.resource.id,
      tuple.relation,
      tuple.subject.type,
      tuple.subject.id,
      tuple.subject.relation ?? "",
    ].join("\0");
    latest.set(key, tuple);
  }
  return [...latest.values()];
}

function objectRef(input: AuthzObjectRef): v1.ObjectReference {
  return v1.ObjectReference.create({ objectType: input.type, objectId: input.id });
}

function subjectRef(input: AuthzSubjectRef): v1.SubjectReference {
  return v1.SubjectReference.create({
    object: objectRef(input),
    optionalRelation: input.relation ?? "",
  });
}

function fullyConsistent(): v1.Consistency {
  return v1.Consistency.create({
    requirement: { oneofKind: "fullyConsistent", fullyConsistent: true },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function authzActorForAudit(input: Pick<AuthzCheck, "actorUserId" | "actorEmail">): string {
  return input.actorUserId ?? input.actorEmail ?? "unknown";
}

function normalizedSchema(schema: string): string {
  const definitions = [...schema.matchAll(/definition\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/g)];
  if (definitions.length === 0) {
    return schema.replace(/\s+/g, "");
  }
  return definitions
    .map((definition) => {
      const name = definition[1] ?? "";
      const body = definition[2] ?? "";
      return `definition ${name}{${body.replace(/\s+/g, "")}}`;
    })
    .sort()
    .join("\n");
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * admin alias-export endpoint (PRD F22.15).
 *
 * `POST /api/admin/desensitize/export` body `{aliasIds: string[]}`
 *
 * Restricted to platform_admin. Looks up alias→original mappings from
 * `desensitize_alias_map` and returns a JWT signed with a dedicated
 * short-TTL key (default 10 min). Audit-log entry: who/when/which aliases.
 *
 * The token is intentionally signed with a separate key from the regular
 * Server JWT secret so:
 *   1. Compromise of one does not affect the other.
 *   2. Rotation can be performed independently.
 */
import { auditLog, desensitizeAliasMap, desensitizeConfig, type PgDb } from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { asc, inArray, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import * as jose from "jose";
import { z } from "zod";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";
import { writeAudit } from "../services/audit-log-writer";

export interface AdminDesensitizeRouteOptions {
  /** Dedicated signing key for the export JWT. MUST be ≥32 bytes. */
  exportKey?: string;
  /** Token lifetime in seconds. Default: 10 minutes. */
  ttlSec?: number;
  authz?: AuthzService;
}

const ExportRequestSchema = z.object({
  aliasIds: z.array(z.string().min(1).max(64)).min(1).max(1000),
});

const ENABLED_SENTINEL = "__enabled__";
const RuleSchema = z
  .object({
    scope: z.enum(["global", "provider", "cluster"]),
    scopeId: z.string().trim().min(1).max(255).nullable(),
    fieldPath: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => value !== ENABLED_SENTINEL),
    action: z.enum(["passthrough", "hash", "alias", "redact", "hide"]),
  })
  .superRefine((rule, ctx) => {
    if (rule.scope === "global" && rule.scopeId !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["scopeId"],
        message: "Global rules cannot set scopeId",
      });
    }
    if (rule.scope !== "global" && rule.scopeId === null) {
      ctx.addIssue({ code: "custom", path: ["scopeId"], message: "Scoped rules require scopeId" });
    }
  });

const ConfigUpdateSchema = z
  .object({
    globalEnabled: z.boolean(),
    rules: z.array(RuleSchema).max(500),
  })
  .superRefine((config, ctx) => {
    const keys = new Set<string>();
    config.rules.forEach((rule, index) => {
      const key = `${rule.scope}\u0000${rule.scopeId ?? ""}\u0000${rule.fieldPath}`;
      if (keys.has(key)) {
        ctx.addIssue({ code: "custom", path: ["rules", index], message: "Duplicate rule" });
      }
      keys.add(key);
    });
  });

interface AliasRecord {
  aliasId: string;
  originalValue: string | null;
  salt?: string;
}

export function createAdminDesensitizeRoutes(db: PgDb, opts: AdminDesensitizeRouteOptions) {
  const r = new Hono();
  const ttlSec = opts.ttlSec ?? 10 * 60;
  const exportKey = opts.exportKey ? new TextEncoder().encode(opts.exportKey) : null;

  r.get("/admin/desensitize/config", async (c) => {
    await requirePlatformPermission(c, opts.authz, "manage", "admin-desensitize");
    return c.json(await loadConfigView(db, exportKey !== null));
  });

  r.put(
    "/admin/desensitize/config",
    kqValidator("json", ConfigUpdateSchema, "Invalid desensitization config body"),
    async (c) => {
      await requirePlatformPermission(c, opts.authz, "manage", "admin-desensitize");
      const actorUserId = requireCanonicalDesensitizeAdminActor(c);
      const input = c.req.valid("json");
      const values = [
        ...(input.globalEnabled
          ? [{ scope: "global", scopeId: null, fieldPath: ENABLED_SENTINEL, action: "redact" }]
          : []),
        ...input.rules,
      ];

      const after = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE ${desensitizeConfig} IN EXCLUSIVE MODE`);
        const before = await loadConfigView(tx, exportKey !== null);
        await tx.delete(desensitizeConfig);
        if (values.length > 0) await tx.insert(desensitizeConfig).values(values);
        await tx.insert(auditLog).values({
          actor: actorUserId,
          orgId: null,
          action: "desensitize.config.update",
          target: "desensitize_config",
          diff: {
            before: configAuditView(before),
            after: { globalEnabled: input.globalEnabled, rules: input.rules },
          },
        });
        return loadConfigView(tx, exportKey !== null);
      });

      return c.json(after);
    },
  );

  if (exportKey) {
    r.post(
      "/admin/desensitize/export",
      kqValidator("json", ExportRequestSchema, "Invalid alias-export body"),
      async (c) => {
        await requirePlatformPermission(c, opts.authz, "manage", "admin-desensitize");
        const actorUserId = requireCanonicalDesensitizeAdminActor(c);

        const { aliasIds } = c.req.valid("json");

        // Resolve aliases. Unknown ids stay in the response with originalValue=null
        // so the caller knows which were not present.
        const rows = await db
          .select()
          .from(desensitizeAliasMap)
          .where(inArray(desensitizeAliasMap.aliasId, aliasIds));

        const resolvedById = new Map(rows.map((row) => [row.aliasId, row] as const));
        const records: AliasRecord[] = aliasIds.map((aliasId) => {
          const row = resolvedById.get(aliasId);
          return row
            ? { aliasId, originalValue: row.originalValue, salt: row.salt }
            : { aliasId, originalValue: null };
        });

        // Sign the export envelope with the dedicated key. Short TTL so leaked
        // tokens stop working quickly.
        const now = Math.floor(Date.now() / 1000);
        const token = await new jose.SignJWT({
          purpose: "desensitize-alias-export",
          records,
          requestedBy: actorUserId,
        })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuedAt(now)
          .setExpirationTime(now + ttlSec)
          .sign(exportKey);

        // Best-effort audit-log entry. Failure to write the audit row should
        // surface to the operator (a silent miss would defeat the compliance
        // intent), so we let exceptions propagate.
        await writeAudit(db, {
          actor: actorUserId,
          action: "desensitize.export",
          target: "desensitize_alias_map",
          diff: {
            after: {
              aliasIds,
              requested: aliasIds.length,
              resolved: rows.length,
            },
          },
        });

        return c.json({ token, expiresIn: ttlSec, count: records.length });
      },
    );
  }

  return r;
}

async function loadConfigView(db: Pick<PgDb, "select">, exportEnabled: boolean) {
  const rows = await db
    .select()
    .from(desensitizeConfig)
    .orderBy(
      asc(desensitizeConfig.scope),
      asc(desensitizeConfig.scopeId),
      asc(desensitizeConfig.fieldPath),
    );
  return {
    globalEnabled: rows.some((row) => row.scope === "global" && row.fieldPath === ENABLED_SENTINEL),
    rules: rows
      .filter((row) => row.fieldPath !== ENABLED_SENTINEL)
      .map((row) => ({
        id: row.id,
        scope: row.scope,
        scopeId: row.scopeId,
        fieldPath: row.fieldPath,
        action: row.action,
        updatedAt: row.updatedAt.toISOString(),
      })),
    exportEnabled,
  };
}

function configAuditView(config: Awaited<ReturnType<typeof loadConfigView>>) {
  return {
    globalEnabled: config.globalEnabled,
    rules: config.rules.map(({ id: _id, updatedAt: _updatedAt, ...rule }) => rule),
  };
}

function requireCanonicalDesensitizeAdminActor(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (!principal?.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  return principal.userId;
}

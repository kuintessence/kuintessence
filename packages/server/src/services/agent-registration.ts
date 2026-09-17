import { createHash, randomBytes } from "node:crypto";
import { agentCerts, agentRegistrationIntents, agents, type PgDb } from "@kuintessence/db";
import { AppError, ErrorCode, type SchedulerType } from "@kuintessence/shared";
import { and, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { CaMaterial } from "../auth/ca";
import { issueAgentCert } from "../auth/cert-issuer";
import { agentPlatformTuple, agentProviderTuple } from "../authz/projection";
import type { AuthzService, AuthzTuple } from "../authz/service";
import { writeAudit } from "./audit-log-writer";

const TOKEN_PREFIX = "kqagt-";
const DEFAULT_TOKEN_BYTES = 32;

export interface AgentRegistrationTokenView {
  id: string;
  agentId: string;
  siteName: string;
  providerOrgId: string;
  token: string;
  expiresAt: Date;
}

export interface AgentRegistrationMetadata {
  id: string;
  agentId: string;
  siteName: string;
  providerOrgId: string;
  expiresAt: Date;
}

export interface AgentRegistrationIntentView extends AgentRegistrationMetadata {
  createdAt: Date;
}

export interface AgentRegistrationCompleteInput {
  token: string;
  csrPem: string;
  schedulerType: SchedulerType;
  schedulerVersion: string;
  siteId?: string;
  clusterId?: string;
  topology?: Record<string, unknown>;
}

export interface AgentRegistrationCompleteResult {
  agentId: string;
  siteName: string;
  providerOrgId: string;
  certPem: string;
  caCertPem: string;
  fingerprintSha256: string;
  expiresAt: Date;
}

export class AgentRegistrationService {
  constructor(
    private readonly db: PgDb,
    private readonly ca: CaMaterial,
    private readonly authz?: AuthzService,
  ) {}

  async createToken(input: {
    agentId: string;
    siteName: string;
    providerOrgId: string;
    expiresInSec: number;
    createdBy: string;
  }): Promise<AgentRegistrationTokenView> {
    const token = mintToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.expiresInSec * 1000);
    const row = await this.db.transaction(async (tx) => {
      const [existingAgent] = await tx
        .select({ agentId: agents.agentId })
        .from(agents)
        .where(eq(agents.agentId, input.agentId))
        .limit(1);
      if (existingAgent) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Agent id is already registered", 400);
      }

      await tx
        .update(agentRegistrationIntents)
        .set({ revokedAt: now })
        .where(
          and(
            eq(agentRegistrationIntents.agentId, input.agentId),
            isNull(agentRegistrationIntents.usedAt),
            isNull(agentRegistrationIntents.revokedAt),
            lte(agentRegistrationIntents.expiresAt, now),
          ),
        );

      const [activeIntent] = await tx
        .select({ id: agentRegistrationIntents.id })
        .from(agentRegistrationIntents)
        .where(
          and(
            eq(agentRegistrationIntents.agentId, input.agentId),
            isNull(agentRegistrationIntents.usedAt),
            isNull(agentRegistrationIntents.revokedAt),
            gt(agentRegistrationIntents.expiresAt, now),
          ),
        )
        .limit(1);
      if (activeIntent) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Agent id already has an active registration token",
          400,
        );
      }

      const [created] = await tx
        .insert(agentRegistrationIntents)
        .values({
          agentId: input.agentId,
          siteName: input.siteName,
          providerOrgId: input.providerOrgId,
          tokenHash: hashToken(token),
          expiresAt,
          createdBy: input.createdBy,
        })
        .returning();
      return created;
    });
    if (!row) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Agent registration token was not created", 500);
    }
    await writeAudit(this.db, {
      actor: input.createdBy,
      action: "agent.registration_token.create",
      target: input.agentId,
      diff: {
        after: {
          providerOrgId: input.providerOrgId,
          siteName: input.siteName,
          expiresAt: expiresAt.toISOString(),
        },
      },
    });
    return {
      id: row.id,
      agentId: row.agentId,
      siteName: row.siteName,
      providerOrgId: row.providerOrgId,
      token,
      expiresAt: row.expiresAt,
    };
  }

  async metadata(token: string): Promise<AgentRegistrationMetadata> {
    const row = await this.requireActiveIntent(token);
    return {
      id: row.id,
      agentId: row.agentId,
      siteName: row.siteName,
      providerOrgId: row.providerOrgId,
      expiresAt: row.expiresAt,
    };
  }

  async listActive(input: {
    providerOrgIds: string[];
    isPlatformWide: boolean;
  }): Promise<AgentRegistrationIntentView[]> {
    if (!input.isPlatformWide && input.providerOrgIds.length === 0) return [];
    const now = new Date();
    const rows = await this.db
      .select({
        id: agentRegistrationIntents.id,
        agentId: agentRegistrationIntents.agentId,
        siteName: agentRegistrationIntents.siteName,
        providerOrgId: agentRegistrationIntents.providerOrgId,
        expiresAt: agentRegistrationIntents.expiresAt,
        createdAt: agentRegistrationIntents.createdAt,
      })
      .from(agentRegistrationIntents)
      .where(
        and(
          isNull(agentRegistrationIntents.usedAt),
          isNull(agentRegistrationIntents.revokedAt),
          gt(agentRegistrationIntents.expiresAt, now),
          input.isPlatformWide
            ? undefined
            : inArray(agentRegistrationIntents.providerOrgId, input.providerOrgIds),
        ),
      )
      .orderBy(desc(agentRegistrationIntents.createdAt));
    return rows;
  }

  async complete(input: AgentRegistrationCompleteInput): Promise<AgentRegistrationCompleteResult> {
    const intent = await this.requireActiveIntent(input.token);
    const issued = issueAgentCert({
      ca: this.ca,
      csrPem: input.csrPem,
      agentId: intent.agentId,
    });

    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(agentRegistrationIntents)
        .set({ usedAt: now })
        .where(
          and(
            eq(agentRegistrationIntents.id, intent.id),
            isNull(agentRegistrationIntents.usedAt),
            isNull(agentRegistrationIntents.revokedAt),
          ),
        )
        .returning();
      if (!claimed || claimed.expiresAt.getTime() <= now.getTime()) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          "Agent registration token is no longer active",
          403,
        );
      }

      const [existing] = await tx
        .select({ providerOrgId: agents.providerOrgId })
        .from(agents)
        .where(eq(agents.agentId, intent.agentId))
        .limit(1);
      const [agent] = await tx
        .insert(agents)
        .values({
          agentId: intent.agentId,
          siteName: intent.siteName,
          providerOrgId: intent.providerOrgId,
          siteId: input.siteId ?? intent.siteName,
          clusterId: input.clusterId ?? intent.agentId,
          topology: input.topology ?? {},
          schedulerType: input.schedulerType,
          schedulerVersion: input.schedulerVersion,
          status: "offline",
        })
        .onConflictDoUpdate({
          target: agents.agentId,
          set: {
            siteName: intent.siteName,
            providerOrgId: intent.providerOrgId,
            siteId: input.siteId ?? intent.siteName,
            clusterId: input.clusterId ?? intent.agentId,
            topology: input.topology ?? {},
            schedulerType: input.schedulerType,
            schedulerVersion: input.schedulerVersion,
            status: "offline",
          },
        })
        .returning();
      if (!agent) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Agent registration upsert failed", 500);
      }

      await tx.insert(agentCerts).values({
        agentId: intent.agentId,
        fingerprintSha256: issued.fingerprintSha256,
        subjectCn: issued.subjectCn,
        certPem: issued.certPem,
        expiresAt: issued.expiresAt,
        revokedAt: null,
        issuedBy: intent.createdBy,
      });
      return { previousProviderOrgId: existing?.providerOrgId };
    });

    await this.authz?.enqueueMany(
      agentRegistrationTuples(intent.agentId, intent.providerOrgId, result.previousProviderOrgId),
    );
    await writeAudit(this.db, {
      actor: intent.createdBy ?? intent.providerOrgId,
      action: "agent.registration.complete",
      target: intent.agentId,
      diff: {
        after: {
          providerOrgId: intent.providerOrgId,
          fingerprint: issued.fingerprintSha256,
          schedulerType: input.schedulerType,
          schedulerVersion: input.schedulerVersion,
        },
      },
    });
    await writeAudit(this.db, {
      actor: intent.createdBy ?? intent.providerOrgId,
      action: "agent_cert_issued",
      target: intent.agentId,
      diff: {
        after: {
          fingerprint: issued.fingerprintSha256,
          expiresAt: issued.expiresAt.toISOString(),
        },
      },
    });

    return {
      agentId: intent.agentId,
      siteName: intent.siteName,
      providerOrgId: intent.providerOrgId,
      certPem: issued.certPem,
      caCertPem: this.ca.certPem,
      fingerprintSha256: issued.fingerprintSha256,
      expiresAt: issued.expiresAt,
    };
  }

  async revoke(input: {
    id: string;
    providerOrgIds: string[];
    isPlatformWide: boolean;
    revokedBy: string;
  }): Promise<void> {
    const [row] = await this.db
      .select()
      .from(agentRegistrationIntents)
      .where(eq(agentRegistrationIntents.id, input.id))
      .limit(1);
    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, "Agent registration token not found", 404);
    }
    if (!input.isPlatformWide && !input.providerOrgIds.includes(row.providerOrgId)) {
      throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to revoke this token", 403);
    }
    if (row.usedAt) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Used registration tokens cannot be revoked",
        400,
      );
    }
    if (row.revokedAt) return;
    await this.db
      .update(agentRegistrationIntents)
      .set({ revokedAt: new Date() })
      .where(eq(agentRegistrationIntents.id, input.id));
    await writeAudit(this.db, {
      actor: input.revokedBy,
      action: "agent.registration_token.revoke",
      target: row.agentId,
      diff: { after: { providerOrgId: row.providerOrgId } },
    });
  }

  private async requireActiveIntent(token: string) {
    const [row] = await this.db
      .select()
      .from(agentRegistrationIntents)
      .where(eq(agentRegistrationIntents.tokenHash, hashToken(token)))
      .limit(1);
    if (!row) {
      throw new AppError(ErrorCode.FORBIDDEN, "Invalid agent registration token", 403);
    }
    if (row.usedAt) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Agent registration token has already been used",
        403,
      );
    }
    if (row.revokedAt) {
      throw new AppError(ErrorCode.FORBIDDEN, "Agent registration token has been revoked", 403);
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new AppError(ErrorCode.FORBIDDEN, "Agent registration token has expired", 403);
    }
    return row;
  }
}

function mintToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(DEFAULT_TOKEN_BYTES).toString("base64url")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function agentRegistrationTuples(
  agentId: string,
  providerOrgId: string,
  previousProviderOrgId: string | null | undefined,
): AuthzTuple[] {
  const tuples: AuthzTuple[] = [agentPlatformTuple(agentId)];
  if (previousProviderOrgId && previousProviderOrgId !== providerOrgId) {
    tuples.push({
      ...agentProviderTuple({ agentId, providerOrgId: previousProviderOrgId }),
      operation: "delete",
    });
  }
  tuples.push(agentProviderTuple({ agentId, providerOrgId }));
  return tuples;
}

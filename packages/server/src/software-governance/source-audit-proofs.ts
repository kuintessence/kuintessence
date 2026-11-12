import {
  agents,
  assertSpackMaterialReleasesAvailable,
  auditLog,
  type PgDb,
  SpackMaterialLifecycleError,
  softwareOperations,
  spackInstallBindingEvents,
} from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  parseSiteOperations,
  SPACK_SOURCE_PROOF_PREFIX,
  SpackAuditContextSchema,
  SpackMaterialDigestSchema,
  type SpackSourceAuditEnvelope,
  SpackSourceAuditEnvelopeSchema,
} from "@kuintessence/shared";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { SpackDeliveryAccess } from "./spack-material-delivery";

const DISPATCH = "software.source-audit.dispatch";
const PROOF = "software.source-audit.proof";
const REVOKE = "software.source-audit.revoke";
const LIFETIME_MS = 24 * 60 * 60_000;
const DispatchSchema = z.strictObject({
  operationId: z.string().uuid(),
  agentId: z.string(),
  requestedBy: z.string().uuid(),
  spec: z.string(),
  repositoryId: z.string().regex(/^[a-f0-9]{64}$/),
  manifestDigest: SpackMaterialDigestSchema,
  nativeLockDigest: SpackMaterialDigestSchema,
  certificateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  preparedAt: z.number().int(),
  context: SpackAuditContextSchema,
  bindingScope: z.string(),
  bindingRevision: z.number().int().positive(),
});
const ProofSchema = z.strictObject({
  dispatch: DispatchSchema,
  envelope: SpackSourceAuditEnvelopeSchema,
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
});
type Proof = z.infer<typeof ProofSchema>;

function sourceAuditProofMatches(proof: Proof, now: number): boolean {
  const { dispatch, envelope } = proof;
  return (
    dispatch.preparedAt <= proof.issuedAt &&
    proof.issuedAt - dispatch.preparedAt < LIFETIME_MS &&
    proof.issuedAt <= now &&
    proof.expiresAt > now &&
    proof.expiresAt - proof.issuedAt === LIFETIME_MS &&
    envelope.report.passed &&
    envelope.report.issues.every((issue) => issue.severity !== "error") &&
    envelope.operationId === dispatch.operationId &&
    envelope.spec === dispatch.spec &&
    envelope.report.manifestDigest === dispatch.manifestDigest &&
    envelope.nativeLockDigest === dispatch.nativeLockDigest &&
    envelope.context.siteProfileDigest === dispatch.context.siteProfileDigest &&
    envelope.context.runtimeDigest === dispatch.context.runtimeDigest
  );
}

/** Proofs are append-only audit events; clients cannot write their authority or timestamps. */
export class SourceAuditProofs {
  constructor(
    private readonly db: Pick<PgDb, "select" | "insert">,
    private readonly dispatcher: Pick<AgentDispatcher, "getChannel">,
    private readonly access: SpackDeliveryAccess,
    private readonly authorize: (input: {
      agentId: string;
      requestedBy: string;
      providerOrgId: string | null;
      spec: string;
    }) => Promise<boolean>,
  ) {}

  withConnection(db: Pick<PgDb, "select" | "insert">): SourceAuditProofs {
    return new SourceAuditProofs(db, this.dispatcher, this.access, this.authorize);
  }

  private async latest(action: string, operationId: string) {
    const [row] = await this.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.target, operationId)))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(1);
    return row;
  }

  private async binding(agent: typeof agents.$inferSelect, spec: string) {
    const read = async (scope: string) => {
      const [row] = await this.db
        .select()
        .from(spackInstallBindingEvents)
        .where(
          and(eq(spackInstallBindingEvents.scope, scope), eq(spackInstallBindingEvents.spec, spec)),
        )
        .orderBy(desc(spackInstallBindingEvents.revision))
        .limit(1);
      return row;
    };
    const row =
      (agent.providerOrgId ? await read(agent.providerOrgId) : undefined) ??
      (await read("platform"));
    return row?.state === "enabled" ? row : undefined;
  }

  async dispatched(input: {
    operationId: string;
    agentId: string;
    requestedBy: string;
    spec: string;
    repositoryId: string;
    manifestDigest: string;
    nativeLockDigest: string;
    certificateFingerprint: string;
  }): Promise<void> {
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(eq(agents.agentId, input.agentId))
      .limit(1);
    const context =
      agent && parseSiteOperations(JSON.stringify(agent.siteOperations))?.auditContext;
    const channel = this.dispatcher.getChannel(input.agentId);
    if (
      !agent ||
      !context ||
      !channel?.siteAuditContext ||
      channel.siteAuditContext.siteProfileDigest !== context.siteProfileDigest ||
      channel.siteAuditContext.runtimeDigest !== context.runtimeDigest
    )
      return;
    const binding = await this.binding(agent, input.spec);
    if (
      !binding ||
      binding.repositoryId !== input.repositoryId ||
      binding.manifestDigest !== input.manifestDigest
    )
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Spack audit binding changed before dispatch",
        409,
      );
    const snapshot = DispatchSchema.parse({
      ...input,
      preparedAt: Date.now(),
      context,
      bindingScope: binding.scope,
      bindingRevision: binding.revision,
    });
    if (await this.latest(DISPATCH, input.operationId)) return;
    await this.db.insert(auditLog).values({
      actor: input.requestedBy,
      action: DISPATCH,
      target: input.operationId,
      diff: { after: snapshot },
    });
  }

  async accept(
    agentId: string,
    operationId: string,
    stdout: string,
    certificateFingerprint?: string,
  ): Promise<void> {
    if (!stdout.startsWith(SPACK_SOURCE_PROOF_PREFIX) || stdout.length > 64 * 1024) return;
    const saved = await this.latest(DISPATCH, operationId);
    const dispatch = DispatchSchema.safeParse(saved?.diff?.after);
    if (
      !dispatch.success ||
      dispatch.data.agentId !== agentId ||
      dispatch.data.certificateFingerprint !== certificateFingerprint ||
      (await this.latest(REVOKE, operationId))
    )
      return;
    let envelope: SpackSourceAuditEnvelope;
    try {
      envelope = SpackSourceAuditEnvelopeSchema.parse(
        JSON.parse(stdout.slice(SPACK_SOURCE_PROOF_PREFIX.length)),
      );
    } catch {
      return;
    }
    const now = Date.now();
    const proof: Proof = {
      dispatch: dispatch.data,
      envelope,
      issuedAt: now,
      expiresAt: now + LIFETIME_MS,
    };
    if (!sourceAuditProofMatches(proof, now) || !(await this.current(proof))) return;
    if (await this.latest(PROOF, operationId)) return;
    await this.db
      .insert(auditLog)
      .values({ actor: agentId, action: PROOF, target: operationId, diff: { after: proof } });
  }

  private async current(proof: Proof): Promise<boolean> {
    const d = proof.dispatch;
    const channel = this.dispatcher.getChannel(d.agentId);
    if (
      !channel?.siteAuditContext ||
      !channel.siteAuditObservedAt ||
      channel.siteAuditObservedAt < Date.now() - 300_000 ||
      channel.siteAuditObservedAt > Date.now() + 60_000 ||
      channel.siteAuditContext.siteProfileDigest !== d.context.siteProfileDigest ||
      channel.siteAuditContext.runtimeDigest !== d.context.runtimeDigest ||
      channel.verifiedCertFingerprint !== d.certificateFingerprint ||
      !(await this.access.certificate(d.agentId, d.certificateFingerprint))
    )
      return false;
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(eq(agents.agentId, d.agentId))
      .limit(1);
    const context =
      agent && parseSiteOperations(JSON.stringify(agent.siteOperations))?.auditContext;
    if (
      !agent ||
      !context ||
      context.siteProfileDigest !== d.context.siteProfileDigest ||
      context.runtimeDigest !== d.context.runtimeDigest
    )
      return false;
    if (
      !(await this.authorize({
        agentId: d.agentId,
        requestedBy: d.requestedBy,
        providerOrgId: agent.providerOrgId,
        spec: d.spec,
      }))
    )
      return false;
    const binding = await this.binding(agent, d.spec);
    if (
      !binding ||
      binding.scope !== d.bindingScope ||
      binding.revision !== d.bindingRevision ||
      binding.repositoryId !== d.repositoryId ||
      binding.manifestDigest !== d.manifestDigest
    )
      return false;
    try {
      await assertSpackMaterialReleasesAvailable(this.db, [
        { repositoryId: d.repositoryId, manifestDigest: d.manifestDigest },
      ]);
    } catch (error) {
      if (
        error instanceof SpackMaterialLifecycleError &&
        error.code === "MATERIAL_RELEASE_WITHDRAWN"
      )
        return false;
      throw error;
    }
    const [operation] = await this.db
      .select()
      .from(softwareOperations)
      .where(eq(softwareOperations.id, d.operationId))
      .limit(1);
    if (
      operation?.agentId !== d.agentId ||
      operation.action !== "install" ||
      operation.spec !== d.spec ||
      operation.requestedBy !== d.requestedBy ||
      !["succeeded", "rejected"].includes(operation.status)
    )
      return false;
    const [latest] = await this.db
      .select()
      .from(softwareOperations)
      .where(
        and(
          eq(softwareOperations.agentId, d.agentId),
          eq(softwareOperations.spec, d.spec),
          eq(softwareOperations.action, "install"),
        ),
      )
      .orderBy(desc(softwareOperations.requestedAt), desc(softwareOperations.id))
      .limit(1);
    return latest?.id === d.operationId;
  }

  async get(operationId: string) {
    const saved = await this.latest(PROOF, operationId);
    const parsed = ProofSchema.safeParse(saved?.diff?.after);
    if (!parsed.success) return null;
    const proof = parsed.data;
    const revoked = Boolean(await this.latest(REVOKE, operationId));
    const valid =
      !revoked && sourceAuditProofMatches(proof, Date.now()) && (await this.current(proof));
    return { ...proof, revoked, valid };
  }

  async available(agentId: string, spec: string): Promise<boolean> {
    const [operation] = await this.db
      .select()
      .from(softwareOperations)
      .where(
        and(
          eq(softwareOperations.agentId, agentId),
          eq(softwareOperations.spec, spec),
          eq(softwareOperations.action, "install"),
        ),
      )
      .orderBy(desc(softwareOperations.requestedAt), desc(softwareOperations.id))
      .limit(1);
    if (!operation) return false;
    return (await this.get(operation.id))?.valid === true;
  }

  async revoke(operationId: string, actor: string, reason: string): Promise<void> {
    if (!(await this.latest(PROOF, operationId)))
      throw new AppError(ErrorCode.NOT_FOUND, "Source audit proof not found", 404);
    await this.db
      .insert(auditLog)
      .values({ actor, action: REVOKE, target: operationId, diff: { after: { reason } } });
  }
}

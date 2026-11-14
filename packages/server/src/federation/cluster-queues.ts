import {
  auditLog,
  federationAgreementApprovals,
  federationClusterQueues,
  federationReservationPolicies,
  federationSites,
  netdriveFiles,
  type PgDb,
  type PgTransaction,
  schedulerQueues,
  usecasePackages,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  type JobSubmit,
  type PlacementTrace,
  type QueueRegistryView,
  type WorkflowPlacementConfig,
  type workflowDsl,
} from "@kuintessence/shared";
import {
  type FederationAgreement,
  FederationAgreementSchema,
  type FederationClusterProfile,
  type FederationClusterQueueConfig,
  FederationClusterQueueConfigSchema,
  type FederationDelegation,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import type { FederationWorkflowMarket } from "@kuintessence/shared/federation/market";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { BoundPrincipal } from "../middleware/principal-binder";
import type { QueueAccessContext } from "../services/queue-registry";
import type { FederationAssetService } from "./assets";
import {
  type FederationActor,
  hasExplicitFederationCapability,
  requireFederationCapability,
} from "./permissions";

type RemoteNode = Extract<workflowDsl.WorkflowNode, { type: "Federation" }>;
type Row = typeof federationClusterQueues.$inferSelect;

function unavailable(message: string): never {
  throw new AppError(ErrorCode.VALIDATION_ERROR, message, 409);
}
function same(a: unknown, b: unknown) {
  return federationCanonicalJson(a) === federationCanonicalJson(b);
}

export function clusterQueueAllows(config: FederationClusterQueueConfig, actor: FederationActor) {
  return (
    config.enabled &&
    config.localOrgId === actor.orgId &&
    (config.allowAllMembers || config.allowedUserIds.includes(actor.userId))
  );
}

export async function loadClusterQueue(tx: PgTransaction, siteId: string, id: string) {
  const [row] = await tx
    .select()
    .from(federationClusterQueues)
    .where(and(eq(federationClusterQueues.id, id), eq(federationClusterQueues.localSiteId, siteId)))
    .for("share");
  return row;
}

/** Called again at send time, including recovered requests. No local fallback is permitted. */
export async function assertManagedClusterRequest(
  tx: PgTransaction,
  actor: FederationActor,
  request: FederationDelegation,
  assets: FederationAssetService,
  market?: FederationWorkflowMarket,
) {
  const placement = request.managedPlacement;
  if (!placement) {
    if (!(await hasExplicitFederationCapability(tx, actor, "delegation.submit")))
      throw new FederationError("POLICY_DENIED");
    return;
  }
  const row = await loadClusterQueue(tx, request.senderSiteId, placement.queueId);
  const profile = row?.config.profiles.find((p) => p.id === placement.profileId);
  if (
    !row ||
    !profile ||
    !clusterQueueAllows(row.config, actor) ||
    row.config.agreementRevisionId !== request.agreementRevisionId ||
    !same(row.config.executionTarget, request.executionTarget ?? null) ||
    !same(profile.template, request.template) ||
    profile.environmentLockDigest !== request.environmentLockDigest ||
    profile.maxAmount !== request.maxAmount
  )
    throw new FederationError("POLICY_DENIED");
  if (market && !same(market, profile.market ?? null)) throw new FederationError("POLICY_DENIED");
  const base = await assets.readMaterial(
    tx,
    actor.orgId,
    request.senderSiteId,
    profile.inputManifestDigest,
  );
  const inputs = await assets.readMaterial(
    tx,
    actor.orgId,
    request.senderSiteId,
    request.inputManifestDigest,
  );
  if (
    base.kind !== "inputs" ||
    inputs.kind !== "inputs" ||
    !same(base.bindings, inputs.bindings) ||
    !same(base.datasets, inputs.datasets)
  )
    throw new FederationError("POLICY_DENIED");
  // Overrides are separately validated against the receiver template's typed parameter contract.
}

export class FederationClusterQueueService {
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string | undefined,
    private readonly assets: FederationAssetService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async terms(
    tx: PgTransaction,
    orgId: string,
    revisionId: string,
  ): Promise<FederationAgreement> {
    const [approval] = await tx
      .select()
      .from(federationAgreementApprovals)
      .where(
        and(
          eq(
            federationAgreementApprovals.localSiteId,
            this.siteId ?? "00000000-0000-0000-0000-000000000000",
          ),
          eq(federationAgreementApprovals.localOrgId, orgId),
          eq(federationAgreementApprovals.revisionId, revisionId),
        ),
      )
      .for("share");
    if (!approval || approval.state !== "active" || !approval.counterpartyApprovalJws)
      throw new FederationError("AGREEMENT_UNAVAILABLE");
    const terms = FederationAgreementSchema.parse(approval.terms);
    const now = this.clock().getTime();
    if (
      terms.sourceSiteId !== this.siteId ||
      now < Date.parse(terms.validFrom) ||
      now >= Date.parse(terms.validUntil)
    )
      throw new FederationError("AUTHORIZATION_EXPIRED");
    return terms;
  }

  async list(actor: FederationActor) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "cluster.manage");
      const rows = await tx
        .select()
        .from(federationClusterQueues)
        .where(
          and(
            eq(
              federationClusterQueues.localSiteId,
              this.siteId ?? "00000000-0000-0000-0000-000000000000",
            ),
            eq(federationClusterQueues.localOrgId, actor.orgId),
          ),
        );
      return Promise.all(
        rows.map(async (row) => {
          const [approval] = await tx
            .select()
            .from(federationAgreementApprovals)
            .where(
              and(
                eq(federationAgreementApprovals.localSiteId, row.localSiteId),
                eq(federationAgreementApprovals.localOrgId, actor.orgId),
                eq(federationAgreementApprovals.revisionId, row.config.agreementRevisionId),
              ),
            );
          const targetSiteId = approval?.terms.targetSiteId;
          const [site] = targetSiteId
            ? await tx.select().from(federationSites).where(eq(federationSites.id, targetSiteId))
            : [];
          return {
            id: row.id,
            config: row.config,
            partnerName: site?.name ?? "",
            targetSiteId,
            updatedAt: row.updatedAt.toISOString(),
          };
        }),
      );
    });
  }

  async save(actor: FederationActor, raw: unknown, id?: string) {
    const config = FederationClusterQueueConfigSchema.parse(raw);
    if (!this.siteId || config.localOrgId !== actor.orgId)
      throw new FederationError("POLICY_DENIED");
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "cluster.manage");
      if (id) {
        const prior = await loadClusterQueue(tx, this.siteId ?? "", id);
        if (!prior || prior.localOrgId !== actor.orgId) throw new FederationError("POLICY_DENIED");
      }
      const terms = await this.terms(tx, actor.orgId, config.agreementRevisionId);
      if (!terms.executionTargets?.some((target) => same(target, config.executionTarget)))
        unavailable("The selected queue is not authorized by the signed cooperation agreement");
      if (
        id &&
        (
          await tx
            .select({ id: schedulerQueues.queueId })
            .from(schedulerQueues)
            .where(eq(schedulerQueues.queueId, id))
        ).length
      )
        unavailable("Queue identity conflicts with a local queue");
      if (config.allowedUserIds.length) {
        const members = await tx
          .select({ userId: users.id })
          .from(users)
          .innerJoin(
            userOrgMemberships,
            and(eq(userOrgMemberships.userId, users.id), eq(userOrgMemberships.orgId, actor.orgId)),
          )
          .where(
            and(
              inArray(users.id, config.allowedUserIds),
              eq(users.suspended, false),
              eq(users.serviceAccount, false),
            ),
          )
          .for("share");
        if (members.length !== config.allowedUserIds.length)
          unavailable("Select active members of the consuming organization");
      }
      for (const profile of config.profiles) {
        if ((terms.mode === "ledger_coordinated") !== !!profile.market)
          unavailable("Ledger-coordinated profiles require an automatic reservation policy");
        if (profile.market) {
          const [policy] = await tx
            .select()
            .from(federationReservationPolicies)
            .where(
              and(
                eq(federationReservationPolicies.id, profile.market.policyId),
                eq(federationReservationPolicies.localOrgId, actor.orgId),
                eq(federationReservationPolicies.localSiteId, this.siteId ?? ""),
                eq(federationReservationPolicies.agreementRevisionId, terms.agreementRevisionId),
              ),
            )
            .for("share");
          if (
            !policy ||
            policy.revokedAt ||
            !policy.allowActivation ||
            !policy.allowExecutionConfirmation
          )
            unavailable(
              "The automatic reservation policy is unavailable or lacks execution authorization",
            );
        }
        if (
          !terms.templates.some((template) => same(template, profile.template)) ||
          BigInt(profile.maxAmount) > BigInt(terms.maxTaskAmount)
        )
          unavailable(
            "Execution profile exceeds the signed agreement authorization or task allowance",
          );
        const inputs = await this.assets.readMaterial(
          tx,
          actor.orgId,
          this.siteId ?? "",
          profile.inputManifestDigest,
        );
        const env = await this.assets.readMaterial(
          tx,
          actor.orgId,
          this.siteId ?? "",
          profile.environmentLockDigest,
        );
        if (inputs.kind !== "inputs" || env.kind !== "environment-lock")
          unavailable("Execution materials have incorrect kinds");
      }
      const values = { config, updatedBy: actor.userId, updatedAt: this.clock() };
      const [row] = id
        ? await tx
            .update(federationClusterQueues)
            .set(values)
            .where(eq(federationClusterQueues.id, id))
            .returning()
        : await tx
            .insert(federationClusterQueues)
            .values({
              ...values,
              localSiteId: this.siteId ?? "",
              localOrgId: actor.orgId,
              createdBy: actor.userId,
            })
            .returning();
      if (!row) throw new Error("Federation queue was not saved");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.cluster.save",
        target: row.id,
        diff: { after: config },
      });
      return { id: row.id, config, updatedAt: row.updatedAt.toISOString() };
    });
  }

  async remove(actor: FederationActor, id: string) {
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "cluster.manage");
      const row = await loadClusterQueue(tx, this.siteId ?? "", id);
      if (!row || row.localOrgId !== actor.orgId) throw new FederationError("POLICY_DENIED");
      // Retain the identity so a disabled remote queue can never be rebound as a local one.
      await tx
        .update(federationClusterQueues)
        .set({
          config: { ...row.config, enabled: false },
          updatedBy: actor.userId,
          updatedAt: this.clock(),
        })
        .where(eq(federationClusterQueues.id, id));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.cluster.disable",
        target: id,
      });
    });
  }

  async listVisible(context: QueueAccessContext): Promise<QueueRegistryView[]> {
    if (!this.siteId || !context.userId || !context.orgId) return [];
    const actor = { userId: context.userId, orgId: context.orgId };
    return this.db.transaction(async (tx) => {
      try {
        await requireFederationCapability(tx, actor, ["cluster.use", "delegation.submit"]);
      } catch (error) {
        if (error instanceof FederationError && error.code === "POLICY_DENIED") return [];
        throw error;
      }
      const rows = await tx
        .select()
        .from(federationClusterQueues)
        .where(
          and(
            eq(federationClusterQueues.localSiteId, this.siteId ?? ""),
            eq(federationClusterQueues.localOrgId, actor.orgId),
          ),
        );
      const visible: QueueRegistryView[] = [];
      for (const row of rows) {
        if (!clusterQueueAllows(row.config, actor)) continue;
        let terms: FederationAgreement;
        try {
          terms = await this.terms(tx, actor.orgId, row.config.agreementRevisionId);
        } catch (error) {
          if (error instanceof FederationError) continue;
          throw error;
        }
        const [site] = await tx
          .select()
          .from(federationSites)
          .where(eq(federationSites.id, terms.targetSiteId));
        if (site?.state !== "active") continue;
        visible.push({
          queueId: row.id,
          name: row.config.clusterName,
          clusterName: row.config.clusterName,
          providerOrgId: actor.orgId,
          visibleOrgIds: [actor.orgId],
          agentId: "federation",
          schedulerType: row.config.schedulerType,
          queueName: row.config.queueName,
          target: { mode: "named" },
          qos: null,
          enabled: true,
          policyTags: [],
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          federation: { partnerName: row.config.showPartnerLabel ? site.name : null },
          submitEligibility: { state: "ready", reason: null, retryable: false },
        });
      }
      return visible;
    });
  }

  async selected(
    actor: FederationActor,
    queueId: string,
  ): Promise<{ row: Row; terms: FederationAgreement } | null> {
    if (!this.siteId || !/^[0-9a-f-]{36}$/i.test(queueId)) return null;
    return this.db.transaction(async (tx) => {
      const row = await loadClusterQueue(tx, this.siteId ?? "", queueId);
      if (!row) return null;
      await requireFederationCapability(tx, actor, ["cluster.use", "delegation.submit"]);
      if (!clusterQueueAllows(row.config, actor)) throw new FederationError("POLICY_DENIED");
      return { row, terms: await this.terms(tx, actor.orgId, row.config.agreementRevisionId) };
    });
  }

  private node(
    row: Row,
    terms: FederationAgreement,
    profile: FederationClusterProfile,
    original: Pick<RemoteNode, "id" | "name" | "inputSlots" | "when" | "description">,
    resources: RemoteNode["resources"],
  ): RemoteNode {
    if (
      Object.keys(resources).some(
        (key) =>
          resources[key as keyof typeof resources] >
          terms.resourceLimit[key as keyof typeof resources],
      )
    )
      unavailable("Requested resources exceed the cooperation agreement limit");

    return {
      ...original,
      type: "Federation",
      agreementRevisionId: terms.agreementRevisionId,
      executionTarget: row.config.executionTarget,
      managedPlacement: { queueId: row.id, profileId: profile.id },
      template: profile.template,
      inputManifestDigest: profile.inputManifestDigest,
      environmentLockDigest: profile.environmentLockDigest,
      ...(profile.market ? { market: profile.market } : {}),
      maxAmount: profile.maxAmount,
      resources,
      admissionWindowSec: 600,
      executionExpiresAt: terms.validUntil,
      outputs: profile.outputs,
    };
  }

  async prepareJob(actor: FederationActor, data: JobSubmit): Promise<RemoteNode | null> {
    const queueId = data.schedulingStrategy?.queueId;
    if (!queueId) {
      for (const id of data.schedulingStrategy?.preferredQueueIds ?? [])
        if (await this.selected(actor, id))
          unavailable(
            "Choose a federation queue explicitly; remote execution cannot fall back locally",
          );
      return null;
    }
    const selected = await this.selected(actor, queueId);
    if (!selected) return null;
    const { row, terms } = selected;
    const profile = row.config.profiles.find((p) =>
      data.usecasePackageId
        ? p.source.kind === "usecase" && p.source.packageId === data.usecasePackageId
        : p.source.kind === "command",
    );
    if (!profile)
      unavailable("No authorized execution profile exists for this job on the selected cluster");
    if (profile.source.kind === "usecase") {
      const [source] = await this.db
        .select()
        .from(usecasePackages)
        .where(eq(usecasePackages.id, data.usecasePackageId ?? ""));
      if (!source || source.specDigest !== profile.source.packageDigest)
        unavailable(
          "The usecase package has changed; update its approved remote execution mapping",
        );
    }
    if (
      data.workingDir ||
      Object.keys(data.envVars ?? {}).length ||
      data.stdinText ||
      data.licensedMaterials?.length ||
      Object.keys(data.dataInputs ?? {}).length
    )
      unavailable(
        "Remote jobs require portable declared inputs; host paths, environment overrides and local license mounts cannot be delegated",
      );
    if (!data.usecasePackageId && (data.softwareRequirements?.length || data.inputStaging?.length))
      unavailable(
        "Use a mapped software usecase with a pinned environment for remote software and file inputs",
      );
    const inputs: workflowDsl.NodeInputSlot[] = [];
    if (profile.source.kind === "command") {
      inputs.push({
        descriptor: profile.source.commandParameter,
        type: "Text",
        from: { param: "command" },
        optional: false,
      });
    } else {
      for (const [descriptor, value] of Object.entries(data.usecaseInputs ?? {})) {
        if (typeof value === "string")
          inputs.push({ descriptor, type: "Text", from: { param: descriptor }, optional: false });
        else {
          const contents = await Promise.all(
            (Array.isArray(value) ? value : [value]).map(async (file) => {
              const [row] = await this.db
                .select()
                .from(netdriveFiles)
                .where(
                  and(
                    eq(netdriveFiles.id, file.fileMetadataId),
                    eq(netdriveFiles.ownerId, actor.userId),
                    isNull(netdriveFiles.deletedAt),
                  ),
                );
              if (!row) throw new FederationError("POLICY_DENIED");
              return {
                fileMetadataId: row.id,
                fileMetadataName: file.fileMetadataName,
                hash: row.sha256,
                size: row.size,
              };
            }),
          );
          inputs.push({
            descriptor,
            type: "File",
            isBatch: Array.isArray(value),
            contents,
            optional: false,
          });
        }
      }
    }
    if (data.softwareRequirements?.length) {
      const environment = await this.db.transaction((tx) =>
        this.assets.readMaterial(tx, actor.orgId, this.siteId ?? "", profile.environmentLockDigest),
      );
      if (environment.kind !== "environment-lock") throw new FederationError("POLICY_DENIED");
      const locked = await Promise.all(
        environment.software.map(async (entry) => ({
          entry,
          resolved: await this.assets.resolve(actor, entry.asset),
        })),
      );
      for (const requirement of data.softwareRequirements) {
        if (
          !locked.some(
            ({ entry, resolved }) =>
              resolved.local.kind === "software" &&
              resolved.local.asset.name === requirement.name &&
              (!requirement.version || resolved.local.asset.version === requirement.version) &&
              (!requirement.assetId || resolved.local.asset.id === requirement.assetId) &&
              (!requirement.spec || entry.concreteSpec === requirement.spec),
          )
        )
          unavailable(
            "A requested software requirement is absent from the approved remote environment lock",
          );
      }
    }
    const expected = data.expectedOutputs ?? [];
    if (
      expected.some(
        (output) =>
          !profile.outputs.some(
            (mapped) =>
              mapped.descriptor === output.descriptor &&
              (mapped.type === "FileBatch") === output.isBatch,
          ),
      )
    )
      unavailable("Declared job outputs are not mapped by this execution profile");
    return this.node(
      row,
      terms,
      profile,
      { id: "compute", name: data.name, inputSlots: inputs },
      {
        ...data.resources,
        gpus: data.resources.gpus ?? 0,
        wallTimeSec: data.resources.wallTimeSec ?? terms.resourceLimit.wallTimeSec,
      },
    );
  }

  async previewJob(actor: FederationActor, data: JobSubmit): Promise<PlacementTrace | null> {
    const node = await this.prepareJob(actor, data);
    if (!node?.managedPlacement) return null;
    const placement = node.managedPlacement;
    const selected = await this.selected(actor, placement.queueId);
    if (!selected) throw new FederationError("POLICY_DENIED");
    const profile = selected.row.config.profiles.find((p) => p.id === placement.profileId);
    if (!profile) throw new FederationError("POLICY_DENIED");
    return {
      generatedAt: this.clock().toISOString(),
      preview: true,
      candidateCount: 0,
      stages: [],
      finalDecision: null,
      federation: {
        queueId: placement.queueId,
        clusterName: selected.row.config.clusterName,
        profileName: profile.name,
      },
    };
  }

  async prepareWorkflow(
    workflow: workflowDsl.Workflow,
    principal?: BoundPrincipal,
    placement?: WorkflowPlacementConfig,
  ): Promise<workflowDsl.Workflow> {
    if (!principal?.userId || !principal.orgId) return workflow;
    const actor = { userId: principal.userId, orgId: principal.orgId };
    const prepare = async (spec: workflowDsl.WorkflowSpec): Promise<workflowDsl.WorkflowSpec> => ({
      ...spec,
      nodeDrafts: await Promise.all(
        spec.nodeDrafts.map(async (node) => {
          if (node.type === "Loop") return { ...node, body: await prepare(node.body) };
          if (node.type === "SubWorkflow" && node.ref.kind === "Inline")
            return {
              ...node,
              ref: { kind: "Inline" as const, body: await prepare(node.ref.body) },
            };
          if (node.type !== "Script" && node.type !== "SoftwareUsecaseComputing") return node;
          const strategy = node.schedulingStrategy;
          if (!strategy || strategy.type === "Auto") return node;
          const matches = await Promise.all(strategy.queues.map((id) => this.selected(actor, id)));
          const remote = matches.filter((v) => v !== null);
          if (!remote.length) return node;
          if (strategy.type !== "Manual" || matches.length !== 1)
            unavailable(
              "Select one required federation queue; remote execution cannot fall back locally",
            );
          const selected = remote[0];
          if (!selected) throw new Error("Remote queue selection was lost");
          const constraint =
            (node.type === "Script" ? node.placementConstraint : undefined) ??
            placement?.nodeConstraints[node.id] ??
            placement?.runConstraint;
          if (
            constraint &&
            (constraint.dataMovement === "Forbid" ||
              (constraint.mode === "Require" &&
                ((constraint.clusterIds.length &&
                  !constraint.clusterIds.includes(selected.row.config.executionTarget.clusterId)) ||
                  (constraint.siteIds.length &&
                    !constraint.siteIds.includes(selected.terms.targetSiteId)))))
          )
            unavailable(
              "Remote cluster conflicts with the workflow placement or data movement constraints",
            );
          if (
            node.requirements?.maxCpuTime != null ||
            node.requirements?.stopTime != null ||
            (node.requirements?.nodeCount ?? 1) > 1
          )
            unavailable(
              "Map multi-node or absolute-time execution requirements in the remote template",
            );
          if (node.type === "Script" && node.executionIdentity.type !== "Inherit")
            unavailable(
              "Remote execution uses the receiving organization's authorized execution identity",
            );
          const revisionId =
            node.type === "SoftwareUsecaseComputing"
              ? node.usecaseVersionId
              : node.source?.type === "AssetRevision"
                ? node.source.assetRevisionId
                : undefined;
          const kind = node.type === "Script" ? "script" : "usecase";
          const profile = selected.row.config.profiles.find(
            (p) => p.source.kind === kind && p.source.revisionId === revisionId,
          );
          if (!profile)
            unavailable("The selected cluster has no authorized mapping for this node revision");
          if (
            node.type === "Script" &&
            Object.entries(node.outputs).some(
              ([descriptor, output]) =>
                !["File", "FileBatch"].includes(output.type) ||
                output.locality.type !== "Auto" ||
                output.durability !== "Ephemeral" ||
                output.validator != null ||
                !profile.outputs.some(
                  (mapped) => mapped.descriptor === descriptor && mapped.type === output.type,
                ),
            )
          )
            unavailable(
              "Remote script outputs require portable file mappings without local storage policies",
            );
          if (
            node.outputSlots?.some(
              (output) =>
                output.type !== "File" ||
                !profile.outputs.some(
                  (mapped) =>
                    mapped.descriptor === output.descriptor &&
                    (mapped.type === "FileBatch") === output.isBatch,
                ),
            )
          )
            unavailable("Remote outputs must have explicit portable file mappings");
          return this.node(
            selected.row,
            selected.terms,
            profile,
            {
              id: node.id,
              name: node.name,
              when: node.when,
              description: node.description,
              inputSlots: node.inputSlots,
            },
            {
              ...selected.terms.resourceLimit,
              cpus: node.requirements?.cpuCores ?? selected.terms.resourceLimit.cpus,
              wallTimeSec:
                node.requirements?.maxWallTime ?? selected.terms.resourceLimit.wallTimeSec,
            },
          );
        }),
      ),
    });
    return { ...workflow, spec: await prepare(workflow.spec) };
  }
}

import { type PgDb, softwareAssetRevisions, softwareAssets } from "@kuintessence/db";
import { SoftwareAssetPayloadSchema, usecase, type workflowDsl } from "@kuintessence/shared";
import { and, desc, eq } from "drizzle-orm";
import type { BoundPrincipal } from "../middleware/principal-binder";

export interface NamedReferenceAsset {
  id: string;
  kind: "usecase" | "spack-package" | "sandbox-script";
  source: string;
  name: string;
  version: string;
  providerOrgId: string | null;
  lifecycle: string;
  visibility: string;
  payload: Record<string, unknown>;
}

export interface NamedReferenceRevision {
  id: string;
  assetId: string;
  revision: number;
  payload: Record<string, unknown>;
}

export interface WorkflowNamedReferenceRepository {
  findAssets(
    kind: NamedReferenceAsset["kind"],
    selector: workflowDsl.AssetSelector,
  ): Promise<NamedReferenceAsset[]>;
  findLatestRevision(assetId: string): Promise<NamedReferenceRevision | null>;
}

export interface WorkflowNamedReferenceAuthorizer {
  assertUse(assetId: string, principal: BoundPrincipal): Promise<void>;
}

export class PgWorkflowNamedReferenceRepository implements WorkflowNamedReferenceRepository {
  constructor(private readonly db: PgDb) {}

  async findAssets(
    kind: NamedReferenceAsset["kind"],
    selector: workflowDsl.AssetSelector,
  ): Promise<NamedReferenceAsset[]> {
    const conditions = [
      eq(softwareAssets.kind, kind),
      eq(softwareAssets.source, selector.source),
      eq(softwareAssets.name, selector.name),
      eq(softwareAssets.version, selector.version),
      eq(softwareAssets.lifecycle, "published"),
    ];
    if (selector.providerOrgId) {
      conditions.push(eq(softwareAssets.providerOrgId, selector.providerOrgId));
    }
    const rows = await this.db
      .select()
      .from(softwareAssets)
      .where(and(...conditions))
      .limit(2);
    return rows as NamedReferenceAsset[];
  }

  async findLatestRevision(assetId: string): Promise<NamedReferenceRevision | null> {
    const [row] = await this.db
      .select()
      .from(softwareAssetRevisions)
      .where(eq(softwareAssetRevisions.assetId, assetId))
      .orderBy(desc(softwareAssetRevisions.revision))
      .limit(1);
    return row ?? null;
  }
}

/** Resolves logical ecosystem selectors before a workflow is persisted or run. */
export class WorkflowNamedReferenceResolver {
  constructor(
    private readonly repository: WorkflowNamedReferenceRepository,
    private readonly authorizer: WorkflowNamedReferenceAuthorizer,
  ) {}

  async resolve(
    workflow: workflowDsl.Workflow,
    principal?: BoundPrincipal,
  ): Promise<workflowDsl.Workflow> {
    return { ...workflow, spec: await this.resolveSpec(workflow.spec, principal) };
  }

  private async resolveSpec(
    spec: workflowDsl.WorkflowSpec,
    principal: BoundPrincipal | undefined,
  ): Promise<workflowDsl.WorkflowSpec> {
    return {
      ...spec,
      nodeDrafts: await Promise.all(
        spec.nodeDrafts.map((node) => this.resolveNode(node, principal)),
      ),
    };
  }

  private async resolveNode(
    node: workflowDsl.WorkflowNode,
    principal: BoundPrincipal | undefined,
  ): Promise<workflowDsl.WorkflowNode> {
    if (node.type === "SoftwareUsecaseComputing" && node.usecaseRef && node.softwareRef) {
      const canonicalPrincipal = requireCanonicalPrincipal(principal);
      const [usecaseAsset, softwareAsset] = await Promise.all([
        this.resolveAsset("usecase", node.usecaseRef),
        this.resolveAsset("spack-package", node.softwareRef),
      ]);
      await Promise.all([
        this.authorizer.assertUse(usecaseAsset.id, canonicalPrincipal),
        this.authorizer.assertUse(softwareAsset.id, canonicalPrincipal),
      ]);
      const [usecaseRevision, softwareRevision] = await Promise.all([
        this.resolveLatestRevision(usecaseAsset.id),
        this.resolveLatestRevision(softwareAsset.id),
      ]);
      const payload = SoftwareAssetPayloadSchema.parse(usecaseRevision.payload);
      if (payload.kind !== "usecase")
        throw new Error("Named usecase asset has an invalid revision");
      const usecasePackage = usecase.GovernedUsecasePackageSchema.parse(payload.spec);
      if (!sameSelector(usecasePackage.softwareRef, node.softwareRef)) {
        throw new Error("Named usecase softwareRef does not match the node softwareRef");
      }
      const { usecaseRef: _usecaseRef, softwareRef: _softwareRef, ...nodeFields } = node;
      return {
        ...nodeFields,
        usecaseVersionId: usecaseRevision.id,
        softwareVersionId: softwareRevision.id,
        frozenAssetRevisions: {
          usecase: frozenReference(usecaseAsset, usecaseRevision),
          software: frozenReference(softwareAsset, softwareRevision),
        },
      };
    }
    if (node.type === "Script" && node.scriptRef && node.runtimeContractRef) {
      const canonicalPrincipal = requireCanonicalPrincipal(principal);
      const scriptAsset = await this.resolveAsset("sandbox-script", node.scriptRef);
      await this.authorizer.assertUse(scriptAsset.id, canonicalPrincipal);
      const revision = await this.resolveLatestRevision(scriptAsset.id);
      const payload = SoftwareAssetPayloadSchema.parse(revision.payload);
      if (payload.kind !== "sandbox-script")
        throw new Error("Named script is not a Sandbox script");
      if (
        !payload.runtimeContractRef ||
        payload.runtimeContractRef.name !== node.runtimeContractRef.name ||
        payload.runtimeContractRef.version !== node.runtimeContractRef.version
      ) {
        throw new Error("Named script runtime contract does not match the pinned script revision");
      }
      const {
        scriptRef: _scriptRef,
        runtimeContractRef: _runtimeContractRef,
        ...nodeFields
      } = node;
      return {
        ...nodeFields,
        source: {
          type: "AssetRevision",
          assetId: scriptAsset.id,
          assetRevisionId: revision.id,
          revision: revision.revision,
          sha256: payload.sha256,
        },
        runtimeContractRef: node.runtimeContractRef,
      };
    }
    if (node.type === "Loop") {
      return { ...node, body: await this.resolveSpec(node.body, principal) };
    }
    if (node.type === "SubWorkflow" && node.ref.kind === "Inline") {
      return {
        ...node,
        ref: { ...node.ref, body: await this.resolveSpec(node.ref.body, principal) },
      };
    }
    return node;
  }

  private async resolveAsset(
    kind: NamedReferenceAsset["kind"],
    selector: workflowDsl.AssetSelector,
  ): Promise<NamedReferenceAsset> {
    const rows = (await this.repository.findAssets(kind, selector)).filter(
      (asset) => asset.lifecycle === "published",
    );
    if (rows.length !== 1 || !rows[0]) {
      throw new Error(`Named ${kind} selector must resolve to exactly one asset`);
    }
    return rows[0];
  }

  private async resolveLatestRevision(assetId: string): Promise<NamedReferenceRevision> {
    const row = await this.repository.findLatestRevision(assetId);
    if (!row) throw new Error("Named Sandbox script has no immutable revision");
    return row;
  }
}

function frozenReference(asset: NamedReferenceAsset, revision: NamedReferenceRevision) {
  return { assetId: asset.id, revisionId: revision.id, revision: revision.revision };
}

function sameSelector(a: workflowDsl.AssetSelector, b: workflowDsl.AssetSelector): boolean {
  return (
    a.source === b.source &&
    a.name === b.name &&
    a.version === b.version &&
    (a.providerOrgId ?? null) === (b.providerOrgId ?? null)
  );
}

function requireCanonicalPrincipal(principal: BoundPrincipal | undefined): BoundPrincipal {
  if (!principal?.userId) {
    throw new Error("Named workflow references require a canonical principal");
  }
  return principal;
}

import {
  ecosystemReleaseAssets,
  type PgDb,
  softwareAssetRevisions,
  softwareAssets,
} from "@kuintessence/db";
import { SoftwareAssetPayloadSchema, usecase, workflowDsl } from "@kuintessence/shared";
import { and, desc, eq, notExists } from "drizzle-orm";
import type { BoundPrincipal } from "../middleware/principal-binder";
import {
  activeSoftwareReleaseRevision,
  type ReleaseBoundSoftwareKind,
  releaseBoundSoftwareKind,
} from "../services/site-runtime";

export interface NamedReferenceAsset {
  id: string;
  kind: "usecase" | "site-runtime" | "spack-package" | "sandbox-script";
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
  findLatestRevision(
    asset: Pick<NamedReferenceAsset, "id" | "name" | "version">,
    signedKind?: ReleaseBoundSoftwareKind,
    allowIndependent?: boolean,
  ): Promise<NamedReferenceRevision | null>;
}

export interface WorkflowNamedReferenceAuthorizer {
  assertUse(assetId: string, principal: BoundPrincipal): Promise<void>;
}

export class PgWorkflowNamedReferenceRepository implements WorkflowNamedReferenceRepository {
  constructor(
    private readonly db: PgDb,
    private readonly trustedKeys: Readonly<Record<string, string>> = {},
  ) {}

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

  async findLatestRevision(
    asset: Pick<NamedReferenceAsset, "id" | "name" | "version">,
    signedKind?: ReleaseBoundSoftwareKind,
    allowIndependent = signedKind === "sandbox-script" || signedKind === "usecase",
  ): Promise<NamedReferenceRevision | null> {
    if (signedKind) {
      const active = await activeSoftwareReleaseRevision(
        this.db,
        asset.id,
        signedKind,
        this.trustedKeys,
      );
      if (active) {
        if (active.name !== asset.name || active.version !== asset.version) return null;
        return {
          id: active.revisionId,
          assetId: asset.id,
          revision: active.revision,
          payload: active.payload,
        };
      }
      if (!allowIndependent) return null;
    }
    // An independent publication may use its latest revision only if no release binds the asset.
    const [row] = await this.db
      .select()
      .from(softwareAssetRevisions)
      .where(
        and(
          eq(softwareAssetRevisions.assetId, asset.id),
          signedKind && allowIndependent
            ? notExists(
                this.db
                  .select({ id: ecosystemReleaseAssets.id })
                  .from(ecosystemReleaseAssets)
                  .where(eq(ecosystemReleaseAssets.assetId, asset.id)),
              )
            : undefined,
        ),
      )
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
    if (node.type === "Reduce") {
      const leaf = workflowDsl.commandExecutionNode(node);
      if (
        (leaf?.type === "Script" && leaf.scriptRef) ||
        (leaf?.type === "SoftwareUsecaseComputing" && leaf.usecaseRef)
      ) {
        const reducer = workflowDsl.boundCommandReducer(await this.resolveNode(leaf, principal));
        if (!reducer) throw new Error("Named Command executor did not resolve to a revision");
        return { ...node, reducer };
      }
      return node;
    }
    if (node.type === "SoftwareUsecaseComputing" && node.usecaseRef && node.softwareRef) {
      const canonicalPrincipal = requireCanonicalPrincipal(principal);
      const usecaseAsset = await this.resolveAsset("usecase", node.usecaseRef);
      await this.authorizer.assertUse(usecaseAsset.id, canonicalPrincipal);
      const usecaseRevision = await this.resolveLatestRevision(
        usecaseAsset,
        usecaseAsset.source === "platform-fork" ? "usecase" : undefined,
      );
      const payload = SoftwareAssetPayloadSchema.parse(usecaseRevision.payload);
      if (payload.kind !== "usecase")
        throw new Error("Named usecase asset has an invalid revision");
      const usecasePackage = usecase.GovernedUsecasePackageSchema.parse(payload.spec);
      if (!sameSelector(usecasePackage.softwareRef, node.softwareRef)) {
        throw new Error("Named usecase softwareRef does not match the node softwareRef");
      }
      const softwareAsset = await this.resolveAsset(
        usecasePackage.software.kind === "Spack" ? "spack-package" : "site-runtime",
        node.softwareRef,
      );
      await this.authorizer.assertUse(softwareAsset.id, canonicalPrincipal);
      const requiredKind = releaseBoundSoftwareKind(
        softwareAsset.kind,
        softwareAsset.name,
        softwareAsset.payload,
      );
      const ordinaryPlatformSpack =
        !requiredKind &&
        softwareAsset.kind === "spack-package" &&
        softwareAsset.source === "platform-fork";
      const softwareRevision = await this.resolveLatestRevision(
        softwareAsset,
        requiredKind ?? (ordinaryPlatformSpack ? "spack-package" : undefined),
        ordinaryPlatformSpack,
      );
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
      const revision = await this.resolveLatestRevision(
        scriptAsset,
        scriptAsset.source === "platform-fork" ? "sandbox-script" : undefined,
      );
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

  private async resolveLatestRevision(
    asset: Pick<NamedReferenceAsset, "id" | "name" | "version">,
    signedKind?: ReleaseBoundSoftwareKind,
    allowIndependent?: boolean,
  ): Promise<NamedReferenceRevision> {
    const row = await this.repository.findLatestRevision(asset, signedKind, allowIndependent);
    if (!row) throw new Error("Named asset has no immutable revision");
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

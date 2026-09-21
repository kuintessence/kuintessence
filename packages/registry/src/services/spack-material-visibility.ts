import {
  SpackMaterialLifecycleError,
  type SpackMaterialLifecyclePrincipal,
  type SpackMaterialVisibility,
  SpackMaterialVisibilityError,
} from "@kuintessence/db";
import {
  type RecipeRepository,
  type RegistryRole,
  RegistryRoleSchema,
  type SpackMaterialBinding,
  type SpackMaterialManifest,
  type SpackMaterialPublish,
  SpackMaterialVisibilityChangeSchema,
} from "@kuintessence/shared";
import {
  checkNamespaceAccess,
  NamespacePermissionError,
  parseNamespace,
  type RbacPrincipal,
} from "./namespace";
import { RecipeStoreError } from "./recipe-git";
import type { RecipeGitStore } from "./recipe-git-store";
import { SpackMaterialError, SpackMaterialWithdrawnError } from "./spack-material-storage";
import type { MaterialRecipeStore, SpackMaterialStore } from "./spack-material-store";

export type SpackMaterialVisibilityPort = Pick<
  SpackMaterialVisibility,
  "assertReadable" | "inspect" | "transition"
>;
type Change = Parameters<SpackMaterialVisibilityPort["transition"]>[2];
type Snapshot = Awaited<ReturnType<RecipeGitStore["getSnapshot"]>>;
type ReadManifest = SpackMaterialStore["getManifest"];

/** Disk work stays outside canonical DB locks and retains admission until I/O settles. */
export class SpackMaterialVisibilityAccess {
  private active = 0;

  constructor(
    private readonly port: SpackMaterialVisibilityPort,
    private readonly recipes: MaterialRecipeStore,
    private readonly read: ReadManifest,
  ) {}

  async assertReadable(
    binding: SpackMaterialBinding,
    manifest: SpackMaterialManifest,
    subject: string,
    checkpoint?: () => void,
  ): Promise<void> {
    try {
      await this.bounded(checkpoint, async (check) => {
        const snapshots = await this.loadSnapshots(manifest, check);
        await this.port.assertReadable(
          binding,
          subject,
          async (principal) => this.authorize(manifest, snapshots, principal, check),
          check,
        );
        check();
      });
    } catch (error) {
      if (
        error instanceof SpackMaterialLifecycleError &&
        error.code === "MATERIAL_RELEASE_WITHDRAWN"
      ) {
        throw new SpackMaterialWithdrawnError();
      }
      if (
        (error instanceof SpackMaterialLifecycleError &&
          (error.status === 403 || error.status === 404)) ||
        ((error instanceof SpackMaterialError || error instanceof RecipeStoreError) &&
          (error.status === 403 || error.status === 404))
      ) {
        throw new SpackMaterialError(404, "Material release not found");
      }
      throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
    }
  }

  async manage(
    binding: SpackMaterialBinding,
    subject: string,
    change?: Change,
    publisherRoles?: RegistryRole[],
    signal?: AbortSignal,
  ) {
    const parsed =
      change === undefined ? undefined : SpackMaterialVisibilityChangeSchema.safeParse(change);
    if (parsed && !parsed.success) {
      throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_INVALID");
    }
    const input = parsed?.data;
    const roles = publisherRoles === undefined ? undefined : [...publisherRoles];
    try {
      return await this.bounded(() => signal?.throwIfAborted(), async (check) => {
        const { manifest } = await this.read(binding.repositoryId, binding.manifestDigest, {
          checkpoint: check,
        });
        const snapshots = await this.loadSnapshots(manifest, check);
        const authorize = async (principal: SpackMaterialLifecyclePrincipal) =>
          this.authorize(manifest, snapshots, principal, check, { publisherRoles: roles });
        check();
        const status = await (input
          ? this.port.transition(binding, subject, input, authorize)
          : this.port.inspect(binding, subject, authorize));
        check();
        return { ...status, binding, repository: manifest.repository };
      });
    } catch (error) {
      if (error instanceof SpackMaterialVisibilityError) throw error;
      if (
        (error instanceof SpackMaterialError || error instanceof RecipeStoreError) &&
        (error.status === 403 || error.status === 404)
      ) {
        throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_FORBIDDEN");
      }
      throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
    }
  }

  private async bounded<T>(
    checkpoint: (() => void) | undefined,
    work: (check: () => void) => Promise<T>,
  ): Promise<T> {
    if (!this.recipes.getSnapshot || this.active >= 2) {
      throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
    }
    const deadline = Date.now() + 10_000;
    const check = () => {
      try {
        checkpoint?.();
      } catch {
        throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
      }
      if (Date.now() >= deadline) {
        throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
      }
    };
    this.active++;
    try {
      check();
      return await work(check);
    } finally {
      this.active--;
    }
  }

  private async loadSnapshots(manifest: SpackMaterialManifest, check: () => void) {
    const getSnapshot = this.recipes.getSnapshot?.bind(this.recipes);
    if (!getSnapshot) throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
    const snapshots = new Map<string, Snapshot>();
    for (const selection of manifest.recipes) {
      check();
      const key = `${selection.repositoryId}/${selection.commit}`;
      if (snapshots.has(key)) continue;
      if (snapshots.size >= 32) {
        throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
      }
      snapshots.set(key, await getSnapshot(selection.repositoryId, selection.commit, check));
    }
    check();
    return snapshots;
  }

  private authorize(
    manifest: SpackMaterialManifest,
    snapshots: Map<string, Snapshot>,
    principal: SpackMaterialLifecyclePrincipal,
    check: () => void,
    management?: { publisherRoles?: RegistryRole[] },
  ) {
    check();
    const actor = { ...principal, role: RegistryRoleSchema.parse(principal.role) };
    assertMaterialNamespaceReadable(actor, manifest.repository);
    if (management) {
      checkNamespaceAccess(
        actor,
        parseNamespace(manifest.repository),
        "write",
        management.publisherRoles,
      );
    }
    for (const selection of manifest.recipes) {
      check();
      const recipe = snapshots.get(`${selection.repositoryId}/${selection.commit}`);
      if (!recipe) throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
      authorizeMaterialRecipe(manifest.repository, selection, actor, {
        repository: recipe.repository,
        snapshots: [recipe.snapshot],
      });
    }
    check();
  }
}

export function authorizeMaterialRecipe(
  repository: string,
  selection: SpackMaterialPublish["recipes"][number],
  actor: RbacPrincipal,
  recipe: Pick<RecipeRepository, "repository" | "snapshots">,
) {
  assertMaterialNamespaceReadable(actor, recipe.repository);
  const source = parseNamespace(recipe.repository);
  const target = parseNamespace(repository);
  if (source.kind !== "public" && (source.kind !== target.kind || source.owner !== target.owner)) {
    throw new SpackMaterialError(403, "Material release cannot broaden recipe visibility");
  }
  const snapshot = recipe.snapshots.find((item) => item.commit === selection.commit);
  if (!snapshot) throw new SpackMaterialError(404, "Recipe snapshot not found");
  if (
    snapshot.validation !== "static-only" ||
    snapshot.diagnostics.some((item) => item.severity === "error") ||
    new Set(selection.roots).size !== selection.roots.length ||
    selection.roots.some((root) => !snapshot.roots.some((item) => item.path === root))
  ) {
    throw new SpackMaterialError(422, "Recipe selection contains unverified roots or diagnostics");
  }
}

export function assertMaterialNamespaceReadable(actor: RbacPrincipal, repository: string): void {
  try {
    checkNamespaceAccess(actor, parseNamespace(repository), "read");
  } catch (error) {
    if (error instanceof NamespacePermissionError) {
      throw new SpackMaterialError(404, "Material release or referenced recipe not found");
    }
    throw error;
  }
}

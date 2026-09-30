import { type SpackInstallBindings, SpackMaterialLifecycleError } from "@kuintessence/db";
import {
  RegistryRoleSchema,
  type SpackInstallBindingChange,
  SpackInstallBindingChangeSchema,
  type SpackInstallBindingQuery,
  SpackInstallBindingQuerySchema,
} from "@kuintessence/shared";
import type { RecipeGitStore } from "./recipe-git-store";
import { parseMaterial, type SpackMaterialStore } from "./spack-material-store";
import {
  assertMaterialNamespaceReadable,
  authorizeMaterialRecipe,
} from "./spack-material-visibility";

type Port = Pick<SpackInstallBindings, "inspect" | "transition">;
type Snapshot = Awaited<ReturnType<RecipeGitStore["getSnapshot"]>>;

export class SpackInstallBindingAccess {
  private active = 0;

  constructor(
    private readonly port: Port,
    private readonly store: Pick<SpackMaterialStore, "getManifest">,
    private readonly recipes: Pick<RecipeGitStore, "getSnapshot">,
  ) {}

  inspect(query: SpackInstallBindingQuery, subject: string) {
    return this.port.inspect(
      parseMaterial(SpackInstallBindingQuerySchema, query, "install binding query"),
      subject,
    );
  }

  async change(input: SpackInstallBindingChange, subject: string, signal?: AbortSignal) {
    const change = parseMaterial(SpackInstallBindingChangeSchema, input, "install binding change");
    if (this.active >= 2) throw new SpackMaterialLifecycleError("INSTALL_BINDING_UNAVAILABLE");
    const deadline = Date.now() + 10_000;
    const check = () => {
      if (signal?.aborted || Date.now() >= deadline) {
        throw new SpackMaterialLifecycleError("INSTALL_BINDING_UNAVAILABLE");
      }
    };
    this.active++;
    try {
      check();
      // Reject a foreign scope before touching material or recipe files.
      await this.port.inspect({ scope: change.scope, spec: change.spec }, subject);
      check();
      if (change.action === "disable") {
        return await this.port.transition(change, subject, async () => check());
      }
      const { manifest } = await this.store.getManifest(
        change.binding.repositoryId,
        change.binding.manifestDigest,
        { checkpoint: check },
      );
      const [kind, owner] = manifest.repository.split("/");
      if (
        manifest.spec !== change.spec ||
        !(
          kind === "public" ||
          (change.scope !== "platform" && kind === "org" && owner === change.scope)
        )
      ) {
        throw new SpackMaterialLifecycleError("INSTALL_BINDING_INVALID");
      }
      const snapshots = new Map<string, Snapshot>();
      for (const selection of manifest.recipes) {
        check();
        const key = `${selection.repositoryId}/${selection.commit}`;
        if (snapshots.has(key)) continue;
        if (snapshots.size >= 32) {
          throw new SpackMaterialLifecycleError("INSTALL_BINDING_UNAVAILABLE");
        }
        snapshots.set(
          key,
          await this.recipes.getSnapshot(selection.repositoryId, selection.commit, check),
        );
      }
      check();
      return await this.port.transition(change, subject, async (principal) => {
        check();
        // Disk snapshots are immutable; live identities are locked and reread by the DB port.
        const actor = { ...principal, role: RegistryRoleSchema.parse(principal.role) };
        assertMaterialNamespaceReadable(actor, manifest.repository);
        for (const selection of manifest.recipes) {
          const snapshot = snapshots.get(`${selection.repositoryId}/${selection.commit}`);
          if (!snapshot) throw new SpackMaterialLifecycleError("INSTALL_BINDING_UNAVAILABLE");
          authorizeMaterialRecipe(manifest.repository, selection, actor, {
            repository: snapshot.repository,
            snapshots: [snapshot.snapshot],
          });
        }
        check();
      });
    } finally {
      this.active--;
    }
  }
}

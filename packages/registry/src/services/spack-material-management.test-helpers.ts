import { mock } from "bun:test";
import {
  type SpackMaterialCatalogState,
  SpackMaterialLifecycleError,
} from "@kuintessence/db";
import type { SpackMaterialBinding } from "@kuintessence/shared";
import { materialApp, materialFixture } from "../routes/spack-materials.test-helpers";
import { PLATFORM, repository, SUPER } from "../routes/spack-repositories.test-helpers";
import type { RbacPrincipal } from "./namespace";
import { materialDigest } from "./spack-material-storage";
import { type SpackMaterialLifecyclePort, SpackMaterialStore } from "./spack-material-store";

export const CURSOR_SECRET = "management-cursor-test-only-key-00000000";
export const ACTOR: RbacPrincipal = {
  ...PLATFORM,
  sub: "55555555-5555-4555-8555-555555555555",
};
export const QUERY = { repository: "public/materials", state: "all", limit: 10 } as const;

export async function managementFixture(count = 1, name: string = QUERY.repository) {
  const f = await materialFixture({}, repository("public/recipes"));
  await f.seed(name);
  const bindings: SpackMaterialBinding[] = [];
  for (let index = 0; index < count; index++) {
    bindings.push(
      await f.store.publish(
        {
          ...f.input,
          repository: name,
          sources: f.input.sources.map((source) => ({ ...source, path: `source-${index}.tgz` })),
        },
        SUPER,
      ),
    );
  }
  bindings.sort((a, b) => a.manifestDigest.localeCompare(b.manifestDigest));
  const control: { canonical: RbacPrincipal; ready: boolean; withdrawn: Set<string> } = {
    canonical: ACTOR,
    ready: true,
    withdrawn: new Set(),
  };
  const port: SpackMaterialLifecyclePort = {
    assertAvailable: mock(async (binding) => {
      if (control.withdrawn.has(binding.manifestDigest)) {
        throw new SpackMaterialLifecycleError("MATERIAL_RELEASE_WITHDRAWN");
      }
    }),
    inspect: mock(async () => {
      throw new Error("Management catalog must not load lifecycle audit history");
    }),
    transition: mock(async () => {
      throw new Error("Read-only catalog must not mutate lifecycle");
    }),
    inspectCatalog: mock(async (values, subject, authorize) => {
      if (!control.ready) throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_UNAVAILABLE");
      if (subject !== control.canonical.sub) {
        throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_FORBIDDEN");
      }
      let allowed: readonly boolean[];
      try {
        allowed = await authorize(control.canonical);
      } catch (error) {
        if (error instanceof SpackMaterialLifecycleError) throw error;
        throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_FORBIDDEN");
      }
      return values.flatMap((binding, index): SpackMaterialCatalogState[] => {
        if (!allowed[index]) return [];
        const withdrawn = control.withdrawn.has(binding.manifestDigest);
        return [{ ...binding, revision: withdrawn ? 1 : 0, state: withdrawn ? "withdrawn" : "available" }];
      });
    }),
  };
  const store = new SpackMaterialStore(f.root, f.recipes, {}, undefined, port);
  const app = materialApp(store, { allowTestHeader: true, jwtSecret: CURSOR_SECRET });
  const list = (
    query: Parameters<SpackMaterialStore["listManaged"]>[0] = { ...QUERY, repository: name },
    signal?: AbortSignal,
  ) => store.listManaged(query, ACTOR.sub, { cursorSecret: CURSOR_SECRET, signal });
  const read = f.store.getManifest.bind(f.store);
  const readerPort = {
    cursorSecret: CURSOR_SECRET,
    subject: ACTOR.sub,
    authorize: mock(async () => {}),
    read,
    inspect: mock(async (releases: Awaited<ReturnType<typeof read>>[]) =>
      releases.map(({ manifest, bytes }): SpackMaterialCatalogState => ({
        repositoryId: SpackMaterialStore.repositoryId(manifest.repository),
        manifestDigest: materialDigest(bytes),
        revision: 0,
        state: "available",
      })),
    ),
  };
  return { ...f, store, app, bindings, control, port, readerPort, list };
}

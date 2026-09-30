import { describe, expect, mock, spyOn, test } from "bun:test";
import { type SpackInstallBindings, SpackMaterialLifecycleError } from "@kuintessence/db";
import type {
  SpackInstallBindingChange,
  SpackInstallBindingView,
  SpackMaterialManifest,
} from "@kuintessence/shared";
import { COMMIT, ORG, OTHER_ORG, repository } from "../routes/spack-repositories.test-helpers";
import type { RbacPrincipal } from "./namespace";
import { RecipeStoreError } from "./recipe-git";
import type { RecipeGitStore } from "./recipe-git-store";
import { SpackInstallBindingAccess } from "./spack-install-bindings";
import type { SpackMaterialStore } from "./spack-material-store";

type Port = Pick<SpackInstallBindings, "inspect" | "transition">;
const ACTOR: RbacPrincipal = {
  sub: "44444444-4444-4444-8444-444444444444",
  role: "org_admin",
  orgIds: [ORG],
};
const BIND: SpackInstallBindingChange = {
  scope: ORG,
  spec: "hello@1.0",
  action: "bind",
  expectedRevision: 0,
  reason: "Reviewed release",
  binding: { repositoryId: "b".repeat(64), manifestDigest: `sha256:${"c".repeat(64)}` },
};
const DISABLE: SpackInstallBindingChange = {
  scope: ORG,
  spec: BIND.spec,
  action: "disable",
  expectedRevision: 1,
  reason: "Pause new installations",
};

function fixture() {
  const recipe = repository();
  const snapshot = recipe.snapshots[0];
  if (!snapshot) throw new Error("Missing fixture snapshot");
  const blob = { digest: `sha256:${"d".repeat(64)}`, size: 1 };
  const manifest: SpackMaterialManifest = {
    version: 1,
    repository: `org/${ORG}/materials`,
    spec: BIND.spec,
    spackVersion: "1.0.0",
    target: "linux-ubuntu24.04-x86_64",
    redistribution: "unrestricted",
    recipes: [{ repositoryId: recipe.id, commit: COMMIT, roots: ["repo"], archive: blob }],
    sources: [{ path: "hello.tar.gz", blob }],
    lockfile: blob,
  };
  const view: SpackInstallBindingView = {
    scope: ORG,
    spec: BIND.spec,
    revision: 0,
    state: "absent",
    binding: null,
    history: [],
    historyTruncated: false,
  };
  const control = { canonical: ACTOR };
  const committed = mock(() => {});
  // Exercise the real service callback; scope, CAS and DB locks have their own DB tests.
  const port = {
    inspect: mock(async (..._args: Parameters<Port["inspect"]>) => view),
    transition: mock(async (...[, , authorize]: Parameters<Port["transition"]>) => {
      await authorize(control.canonical);
      committed();
      return view;
    }),
  } satisfies Port;
  const store = {
    getManifest: mock(async (...[, , options]: Parameters<SpackMaterialStore["getManifest"]>) => {
      options?.checkpoint?.();
      return { manifest, bytes: new Uint8Array() };
    }),
  };
  const recipes = {
    getSnapshot: mock(async (...[id, , checkpoint]: Parameters<RecipeGitStore["getSnapshot"]>) => {
      checkpoint?.();
      return { id, repository: recipe.repository, snapshot };
    }),
  };
  const access = new SpackInstallBindingAccess(port, store, recipes);
  return { access, port, store, recipes, recipe, snapshot, manifest, control, committed, view };
}

describe("install binding service admission", () => {
  test("inspection passes exact scope/spec and subject without reading files", async () => {
    const f = fixture();
    const query = { scope: ORG, spec: BIND.spec };
    expect(await f.access.inspect(query, ACTOR.sub)).toBe(f.view);
    expect(f.port.inspect).toHaveBeenCalledWith(query, ACTOR.sub);
    expect(f.store.getManifest).not.toHaveBeenCalled();
    expect(f.recipes.getSnapshot).not.toHaveBeenCalled();
  });

  test.each([" hello@1.0", "hello@1.0\n", "x".repeat(501)])(
    "validates direct service calls before port admission: %s",
    async (spec) => {
      const f = fixture();
      expect(() => f.access.inspect({ scope: ORG, spec }, ACTOR.sub)).toThrow();
      await expect(f.access.change({ ...BIND, spec }, ACTOR.sub)).rejects.toMatchObject({
        status: 422,
      });
      expect(f.port.inspect).not.toHaveBeenCalled();
      expect(f.port.transition).not.toHaveBeenCalled();
      expect(f.store.getManifest).not.toHaveBeenCalled();
    },
  );

  test("foreign scope rejection precedes material reads and transition", async () => {
    const f = fixture();
    f.port.inspect.mockRejectedValue(new SpackMaterialLifecycleError("INSTALL_BINDING_FORBIDDEN"));
    await expect(f.access.change({ ...BIND, scope: OTHER_ORG }, ACTOR.sub)).rejects.toMatchObject({
      code: "INSTALL_BINDING_FORBIDDEN",
    });
    expect(f.store.getManifest).not.toHaveBeenCalled();
    expect(f.recipes.getSnapshot).not.toHaveBeenCalled();
    expect(f.port.transition).not.toHaveBeenCalled();
  });

  test.each(["hello@1.1", "hello@1.0 +shared", "hello@1.0  %gcc"])(
    "rejects a manifest for a different exact spec: %s",
    async (spec) => {
      const f = fixture();
      f.manifest.spec = spec;
      await expect(f.access.change(BIND, ACTOR.sub)).rejects.toMatchObject({
        code: "INSTALL_BINDING_INVALID",
      });
      expect(f.recipes.getSnapshot).not.toHaveBeenCalled();
      expect(f.port.transition).not.toHaveBeenCalled();
    },
  );

  test.each([
    { scope: ORG, name: `org/${OTHER_ORG}/materials` },
    { scope: ORG, name: `user/${ACTOR.sub}/materials` },
    { scope: "platform", name: `org/${ORG}/materials` },
    { scope: "platform", name: "org/platform/materials" },
  ])("rejects $name for $scope even for a platform administrator", async ({ scope, name }) => {
    const f = fixture();
    f.control.canonical = { ...ACTOR, role: "super_admin", orgIds: [ORG, OTHER_ORG] };
    f.manifest.repository = name;
    await expect(f.access.change({ ...BIND, scope }, ACTOR.sub)).rejects.toMatchObject({
      code: "INSTALL_BINDING_INVALID",
    });
    expect(f.port.transition).not.toHaveBeenCalled();
  });

  test.each([ORG, "platform"])("accepts public materials for scope %s", async (scope) => {
    const f = fixture();
    f.manifest.repository = "public/materials";
    f.recipe.repository = "public/recipes";
    const change = { ...BIND, scope };
    await f.access.change(change, ACTOR.sub);
    expect(f.store.getManifest).toHaveBeenCalledWith(
      BIND.binding.repositoryId,
      BIND.binding.manifestDigest,
      { checkpoint: expect.any(Function) },
    );
    expect(f.port.transition).toHaveBeenCalledWith(change, ACTOR.sub, expect.any(Function));
    expect(f.committed).toHaveBeenCalledTimes(1);
  });

  test("disable still works when the manifest and recipe are unavailable", async () => {
    const f = fixture();
    f.store.getManifest.mockRejectedValue(new Error("Withdrawn or corrupt material"));
    f.recipes.getSnapshot.mockRejectedValue(new RecipeStoreError(404, "Removed recipe"));
    expect(await f.access.change(DISABLE, ACTOR.sub)).toBe(f.view);
    expect(f.port.inspect).toHaveBeenCalledWith({ scope: ORG, spec: BIND.spec }, ACTOR.sub);
    expect(f.port.transition).toHaveBeenCalledWith(DISABLE, ACTOR.sub, expect.any(Function));
    expect(f.store.getManifest).not.toHaveBeenCalled();
    expect(f.recipes.getSnapshot).not.toHaveBeenCalled();
    expect(f.committed).toHaveBeenCalledTimes(1);
  });
});

describe("install binding canonical recipe authorization", () => {
  test("rechecks canonical membership after loading snapshots", async () => {
    const f = fixture();
    f.recipes.getSnapshot.mockImplementation(async (id) => {
      f.control.canonical = { ...ACTOR, orgIds: [] };
      return { id, repository: f.recipe.repository, snapshot: f.snapshot };
    });
    await expect(f.access.change(BIND, ACTOR.sub)).rejects.toMatchObject({ status: 404 });
    expect(f.port.transition).toHaveBeenCalledTimes(1);
    expect(f.committed).not.toHaveBeenCalled();
  });

  test.each(["foreign namespace", "private into public", "commit", "root", "diagnostic"] as const)(
    "rejects unsafe recipe selection: %s",
    async (mode) => {
      const f = fixture();
      f.control.canonical = { ...ACTOR, role: "super_admin", orgIds: [ORG, OTHER_ORG] };
      if (mode === "foreign namespace") f.recipe.repository = `org/${OTHER_ORG}/recipes`;
      if (mode === "private into public") f.manifest.repository = "public/materials";
      if (mode === "commit") f.snapshot.commit = "e".repeat(40);
      if (mode === "root") f.snapshot.roots = [];
      if (mode === "diagnostic") {
        f.snapshot.diagnostics = [
          { severity: "error", code: "INVALID", message: "Private recipe diagnostic" },
        ];
      }
      await expect(f.access.change(BIND, ACTOR.sub)).rejects.toMatchObject({
        status: mode === "commit" ? 404 : mode === "root" || mode === "diagnostic" ? 422 : 403,
      });
      expect(f.committed).not.toHaveBeenCalled();
    },
  );

  test("loads each immutable snapshot once and validates every selected root", async () => {
    const f = fixture();
    const selection = f.manifest.recipes[0];
    if (!selection) throw new Error("Missing recipe selection");
    f.manifest.recipes.push({ ...selection, roots: ["missing-root"] });
    await expect(f.access.change(BIND, ACTOR.sub)).rejects.toMatchObject({ status: 422 });
    expect(f.recipes.getSnapshot).toHaveBeenCalledTimes(1);
    expect(f.recipes.getSnapshot).toHaveBeenCalledWith(f.recipe.id, COMMIT, expect.any(Function));
    expect(f.committed).not.toHaveBeenCalled();
  });

  test("warnings and inactive recipes still allow a pinned static snapshot", async () => {
    const f = fixture();
    expect(f.recipe.activeCommit).toBeNull();
    expect(f.snapshot.diagnostics[0]?.severity).toBe("warning");
    await f.access.change(BIND, ACTOR.sub);
    expect(f.committed).toHaveBeenCalledTimes(1);
  });

  test.each([404, 503] as const)("snapshot failure (%s) prevents writes", async (status) => {
    const f = fixture();
    const error = new RecipeStoreError(status, "Private snapshot failure");
    f.recipes.getSnapshot.mockRejectedValue(error);
    await expect(f.access.change(BIND, ACTOR.sub)).rejects.toBe(error);
    expect(f.port.transition).not.toHaveBeenCalled();
    expect(f.committed).not.toHaveBeenCalled();
    await f.access.change(DISABLE, ACTOR.sub);
    expect(f.committed).toHaveBeenCalledTimes(1);
  });

  test.each([
    "INSTALL_BINDING_CONFLICT",
    "MATERIAL_RELEASE_WITHDRAWN",
    "MATERIAL_VISIBILITY_DENIED",
    "INSTALL_BINDING_UNAVAILABLE",
  ] as const)("never turns port rejection %s into a successful receipt", async (code) => {
    const f = fixture();
    f.port.transition.mockRejectedValue(new SpackMaterialLifecycleError(code));
    await expect(f.access.change(BIND, ACTOR.sub)).rejects.toMatchObject({ code });
    expect(f.committed).not.toHaveBeenCalled();
  });
});

describe("install binding bounded work", () => {
  test.each(["before", "snapshot", "canonical", "disable"] as const)(
    "cancellation at %s prevents committing",
    async (phase) => {
      const f = fixture();
      const controller = new AbortController();
      if (phase === "before") controller.abort();
      if (phase === "snapshot") {
        f.recipes.getSnapshot.mockImplementation(async (id) => {
          controller.abort();
          return { id, repository: f.recipe.repository, snapshot: f.snapshot };
        });
      }
      if (phase === "canonical" || phase === "disable") {
        const transition = f.port.transition.getMockImplementation();
        if (!transition) throw new Error("Missing transition");
        f.port.transition.mockImplementation(async (...args) => {
          controller.abort();
          return transition(...args);
        });
      }
      await expect(
        f.access.change(phase === "disable" ? DISABLE : BIND, ACTOR.sub, controller.signal),
      ).rejects.toMatchObject({ code: "INSTALL_BINDING_UNAVAILABLE" });
      expect(f.committed).not.toHaveBeenCalled();
      if (phase === "before") expect(f.port.inspect).not.toHaveBeenCalled();
    },
  );

  test("expired metadata work cannot enter the transition", async () => {
    const f = fixture();
    const clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      f.recipes.getSnapshot.mockImplementation(async (id) => {
        clock.mockReturnValue(1_800_000_010_001);
        return { id, repository: f.recipe.repository, snapshot: f.snapshot };
      });
      await expect(f.access.change(BIND, ACTOR.sub)).rejects.toMatchObject({
        code: "INSTALL_BINDING_UNAVAILABLE",
      });
      expect(f.port.transition).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  test("cancelled I/O holds slots until settled and then releases admission", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let count = 0;
    f.recipes.getSnapshot.mockImplementation(async (id) => {
      if (++count === 2) entered.resolve();
      await release.promise;
      return { id, repository: f.recipe.repository, snapshot: f.snapshot };
    });
    const controller = new AbortController();
    const change = () => f.access.change(BIND, ACTOR.sub, controller.signal);
    const pending = Promise.allSettled([change(), change()]);
    try {
      await entered.promise;
      controller.abort();
      await expect(f.access.change(BIND, ACTOR.sub)).rejects.toMatchObject({
        code: "INSTALL_BINDING_UNAVAILABLE",
      });
      expect(f.recipes.getSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
    }
    for (const result of await pending) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: { code: "INSTALL_BINDING_UNAVAILABLE" },
      });
    }
    expect(f.committed).not.toHaveBeenCalled();
    await f.access.change(BIND, ACTOR.sub);
    expect(f.committed).toHaveBeenCalledTimes(1);
  });
});

import { mock } from "bun:test";
import { SpackMaterialLifecycleError, SpackMaterialVisibilityError } from "@kuintessence/db";
import type { SpackMaterialBinding } from "@kuintessence/shared";
import { materialApp, materialFixture } from "../routes/spack-materials.test-helpers";
import { ORG, repository } from "../routes/spack-repositories.test-helpers";
import type { RbacPrincipal } from "./namespace";
import {
  type SpackMaterialLifecyclePort,
  SpackMaterialStore,
  type SpackMaterialVisibilityPort,
} from "./spack-material-store";

export const OWNER: RbacPrincipal = {
  sub: "44444444-4444-4444-8444-444444444444",
  role: "platform_admin",
  orgIds: [ORG],
};
export const READER: RbacPrincipal = {
  sub: "77777777-7777-4777-8777-777777777777",
  role: "user",
  orgIds: [ORG],
};
export const SECRET = "visibility-fixture-only-secret-00000000";
type Status = Awaited<ReturnType<SpackMaterialVisibilityPort["inspect"]>>;
export type Change = Parameters<SpackMaterialVisibilityPort["transition"]>[2];
const INITIAL: Status = {
  revision: 0,
  policy: { mode: "inherit" },
  history: [],
  historyTruncated: false,
};
export const HIDE: Change = {
  policy: { mode: "allowlist", userIds: [], orgIds: [] },
  expectedRevision: 0,
  reason: "Restrict distribution",
};

export function visibilityFake() {
  const control: {
    canonical: RbacPrincipal;
    suspended: boolean;
    ready: boolean;
    failure?: Error;
    inTransaction: boolean;
  } = { canonical: OWNER, suspended: false, ready: true, inTransaction: false };
  const states = new Map<string, Status>();
  const withdrawn = new Set<string>();
  const key = (binding: SpackMaterialBinding) =>
    `${binding.repositoryId}/${binding.manifestDigest}`;
  const current = (binding: SpackMaterialBinding) => states.get(key(binding)) ?? INITIAL;
  const available = async (binding: SpackMaterialBinding) => {
    if (withdrawn.has(key(binding))) {
      throw new SpackMaterialLifecycleError("MATERIAL_RELEASE_WITHDRAWN");
    }
  };
  // Only model the callback contract here; locking and policy persistence belong to real PG tests.
  const canonical = async (
    subject: string,
    authorize: Parameters<SpackMaterialVisibilityPort["inspect"]>[2],
    read = false,
  ) => {
    if (control.failure) throw control.failure;
    if (!control.ready) throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
    if (control.suspended || subject !== control.canonical.sub) {
      throw new SpackMaterialVisibilityError(
        read ? "MATERIAL_VISIBILITY_DENIED" : "MATERIAL_VISIBILITY_FORBIDDEN",
      );
    }
    control.inTransaction = true;
    try {
      await authorize({ ...control.canonical, orgIds: [...control.canonical.orgIds] });
    } catch (error) {
      if (error instanceof SpackMaterialVisibilityError) throw error;
      throw new SpackMaterialVisibilityError(
        read ? "MATERIAL_VISIBILITY_DENIED" : "MATERIAL_VISIBILITY_FORBIDDEN",
      );
    } finally {
      control.inTransaction = false;
    }
  };
  const port = {
    assertReadable: mock(
      async (
        ...[binding, subject, authorize, checkpoint]: Parameters<
          SpackMaterialVisibilityPort["assertReadable"]
        >
      ) => {
        checkpoint?.();
        await available(binding);
        await canonical(subject, authorize, true);
        checkpoint?.();
        const policy = current(binding).policy;
        if (
          policy.mode === "allowlist" &&
          !policy.userIds.includes(control.canonical.sub) &&
          !policy.orgIds.some((id) => control.canonical.orgIds.includes(id))
        ) {
          throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_DENIED");
        }
      },
    ),
    inspect: mock(
      async (
        ...[binding, subject, authorize]: Parameters<SpackMaterialVisibilityPort["inspect"]>
      ) => {
        await canonical(subject, authorize);
        return current(binding);
      },
    ),
    transition: mock(
      async (
        ...[binding, subject, change, authorize]: Parameters<
          SpackMaterialVisibilityPort["transition"]
        >
      ) => {
        await canonical(subject, authorize);
        const previous = current(binding);
        if (
          previous.revision !== change.expectedRevision ||
          JSON.stringify(previous.policy) === JSON.stringify(change.policy)
        ) {
          throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_CONFLICT");
        }
        const revision = previous.revision + 1;
        const next: Status = {
          revision,
          policy: change.policy,
          history: [
            {
              revision,
              policy: change.policy,
              operatorId: subject,
              reason: change.reason,
              epoch: "11111111-1111-4111-8111-111111111111",
              rolloutRevision: 2,
              createdAt: "2026-09-21T00:00:00.000Z",
            },
            ...previous.history,
          ].slice(0, 100),
          historyTruncated: revision > 100,
        };
        states.set(key(binding), next);
        return next;
      },
    ),
  } satisfies SpackMaterialVisibilityPort;
  const lifecycle: SpackMaterialLifecyclePort = {
    assertAvailable: available,
    inspect: mock(async () => {
      throw new Error("Unexpected lifecycle inspection");
    }),
    transition: mock(async () => {
      throw new Error("Unexpected lifecycle mutation");
    }),
    inspectCatalog: async (bindings, subject, authorize, checkpoint) => {
      checkpoint?.();
      let mask: readonly boolean[] = [];
      await canonical(subject, async (principal) => {
        mask = await authorize(principal);
      });
      checkpoint?.();
      return bindings.flatMap((binding, index) =>
        mask[index]
          ? [
              {
                ...binding,
                revision: withdrawn.has(key(binding)) ? 1 : 0,
                state: withdrawn.has(key(binding)) ? ("withdrawn" as const) : ("available" as const),
              },
            ]
          : [],
      );
    },
  };
  return { control, port, lifecycle, states, withdrawn, key, current };
}

export async function visibilityFixture(name = "public/materials") {
  const f = await materialFixture({}, repository("public/recipes"));
  await f.seed(name);
  const input = { ...f.input, repository: name };
  const binding = await f.store.publish(input, { ...OWNER, role: "super_admin" });
  const fake = visibilityFake();
  const store = new SpackMaterialStore(f.root, f.recipes, {}, undefined, fake.lifecycle, fake.port);
  const app = materialApp(store, { allowTestHeader: true, jwtSecret: SECRET });
  const path = `/api/spack/material-repositories/${binding.repositoryId}/releases/${binding.manifestDigest}`;
  return { ...f, ...fake, input, binding, store, app, path };
}

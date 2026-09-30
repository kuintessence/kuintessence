import { desc, sql } from "drizzle-orm";
import type { PgDb } from "./index";
import { spackInstallBindingEvents, spackMaterialBindings } from "./schema-spack-materials";
import {
  installBindingCondition,
  installBindingEvent,
  readSpackInstallBinding,
  type SpackInstallBindingQuery,
} from "./spack-install-binding-state";
import { assertSpackMaterialBindingsActive } from "./spack-material-binding-retirement";
import {
  assertSpackMaterialReleasesAvailable,
  SpackMaterialLifecycleError,
} from "./spack-material-lifecycle-state";
import {
  authorizeSpackMaterialMemberships,
  type SpackMaterialLifecyclePrincipal,
} from "./spack-material-principal";
import {
  parseSpackMaterialBindings,
  type SpackMaterialReferenceBinding,
  withSpackMaterialLifecycleTransaction,
} from "./spack-material-references";
import {
  assertSpackMaterialRuntime,
  isSpackMaterialReady,
  readSpackMaterialRollout,
} from "./spack-material-runtime";
import { assertSpackMaterialOperationVisibility } from "./spack-material-visibility-state";

export type { SpackInstallBindingQuery } from "./spack-install-binding-state";
export type SpackInstallBindingChange = SpackInstallBindingQuery & {
  expectedRevision: number;
  reason: string;
} & (
    | { action: "bind"; binding: SpackMaterialReferenceBinding }
    | { action: "disable" }
  );
type Transaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
type Authorize = (principal: SpackMaterialLifecyclePrincipal) => Promise<void>;

/** Selection changes and admission use the same lock as withdrawal and retirement. */
export class SpackInstallBindings {
  constructor(
    private readonly db: PgDb,
    private readonly epoch?: string,
  ) {}

  async inspect(query: SpackInstallBindingQuery, subject: string) {
    const value = parseQuery(query);
    return this.transaction(async (tx) => {
      await this.requireReady(tx);
      await authorizeSpackMaterialMemberships(tx, subject, async (principal, memberships) => {
        assertScope(principal, memberships, value.scope);
      });
      return status(tx, value);
    });
  }

  async transition(input: SpackInstallBindingChange, subject: string, authorize: Authorize) {
    const change = parseChange(input);
    return this.transaction(async (tx) => {
      const rollout = await this.requireReady(tx);
      await authorizeSpackMaterialMemberships(tx, subject, async (principal, memberships) => {
        assertScope(principal, memberships, change.scope);
        await authorize(principal);
      });
      const current = await readSpackInstallBinding(tx, change);
      if (
        (current?.revision ?? 0) !== change.expectedRevision ||
        (change.action === "disable" && current?.state === "disabled")
      ) {
        throw new SpackMaterialLifecycleError("INSTALL_BINDING_CONFLICT");
      }
      if (change.action === "bind") {
        const value = { spec: change.spec, ...change.binding };
        await assertSpackMaterialBindingsActive(tx, [value]);
        await assertSpackMaterialReleasesAvailable(tx, [value]);
        await assertSpackMaterialOperationVisibility(tx, value, subject);
        await tx.insert(spackMaterialBindings).values(value).onConflictDoNothing();
      }
      await tx.insert(spackInstallBindingEvents).values({
        scope: change.scope,
        spec: change.spec,
        revision: change.expectedRevision + 1,
        state: change.action === "bind" ? "enabled" : "disabled",
        repositoryId: change.action === "bind" ? change.binding.repositoryId : null,
        manifestDigest: change.action === "bind" ? change.binding.manifestDigest : null,
        source: "web",
        operatorId: subject,
        reason: change.reason,
        epoch: rollout.epoch,
        rolloutRevision: rollout.revision,
      });
      return status(tx, change);
    });
  }

  private async requireReady(tx: Transaction) {
    await assertSpackMaterialRuntime(tx, this.epoch);
    const rollout = await readSpackMaterialRollout(tx);
    if (!rollout || !isSpackMaterialReady(rollout.phase) || rollout.epoch !== this.epoch) {
      throw new SpackMaterialLifecycleError("INSTALL_BINDING_UNAVAILABLE");
    }
    return rollout;
  }

  private async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await withSpackMaterialLifecycleTransaction(this.db, async (tx) => {
        await tx.execute(sql`set local statement_timeout = '10s'`);
        return work(tx);
      });
    } catch (error) {
      if (error instanceof SpackMaterialLifecycleError) throw error;
      throw new SpackMaterialLifecycleError("INSTALL_BINDING_UNAVAILABLE");
    }
  }
}

function assertScope(
  principal: SpackMaterialLifecyclePrincipal,
  memberships: { orgId: string; role: string }[],
  scope: string,
) {
  if (principal.role === "super_admin" || principal.role === "platform_admin") return;
  const hasScopedMembership = memberships.some((membership) =>
    ["owner", "admin", "operator"].includes(membership.role),
  );
  if (
    scope !== "platform" &&
    principal.orgIds.includes(scope) &&
    ((!hasScopedMembership && principal.role === "org_admin") ||
      memberships.some(
        (membership) =>
          membership.orgId === scope && ["owner", "admin"].includes(membership.role),
      ))
  ) {
    return;
  }
  throw new SpackMaterialLifecycleError("INSTALL_BINDING_FORBIDDEN");
}

async function status(tx: Transaction, query: SpackInstallBindingQuery) {
  const rows = await tx
    .select()
    .from(spackInstallBindingEvents)
    .where(installBindingCondition(query))
    .orderBy(desc(spackInstallBindingEvents.revision))
    .limit(101);
  const history = rows.slice(0, 100).map(installBindingEvent);
  return {
    scope: query.scope,
    spec: query.spec,
    revision: history[0]?.revision ?? 0,
    state: history[0]?.state ?? "absent",
    binding: history[0]?.binding ?? null,
    history,
    historyTruncated: rows.length > 100,
  };
}

function validText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    [...value].every((character) => character.charCodeAt(0) >= 32 && character !== "\x7f")
  );
}

function parseQuery(input: SpackInstallBindingQuery): SpackInstallBindingQuery {
  if (
    !input ||
    typeof input !== "object" ||
    !validText(input.spec, 500) ||
    (input.scope !== "platform" &&
      (typeof input.scope !== "string" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.scope)))
  ) {
    throw new SpackMaterialLifecycleError("INSTALL_BINDING_INVALID");
  }
  return { scope: input.scope, spec: input.spec };
}

function parseChange(input: SpackInstallBindingChange): SpackInstallBindingChange {
  const query = parseQuery(input);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision >= 2_147_483_647 ||
    !validText(input.reason, 1000) ||
    (input.action !== "bind" && input.action !== "disable")
  ) {
    throw new SpackMaterialLifecycleError("INSTALL_BINDING_INVALID");
  }
  const common = { ...query, expectedRevision: input.expectedRevision, reason: input.reason };
  if (input.action === "disable") return { ...common, action: "disable" };
  try {
    const [binding] = parseSpackMaterialBindings({ [query.spec]: input.binding });
    if (!binding) throw new Error("Missing binding");
    return {
      ...common,
      action: "bind",
      binding: { repositoryId: binding.repositoryId, manifestDigest: binding.manifestDigest },
    };
  } catch {
    throw new SpackMaterialLifecycleError("INSTALL_BINDING_INVALID");
  }
}

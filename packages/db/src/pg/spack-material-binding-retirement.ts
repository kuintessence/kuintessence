import { and, eq, or } from "drizzle-orm";
import type { PgDb } from "./index";
import { spackMaterialBindingRetirements, spackMaterialBindings } from "./schema-spack-materials";

type Transaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
interface Binding {
  spec: string;
  repositoryId: string;
  manifestDigest: string;
}
const PAGE_SIZE = 250;

function matches(bindings: Binding[]) {
  return or(
    ...bindings.map((binding) =>
      and(
        eq(spackMaterialBindings.spec, binding.spec),
        eq(spackMaterialBindings.repositoryId, binding.repositoryId),
        eq(spackMaterialBindings.manifestDigest, binding.manifestDigest),
      ),
    ),
  );
}

/** Call only inside the shared lifecycle transaction, including for an empty batch. */
export async function assertSpackMaterialBindingsActive(tx: Transaction, bindings: Binding[]) {
  await tx.select().from(spackMaterialBindingRetirements).limit(0);
  for (let offset = 0; offset < bindings.length; offset += PAGE_SIZE) {
    const [retired] = await tx
      .select({ id: spackMaterialBindingRetirements.bindingId })
      .from(spackMaterialBindingRetirements)
      .innerJoin(
        spackMaterialBindings,
        eq(spackMaterialBindings.id, spackMaterialBindingRetirements.bindingId),
      )
      .where(matches(bindings.slice(offset, offset + PAGE_SIZE)))
      .limit(1);
    if (retired) throw new Error("Spack material binding is retired");
  }
}

/** Exact, nonempty batch only; caller holds the lifecycle and operations locks. */
export async function retireSpackMaterialBindings(
  tx: Transaction,
  bindings: Binding[],
  audit: Omit<typeof spackMaterialBindingRetirements.$inferInsert, "bindingId" | "createdAt">,
) {
  if (bindings.length === 0 || bindings.length > 1000) {
    throw new Error("Invalid retirement batch");
  }
  const identities = bindings.map((binding) =>
    JSON.stringify([binding.spec, binding.repositoryId, binding.manifestDigest]),
  );
  if (new Set(identities).size !== bindings.length) {
    throw new Error("Duplicate retirement binding");
  }
  for (let offset = 0; offset < bindings.length; offset += PAGE_SIZE) {
    const page = bindings.slice(offset, offset + PAGE_SIZE);
    const rows = await tx
      .select({ id: spackMaterialBindings.id })
      .from(spackMaterialBindings)
      .where(matches(page))
      .for("share");
    if (rows.length !== page.length) throw new Error("Unknown retirement binding");
    // The primary key rejects already-retired bindings; any conflict rolls back the batch.
    await tx
      .insert(spackMaterialBindingRetirements)
      .values(rows.map((row) => ({ ...audit, bindingId: row.id })));
  }
}

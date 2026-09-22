import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { z } from "zod";

const examples = "../docs/examples/spack-workflows/";
const blank = z.null();
const empty = z.array(z.never()).length(0);
const pending = z.object({ status: z.literal("pending"), evidence: empty }).strict();
const names = z
  .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
  .min(1)
  .refine((values) => new Set(values).size === values.length);
const InventorySchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("spack-workflow-candidate-inventory"),
    status: z.literal("unvalidated"),
    workflows: z
      .array(
        z
          .object({
            id: z.string().regex(/^(0[1-9]|1[0-5])$/),
            name: z.string().min(1),
            packages: names,
            inputs: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .length(15)
      .refine((values) => new Set(values.map((item) => item.id)).size === 15),
  })
  .strict();

// This checks the shipped blank worksheet, not operator-filled acceptance records.
const BlankRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("spack-workflow-acceptance-record"),
    workflow_id: blank,
    status: z.literal("pending"),
    target_profile: z
      .object({
        id: blank,
        os: blank,
        architecture: blank,
        spack_version: blank,
        compiler: blank,
        externals: empty,
        mpi: blank,
        scheduler: blank,
        runtime_digest: blank,
        site_profile_digest: blank,
        storage_layout_review: blank,
        resource_budget_review: blank,
        network_policy_review: blank,
      })
      .strict(),
    software: z
      .array(
        z
          .object({
            package: blank,
            satisfies_candidates: empty,
            requested_spec: blank,
            root_hash: blank,
            recipe: z
              .object({
                repository_id: blank,
                upstream_commit: blank,
                snapshot_commit: blank,
                roots: empty,
                bundle_sha256: blank,
                bundle_bytes: blank,
              })
              .strict(),
            material: z
              .object({
                repository_id: blank,
                manifest_digest: blank,
                lock_sha256: blank,
                lock_bytes: blank,
                source_inventory_digest: blank,
                source_files: blank,
                source_bytes: blank,
              })
              .strict(),
            redistribution_review: blank,
            preparation_evidence: blank,
            import_mode: blank,
            import_binding: blank,
            gates: z
              .object({
                recipe_review: pending,
                linux_lock: pending,
                source_closure: pending,
                import_readback: pending,
                source_audit: pending,
                offline_build: pending,
                readonly_verify: pending,
                managed_load: pending,
                restart_verify: pending,
                cleanup: pending,
              })
              .strict(),
          })
          .strict(),
      )
      .length(1),
    inputs: z
      .array(
        z
          .object({
            id: blank,
            origin: blank,
            version: blank,
            sha256: blank,
            bytes: blank,
            usage_review: blank,
            redistribution_review: blank,
          })
          .strict(),
      )
      .length(1),
    steps: z
      .array(
        z
          .object({
            id: blank,
            binding: blank,
            input_contract: blank,
            output_contract: blank,
            resources: blank,
            acceptance_criteria: blank,
            evidence: empty,
          })
          .strict(),
      )
      .length(1),
    gates: z
      .object({
        target_review: pending,
        input_review: pending,
        scheduler_run: pending,
        interface_checks: pending,
        scientific_checks: pending,
        reproducibility: pending,
        cleanup: pending,
      })
      .strict(),
    blockers: empty,
  })
  .strict();

async function text(path: string) {
  return readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

async function yaml(name: string): Promise<unknown> {
  const document = parseDocument(await text(`${examples}${name}`), { uniqueKeys: true });
  expect(document.errors).toEqual([]);
  expect(document.warnings).toEqual([]);
  return document.toJS({ maxAliasCount: 0 });
}

describe("scientific workflow handoff templates (not runtime acceptance)", () => {
  test("lists all 15 workflows exactly once in ID order", async () => {
    const inventory = InventorySchema.parse(await yaml("inventory.yaml"));
    expect(inventory.workflows.map((item) => item.id)).toEqual(
      Array.from({ length: 15 }, (_, index) => String(index + 1).padStart(2, "0")),
    );
  });

  test("matches the material guide's candidate names without inventing specs", async () => {
    const inventory = InventorySchema.parse(await yaml("inventory.yaml"));
    const guide = await text("../docs/spack-workflow-materials.md");
    const rows = guide.split("\n").filter((line) => /^\| (0[1-9]|1[0-5]) /.test(line));
    expect(rows).toHaveLength(15);
    for (const [index, row] of rows.entries()) {
      const columns = row.split("|").map((column) => column.trim());
      const label = columns[1];
      const candidates = columns[2];
      const item = inventory.workflows[index];
      if (!label || !candidates || !item) throw new Error("Incomplete candidate table row");
      const packages = names.parse([...candidates.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
      expect(`${item.id} ${item.name}`).toBe(label);
      expect(item.packages).toEqual(packages);
    }
  });

  test("rejects duplicate workflow IDs, duplicate candidates and versioned specs", async () => {
    const original = InventorySchema.parse(await yaml("inventory.yaml"));
    const first = original.workflows[0];
    if (!first) throw new Error("Missing first workflow");
    for (const replacement of [
      { ...first, id: "02" },
      { ...first, packages: [...first.packages, first.packages[0]] },
      { ...first, packages: ["samtools@1.19.2"] },
    ]) {
      expect(
        InventorySchema.safeParse({
          ...original,
          workflows: [replacement, ...original.workflows.slice(1)],
        }).success,
      ).toBe(false);
    }
  });

  test("ships only a blank target, material, input, step and gate worksheet", async () => {
    expect(BlankRecordSchema.safeParse(await yaml("acceptance-record.yaml")).success).toBe(true);
  });

  test("rejects pre-filled success, redistribution approval or historical bindings", async () => {
    const original = BlankRecordSchema.parse(await yaml("acceptance-record.yaml"));
    const software = original.software[0];
    if (!software) throw new Error("Missing software template");
    for (const modified of [
      { ...original, status: "passed" },
      { ...original, target_profile: { ...original.target_profile, os: "reference-linux" } },
      {
        ...original,
        software: [{ ...software, redistribution_review: "approved" }],
      },
      {
        ...original,
        software: [{ ...software, import_binding: { repositoryId: "historical-binding" } }],
      },
      {
        ...original,
        gates: { ...original.gates, scientific_checks: { status: "passed", evidence: [] } },
      },
    ]) {
      expect(BlankRecordSchema.safeParse(modified).success).toBe(false);
    }
  });
});

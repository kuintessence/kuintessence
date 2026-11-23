// SPDX-License-Identifier: MIT
import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type SoftwareAssetRef, workflowDsl } from "@kuintessence/shared";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  type EcosystemAssetKind,
  type EcosystemManifest,
  EcosystemManifestEnvelopeSchema,
  usecaseSpecDigest,
  validateEcosystemManifest,
} from "../packages/registry/src/services/ecosystem-release-service";

const MetadataSchema = z.record(
  z.string(),
  z.strictObject({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    domain: z.string().optional(),
  }),
);

function identity(kind: EcosystemAssetKind, name?: string, version?: string) {
  return JSON.stringify([kind, name, version]);
}

function revise(
  original: EcosystemManifest,
  changes: z.infer<typeof MetadataSchema>,
  version: string,
) {
  const result = structuredClone(original);
  const entries = validateEcosystemManifest(result);
  const byIdentity = new Map(
    entries.map((entry) => [
      identity(entry.asset.kind, entry.asset.name, entry.asset.version),
      entry,
    ]),
  );
  const metadata = new Map(Object.entries(changes));
  const keys = new Set(result.assets.map((asset) => asset.ecosystemKey));
  for (const key of metadata.keys()) {
    if (!keys.has(key)) throw new Error(`Unknown ecosystem key: ${key}`);
  }
  for (const asset of result.assets) {
    asset.name = metadata.get(asset.ecosystemKey)?.name ?? asset.name;
    if (["usecase", "workflow-template", "sandbox-script"].includes(asset.kind))
      asset.version = version;
  }

  function rebind(kind: EcosystemAssetKind, ref: Omit<SoftwareAssetRef, "kind">) {
    if (ref.id || ref.providerOrgId || (ref.source && ref.source !== "platform-fork")) return;
    const target = byIdentity.get(identity(kind, ref.name, ref.version));
    if (target) Object.assign(ref, { name: target.asset.name, version: target.asset.version });
    return target;
  }

  function reviseNodes(spec: workflowDsl.WorkflowSpec) {
    for (const draft of spec.nodeDrafts) {
      const node = workflowDsl.commandExecutionNode(draft) ?? draft;
      if (node.type === "SoftwareUsecaseComputing" && node.usecaseRef && node.softwareRef) {
        const target = rebind("usecase", node.usecaseRef);
        if (!target?.usecase) throw new Error(`Unresolved usecase on node ${node.id}`);
        rebind(
          target.usecase.software.kind === "Spack" ? "spack-package" : "site-runtime",
          node.softwareRef,
        );
        for (const hook of [node.hooks?.pre, node.hooks?.post]) {
          if (hook && "scriptRef" in hook) rebind("sandbox-script", hook.scriptRef);
        }
      } else if (node.type === "Script" && node.scriptRef) {
        rebind("sandbox-script", node.scriptRef);
      } else if (node.type === "Loop") {
        reviseNodes(node.body);
      } else if (node.type === "SubWorkflow" && node.ref.kind === "Inline") {
        reviseNodes(node.ref.body);
      }
    }
  }

  for (const entry of entries) {
    const asset = entry.asset;
    const change = metadata.get(asset.ecosystemKey) ?? {};
    if (change.domain !== undefined && asset.kind !== "usecase")
      throw new Error(`domain requires a usecase: ${asset.ecosystemKey}`);
    if (change.tags !== undefined && asset.kind !== "usecase" && asset.kind !== "data-product")
      throw new Error(`tags require a usecase or data product: ${asset.ecosystemKey}`);
    const payload = asset.payload;
    if (asset.kind === "workflow-template" || asset.kind === "usecase") {
      for (const refs of [payload.packageRefs, payload.usecaseRefs]) {
        for (const ref of (refs ?? []) as SoftwareAssetRef[]) rebind(ref.kind, ref);
      }
    }
    if (entry.usecase) {
      const spec = payload.spec as Record<string, unknown>;
      rebind(
        entry.usecase.software.kind === "Spack" ? "spack-package" : "site-runtime",
        spec.softwareRef as workflowDsl.AssetSelector,
      );
      for (const field of ["description", "tags", "domain"] as const) {
        if (change[field] !== undefined) spec[field] = change[field];
      }
      asset.specDigest = usecaseSpecDigest(spec);
    } else if (entry.workflow) {
      // Work on the input document: the validated DSL has expanded hooks and inserted defaults.
      // JSON round-trip also detaches YAML aliases shared by selectors and parameter defaults.
      const document: workflowDsl.Workflow = JSON.parse(
        JSON.stringify(parseYaml(payload.yamlContent as string)),
      );
      reviseNodes(document.spec);
      document.name = asset.name;
      if (change.description !== undefined) document.description = change.description;
      payload.yamlContent = JSON.stringify(document, null, 2);
    } else if (asset.kind === "data-product") {
      const data = payload.dataAsset as Record<string, unknown>;
      if (change.description !== undefined) data.description = change.description;
      if (change.tags !== undefined) data.tags = change.tags;
    } else if (change.description !== undefined) {
      if (asset.kind === "spack-package") {
        const spack = payload.spack as { metadata?: Record<string, unknown> };
        spack.metadata ??= {};
        spack.metadata.description = change.description;
      } else {
        asset.provenance.description = change.description;
      }
    }
  }
  result.version = version;
  validateEcosystemManifest(result);
  return result;
}

const [input, metadata, output, version] = process.argv.slice(2);
if (!input || !metadata || !output || !version)
  throw new Error("Expected manifest, metadata, output and version");
const bundle = await Bun.file(input).json();
const manifest = EcosystemManifestEnvelopeSchema.parse(bundle.manifest ?? bundle);
const revised = revise(manifest, MetadataSchema.parse(await Bun.file(metadata).json()), version);
const validated = EcosystemManifestEnvelopeSchema.parse(revised);
const tempDir = await mkdtemp(join(dirname(output), ".catalog-"));
try {
  const file = join(tempDir, "manifest.json");
  await writeFile(file, `${JSON.stringify(validated, null, 2)}\n`);
  await link(file, output);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SoftwareAssetPayloadSchema, workflowDsl } from "@kuintessence/shared";
import {
  type FederationAssetRef,
  FederationEnvironmentLockSchema,
  FederationInputManifestSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { stringify } from "yaml";
import { materializeFederationWorkflow } from "./materialize";

type Input = Parameters<typeof materializeFederationWorkflow>[0];
type Resolved = Awaited<ReturnType<Input["resolve"]>>;
const originSiteId = crypto.randomUUID();
const digest = `sha256:${"a".repeat(64)}`;
const contract = { name: "bash", version: "1" };
const selector = { source: "official-upstream", name: "gzip", version: "1.13" };
const sourceUsecase = crypto.randomUUID(),
  sourceSoftware = crypto.randomUUID();
const sourceScript = crypto.randomUUID(),
  sourceProfile = crypto.randomUUID();
const sourceChild = crypto.randomUUID();

function fixture(nodes: unknown[], parameters: unknown[] = []) {
  const entries = new Map<string, Resolved>();
  const references = new Map<string, FederationAssetRef>();
  function add(kind: FederationAssetRef["kind"], payload: unknown, name: string = kind) {
    const reference: FederationAssetRef = {
      originSiteId,
      kind,
      id: crypto.randomUUID(),
      revision: "1",
      digest,
    };
    const local: Resolved["local"] =
      kind === "dataset"
        ? {
            kind: "dataset",
            asset: { id: crypto.randomUUID() },
            version: { id: crypto.randomUUID() },
          }
        : {
            kind: "software",
            asset: {
              id: crypto.randomUUID(),
              name,
              source: "official-upstream",
              version: "1.13",
              providerOrgId: null,
            },
            revision: { id: crypto.randomUUID(), revision: 3 },
            payload: SoftwareAssetPayloadSchema.parse(payload),
          };
    entries.set(federationCanonicalJson(reference), { local });
    references.set(kind, reference);
    return { reference, local };
  }
  const sw = add("software", { kind: "spack-package", spack: { packageName: "gzip" } }, "gzip");
  const uc = add("usecase", {
    kind: "usecase",
    spec: {
      usecase: { commandFile: "gzip", inputSlots: [] },
      software: { kind: "Spack", name: "gzip", argumentList: [] },
      description: "Compression",
      domain: "utilities",
      tags: [],
      citations: [],
      softwareRef: selector,
      inputs: [],
      outputs: [],
      resources: {},
      materialMappings: [],
      licenseRequirements: [],
    },
  });
  const script = add("script", {
    kind: "sandbox-script",
    language: "bash",
    entrypoint: "main.sh",
    runtimeContractRef: contract,
    content: "printf ready",
    sha256: createHash("sha256").update("printf ready").digest("hex"),
  });
  const ds = add("dataset", null);
  const child = add("workflow", {
    kind: "workflow-template",
    yamlContent: stringify({
      name: "child",
      spec: { nodeDrafts: [{ type: "NoAction", id: "done", name: "done" }] },
    }),
  });
  const root = add("workflow", {
    kind: "workflow-template",
    yamlContent: stringify({ name: "Delegated workflow", parameters, spec: { nodeDrafts: nodes } }),
  });
  const input: Input = {
    template: root.reference,
    inputs: FederationInputManifestSchema.parse({
      protocolVersion: 1,
      kind: "inputs",
      parameters: {},
      datasets: [],
      bindings: [
        {
          sourceRevisionId: sourceUsecase,
          sourceSelector: { ...selector, name: "compress" },
          asset: uc.reference,
        },
        { sourceRevisionId: sourceSoftware, sourceSelector: selector, asset: sw.reference },
        {
          sourceRevisionId: sourceScript,
          sourceSelector: { ...selector, name: "script" },
          asset: script.reference,
        },
        { sourceRevisionId: sourceChild, asset: child.reference },
      ],
    }),
    environment: FederationEnvironmentLockSchema.parse({
      protocolVersion: 1,
      kind: "environment-lock",
      target: { platform: "linux", architecture: "x86_64" },
      nativeLockDigest: digest,
      software: [{ asset: sw.reference, concreteSpec: "gzip@1.13/abcdefg", dagHash: "abcdefg" }],
      sandboxRuntime: { kind: "OCI", digest },
      runtimeBindings: [{ sourceProfileId: sourceProfile, contract }],
    }),
    resolve: async (ref) => {
      const value = entries.get(federationCanonicalJson(ref));
      if (!value) throw new Error("missing authorized revision");
      return value;
    },
  };
  return { input, sw, uc, script, ds, child, root, entries, add };
}
function computing(extra: Record<string, unknown> = {}) {
  return {
    type: "SoftwareUsecaseComputing",
    id: "compute",
    name: "Compute",
    usecaseVersionId: sourceUsecase,
    softwareVersionId: sourceSoftware,
    ...extra,
  };
}

test("pins named and UUID references, parameters and dataset inputs without rewriting original payloads", async () => {
  const f = fixture(
    [
      computing({
        usecaseVersionId: undefined,
        softwareVersionId: undefined,
        usecaseRef: { ...selector, name: "compress" },
        softwareRef: selector,
        inputSlots: [
          { type: "Dataset", descriptor: "reads" },
          { type: "Text", descriptor: "label", from: { param: "label" } },
        ],
      }),
    ],
    [{ name: "label", type: "string", required: true }],
  );
  f.input.inputs.parameters.label = sourceUsecase;
  f.input.inputs.datasets.push({
    descriptor: "reads",
    asset: f.ds.reference,
    selectedEntries: ["reads.txt"],
    targetPath: "input",
  });
  const before = federationCanonicalJson([...f.entries]);
  const result = await materializeFederationWorkflow(f.input);
  const node = result.workflow.spec.nodeDrafts[0];
  expect(node).toMatchObject({
    usecaseVersionId: f.uc.local.kind === "software" ? f.uc.local.revision.id : "",
    softwareVersionId: f.sw.local.kind === "software" ? f.sw.local.revision.id : "",
  });
  expect(node && "inputSlots" in node ? node.inputSlots?.[0] : null).toMatchObject({
    contents: {
      source: "data-market",
      assetId: f.ds.local.asset.id,
      manifestDigest: digest,
      selectedEntries: ["reads.txt"],
      targetPath: "input",
    },
  });
  expect(result.workflow.parameters[0]?.default).toBe(sourceUsecase);
  expect(federationCanonicalJson([...f.entries])).toBe(before);
});

test("visits loop/inline scopes and pins ByVersion subworkflows without querying latest", async () => {
  const f = fixture([
    {
      type: "Loop",
      id: "loop",
      name: "Loop",
      mode: "ForEach",
      maxIterations: 2,
      over: { expr: "[1, 2]" },
      body: {
        nodeDrafts: [
          {
            type: "SubWorkflow",
            id: "nested",
            name: "Nested",
            maxDepth: 2,
            ref: { kind: "Inline", body: { nodeDrafts: [computing()] } },
          },
        ],
      },
    },
    {
      type: "SubWorkflow",
      id: "versioned",
      name: "Versioned",
      maxDepth: 2,
      ref: { kind: "ByVersion", workflowVersionId: sourceChild },
    },
  ]);
  const result = await materializeFederationWorkflow(f.input);
  const localChild = f.child.local.kind === "software" ? f.child.local.revision.id : "";
  expect(result.workflowVersions[localChild]?.name).toBe("child");
  expect(result.workflow.spec.nodeDrafts[1]).toMatchObject({
    ref: { workflowVersionId: localChild },
  });
  expect(JSON.stringify(result.workflow.spec)).not.toContain(sourceUsecase);
  expect(workflowDsl.validateWorkflow(result.workflow)).toEqual([]);
});

test("bounds recursive ByVersion graphs without expanding recursion into the document", async () => {
  const f = fixture([
    {
      type: "SubWorkflow",
      id: "again",
      name: "Again",
      maxDepth: 2,
      ref: { kind: "ByVersion", workflowVersionId: sourceChild },
    },
  ]);
  f.input.inputs.bindings = [{ sourceRevisionId: sourceChild, asset: f.root.reference }];
  const result = await materializeFederationWorkflow(f.input);
  expect(Object.keys(result.workflowVersions)).toHaveLength(1);
});

test("converts source runtime profile into a contract and preserves script content literally", async () => {
  const f = fixture([
    {
      type: "Script",
      id: "script",
      name: "script",
      source: { type: "Inline", language: "bash", content: `echo '${sourceSoftware}'` },
      runtimeProfileId: sourceProfile,
    },
  ]);
  const node = (await materializeFederationWorkflow(f.input)).workflow.spec.nodeDrafts[0];
  expect(node).toMatchObject({
    runtimeContractRef: contract,
    source: { content: `echo '${sourceSoftware}'` },
  });
  expect(node && "runtimeProfileId" in node ? node.runtimeProfileId : undefined).toBeUndefined();
  f.input.environment.runtimeBindings = [];
  await expect(materializeFederationWorkflow(f.input)).rejects.toMatchObject({
    path: "spec.script.runtime",
  });
});

test("wraps a standalone immutable script and validates its required input contract", async () => {
  const f = fixture([]);
  const script = f.add("script", {
    kind: "sandbox-script",
    language: "bash",
    entrypoint: "main.sh",
    runtimeContractRef: contract,
    content: "echo ready",
    sha256: "b".repeat(64),
    inputs: { count: { type: "Text", required: true } },
  });
  f.input.template = script.reference;
  await expect(materializeFederationWorkflow(f.input)).rejects.toMatchObject({
    path: "parameters.count",
  });
  f.input.inputs.parameters = { count: "2" };
  const result = await materializeFederationWorkflow(f.input);
  expect(result.workflow.spec.nodeDrafts[0]).toMatchObject({
    type: "Script",
    source: { type: "AssetRevision", assetId: script.local.asset.id },
    executionIdentity: { type: "Inherit" },
  });
});

test("rejects unmapped IDs, absent software locks, unused datasets and unknown parameters", async () => {
  const f = fixture([computing()]);
  f.input.inputs.bindings = [];
  await expect(materializeFederationWorkflow(f.input)).rejects.toMatchObject({
    path: "spec.compute.usecase",
  });
  const g = fixture([computing()]);
  g.input.environment.software = [];
  await expect(materializeFederationWorkflow(g.input)).rejects.toMatchObject({
    path: "spec.compute.software",
  });
  const h = fixture([]);
  h.input.inputs.datasets = [{ descriptor: "unused", asset: h.ds.reference, selectedEntries: [] }];
  await expect(materializeFederationWorkflow(h.input)).rejects.toMatchObject({
    path: "datasets.unused",
  });
  h.input.inputs.datasets = [];
  h.input.inputs.parameters.unused = 1;
  await expect(materializeFederationWorkflow(h.input)).rejects.toMatchObject({
    path: "parameters.unused",
  });
});

test("does not trust source-local scheduling, identity, placement, output locations or file records", async () => {
  const script = {
    type: "Script",
    id: "script",
    name: "script",
    source: { type: "Inline", language: "bash", content: "true" },
    runtimeContractRef: contract,
  };
  for (const override of [
    { schedulingStrategy: { type: "Manual", queues: [crypto.randomUUID()] } },
    { executionIdentity: { type: "MappedAccount", mappingId: crypto.randomUUID() } },
    { placementConstraint: { clusterIds: [crypto.randomUUID()] } },
    {
      outputs: {
        result: { type: "File", locality: { type: "TargetStorage", storageId: "source-store" } },
      },
    },
    {
      inputSlots: [
        {
          type: "File",
          descriptor: "input",
          contents: [
            { fileMetadataId: crypto.randomUUID(), fileMetadataName: "input", hash: "a", size: 1 },
          ],
        },
      ],
    },
  ])
    await expect(
      materializeFederationWorkflow(fixture([{ ...script, ...override }]).input),
    ).rejects.toThrow();
});

test("rejects file ID injection through parameters even when the parameter itself is valid JSON", async () => {
  const f = fixture(
    [computing({ inputSlots: [{ type: "File", descriptor: "input", from: { param: "input" } }] })],
    [{ name: "input", type: "json" }],
  );
  f.input.inputs.parameters = {
    input: { fileMetadataId: crypto.randomUUID(), fileMetadataName: "secret" },
  };
  await expect(materializeFederationWorkflow(f.input)).rejects.toMatchObject({
    path: "spec.compute.inputs.input",
  });
});

test("enforces static validation despite the sender's bypass flag and validates parameter types", async () => {
  const f = fixture([]);
  const invalid = f.add("workflow", {
    kind: "workflow-template",
    yamlContent: stringify({
      name: "invalid",
      advanced: { skipStaticValidation: true },
      spec: {
        nodeDrafts: [],
        nodeRelations: [{ fromId: "missing", toId: "other", slotRelations: [] }],
      },
    }),
  });
  f.input.template = invalid.reference;
  await expect(materializeFederationWorkflow(f.input)).rejects.toMatchObject({ path: "template" });
  const g = fixture([], [{ name: "count", type: "int", required: true }]);
  for (const value of ["2", 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    g.input.inputs.parameters.count = value;
    await expect(materializeFederationWorkflow(g.input)).rejects.toMatchObject({
      path: "parameters.count",
    });
  }
});

test("pins named scripts and refuses a changed hash or runtime contract", async () => {
  const f = fixture([
    {
      type: "Script",
      id: "script",
      name: "script",
      scriptRef: { ...selector, name: "script" },
      runtimeContractRef: contract,
    },
  ]);
  const result = await materializeFederationWorkflow(f.input);
  expect(result.workflow.spec.nodeDrafts[0]).toMatchObject({
    source: { assetId: f.script.local.asset.id },
    runtimeContractRef: contract,
  });
  const mismatch = f.add("workflow", {
    kind: "workflow-template",
    yamlContent: stringify({
      name: "mismatch",
      spec: {
        nodeDrafts: [
          {
            type: "Script",
            id: "script",
            name: "script",
            scriptRef: { ...selector, name: "script" },
            runtimeContractRef: { name: "other", version: "1" },
          },
        ],
      },
    }),
  });
  f.input.template = mismatch.reference;
  await expect(materializeFederationWorkflow(f.input)).rejects.toMatchObject({
    path: "spec.script.runtime",
  });
  const changed = f.add("workflow", {
    kind: "workflow-template",
    yamlContent: stringify({
      name: "changed",
      spec: {
        nodeDrafts: [
          {
            type: "Script",
            id: "script",
            name: "script",
            runtimeContractRef: contract,
            source: {
              type: "AssetRevision",
              assetId: f.script.reference.id,
              assetRevisionId: sourceScript,
              revision: 1,
              sha256: "c".repeat(64),
            },
          },
        ],
      },
    }),
  });
  f.input.template = changed.reference;
  await expect(materializeFederationWorkflow(f.input)).rejects.toMatchObject({
    path: "spec.script.source",
  });
});

test("uses the script I/O contract to reject file parameters hidden behind Text slots", async () => {
  const f = fixture(
    [
      {
        type: "Script",
        id: "script",
        name: "script",
        source: { type: "Inline", language: "bash", content: "true" },
        runtimeContractRef: contract,
        inputs: { input: { type: "File" } },
        inputSlots: [{ type: "Text", descriptor: "input", from: { param: "input" } }],
      },
    ],
    [{ name: "input", type: "json" }],
  );
  f.input.inputs.parameters = {
    input: { fileMetadataId: crypto.randomUUID(), fileMetadataName: "secret" },
  };
  await expect(materializeFederationWorkflow(f.input)).rejects.toMatchObject({
    path: "spec.script.inputs.input",
  });
});

function receivedFileInputs(
  type: "File" | "FileBatch" = "File",
  empty = false,
): NonNullable<Input["receivedInputs"]> {
  return {
    importId: crypto.randomUUID(),
    manifestDigest: digest,
    inputs: [
      {
        descriptor: "input",
        type,
        files: empty
          ? []
          : [
              {
                path: "nested/input.dat",
                fileId: crypto.randomUUID(),
                generation: crypto.randomUUID(),
                storageKey: "federation-inputs/private",
                versionId: "pinned",
                etag: "etag",
                sha256: "a".repeat(64),
                sizeBytes: 4,
              },
            ],
      },
    ],
  };
}

test("projects received files into workflow slots and parameters without mutating source templates", async () => {
  const f = fixture(
    [computing({ inputSlots: [{ descriptor: "input", type: "File", from: { param: "input" } }] })],
    [{ name: "input", type: "json", required: true }],
  );
  f.input.receivedInputs = receivedFileInputs();
  const before = JSON.stringify(f.root.local);
  const result = await materializeFederationWorkflow(f.input);
  const fileId = f.input.receivedInputs.inputs[0]?.files[0]?.fileId;
  expect(result.workflow.parameters[0]?.default).toMatchObject({
    fileMetadataId: fileId,
    fileMetadataName: "nested/input.dat",
  });
  expect(result.workflow.spec.nodeDrafts[0]).toMatchObject({
    inputSlots: [
      { type: "File", contents: [{ fileMetadataId: fileId, size: 4, hash: "a".repeat(64) }] },
    ],
  });
  expect(JSON.stringify(f.root.local)).toBe(before);
  expect(JSON.stringify(result)).not.toContain("storageKey");
  expect(JSON.stringify(result)).not.toContain("versionId");
});

test("standalone scripts consume typed received File and empty FileBatch inputs", async () => {
  for (const [type, empty] of [
    ["File", false],
    ["FileBatch", false],
    ["FileBatch", true],
  ] as const) {
    const f = fixture([]);
    const script = f.add("script", {
      kind: "sandbox-script",
      language: "bash",
      content: "true",
      entrypoint: "main.sh",
      sha256: createHash("sha256").update("true").digest("hex"),
      runtimeContractRef: contract,
      inputs: { input: { type, required: true }, absent: { type: "File", required: false } },
    });
    f.input.template = script.reference;
    f.input.receivedInputs = receivedFileInputs(type, empty);
    const result = await materializeFederationWorkflow(f.input);
    expect(result.workflow.spec.nodeDrafts[0]).toMatchObject({
      inputSlots: [{ descriptor: "input", type: "File", isBatch: type === "FileBatch" }],
    });
    expect(result.workflow.parameters).toEqual([]);
    if (empty)
      expect(result.workflow.spec.nodeDrafts[0]).toMatchObject({ inputSlots: [{ contents: [] }] });
    else if (type === "FileBatch")
      expect(result.workflow.spec.nodeDrafts[0]).toMatchObject({
        inputSlots: [{ contents: [{ relativePath: "nested/input.dat" }] }],
      });
  }
});

test("received files cannot replace upstream bindings, foreign records, mismatched types or arbitrary expressions", async () => {
  for (const slot of [
    { descriptor: "other", type: "File" },
    { descriptor: "input", type: "File", isBatch: true },
    { descriptor: "input", type: "File", from: { expr: "params.input" } },
    { descriptor: "input", type: "File", from: { param: "other" } },
    {
      descriptor: "input",
      type: "File",
      contents: [
        { fileMetadataId: crypto.randomUUID(), fileMetadataName: "foreign", hash: "a", size: 4 },
      ],
    },
  ]) {
    const f = fixture(
      [computing({ inputSlots: [slot] })],
      [
        { name: "input", type: "json" },
        { name: "other", type: "json" },
      ],
    );
    f.input.receivedInputs = receivedFileInputs();
    await expect(materializeFederationWorkflow(f.input)).rejects.toThrow();
  }
  const f = fixture(
    [computing({ inputSlots: [{ descriptor: "input", type: "File", from: { param: "input" } }] })],
    [{ name: "input", type: "json" }],
  );
  f.input.receivedInputs = receivedFileInputs();
  f.input.inputs.parameters.input = "foreign-file";
  await expect(materializeFederationWorkflow(f.input)).rejects.toThrow("scalar override");
});

test("received batch selection must agree with a Script input declaration", async () => {
  const f = fixture(
    [
      {
        type: "Script",
        id: "script",
        name: "script",
        source: { type: "Inline", language: "bash", content: "true" },
        runtimeContractRef: contract,
        inputs: { input: { type: "File" } },
        inputSlots: [
          { descriptor: "input", type: "File", isBatch: true, from: { param: "input" } },
        ],
      },
    ],
    [{ name: "input", type: "json" }],
  );
  f.input.receivedInputs = receivedFileInputs("FileBatch");
  await expect(materializeFederationWorkflow(f.input)).rejects.toThrow("script I/O contract");
});

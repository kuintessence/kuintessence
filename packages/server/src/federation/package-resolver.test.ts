import { expect, test } from "bun:test";
import type { federationWorkflowBindings } from "@kuintessence/db";
import {
  createUsecaseExecutor,
  type JobSubmission,
  SPACK_PINNED_EXECUTION_PLACEHOLDER,
  usecase,
  workflowDsl,
} from "@kuintessence/shared";
import type { FederationAssetRef } from "@kuintessence/shared/federation";
import type { DatasetPreflightDeps } from "../workflow/dataset-preflight";
import type { FederationAssetService } from "./assets";
import { createFederationDatasetPreflight } from "./dataset-preflight";
import { createFederationPackageResolver } from "./package-resolver";
import { testAgreement, testDelegation } from "./test-fixtures";

type Snapshot = typeof federationWorkflowBindings.$inferSelect.snapshot;
function fixture() {
  const source = crypto.randomUUID(),
    target = crypto.randomUUID();
  const softwareId = crypto.randomUUID(),
    usecaseId = crypto.randomUUID(),
    packageId = crypto.randomUUID();
  const softwareRevision = crypto.randomUUID(),
    usecaseRevision = crypto.randomUUID();
  const identity = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() };
  const ref = (kind: FederationAssetRef["kind"]): FederationAssetRef => ({
    kind,
    originSiteId: source,
    id: crypto.randomUUID(),
    revision: "1",
    digest: `sha256:${"e".repeat(64)}`,
  });
  const sw = ref("software"),
    uc = ref("usecase");
  const pin = {
    dagHash: "a".repeat(32),
    manifestDigest: `sha256:${"b".repeat(64)}`,
    lockfileDigest: `sha256:${"c".repeat(64)}`,
    spackVersion: "1.0.0" as const,
    target: "linux-ubuntu24.04-x86_64",
  };
  const spec = usecase.GovernedUsecasePackageSchema.parse({
    description: "Hello",
    domain: "test",
    tags: [],
    citations: [],
    softwareRef: { source: "official-upstream", name: "hello", version: "1.0" },
    inputs: [],
    outputs: [],
    resources: { memoryMiB: 64 },
    materialMappings: [],
    licenseRequirements: [],
    usecase: { commandFile: "hello", inputSlots: [] },
    software: { kind: "Spack", name: "hello", argumentList: ["+mpi"] },
    arguments: [],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [],
  });
  const mappings = [
    { reference: uc, mappingId: crypto.randomUUID(), localRevisionId: usecaseRevision },
    { reference: sw, mappingId: crypto.randomUUID(), localRevisionId: softwareRevision },
  ];
  const snapshot: Snapshot = {
    request: testDelegation(testAgreement(source, target)),
    requestDigest: sw.digest,
    identity,
    workflow: workflowDsl.WorkflowSchema.parse({ name: "Hello", spec: { nodeDrafts: [] } }),
    workflowVersions: {},
    inputs: {
      kind: "inputs",
      protocolVersion: 1,
      parameters: {},
      datasets: [],
      bindings: [{ sourceSelector: spec.softwareRef, asset: sw }],
    },
    environment: {
      kind: "environment-lock",
      protocolVersion: 1,
      target: { platform: "linux", architecture: "x86_64" },
      nativeLockDigest: pin.lockfileDigest,
      software: [
        { asset: sw, concreteSpec: "hello@1.0 +mpi", dagHash: pin.dagHash, executionPin: pin },
      ],
    },
    mappings,
  };
  const authorizations: string[] = [];
  let deny = false,
    missingPackage = false;
  const assets: Pick<FederationAssetService, "resolve"> = {
    resolve: async (principal, reference) => {
      expect(principal).toEqual(identity);
      authorizations.push(reference.kind);
      if (deny) throw new Error("local grant revoked");
      const isSoftware = reference.kind === "software";
      return {
        mapping: { id: isSoftware ? mappings[1]?.mappingId : mappings[0]?.mappingId },
        local: {
          kind: "software",
          asset: {
            id: isSoftware ? softwareId : usecaseId,
            source: "sp-published",
            name: isSoftware ? "hello" : "hello-usecase",
            version: "1.0",
            providerOrgId: identity.orgId,
          },
          revision: {
            id: isSoftware ? softwareRevision : usecaseRevision,
            recipeSha256: null,
            contentSha256: null,
          },
          payload: isSoftware
            ? { kind: "spack-package", spack: { packageName: "hello", defaultSpec: "hello@1.0" } }
            : { kind: "usecase", spec },
        },
      } as Awaited<ReturnType<FederationAssetService["resolve"]>>;
    },
  };
  const installChecks: string[] = [];
  const resolver = () =>
    createFederationPackageResolver(
      snapshot,
      assets,
      {
        getById: async () => ({ spec, ...(missingPackage ? {} : { usecasePackageId: packageId }) }),
      },
      async (id, selectedSpec) => {
        expect(id).toBe(softwareId);
        installChecks.push(selectedSpec);
        return true;
      },
    );
  return {
    snapshot,
    assets,
    pin,
    spec,
    resolver,
    authorizations,
    installChecks,
    softwareRevision,
    usecaseRevision,
    packageId,
    deny: () => {
      deny = true;
    },
    missingPackage: () => {
      missingPackage = true;
    },
  };
}

test("an approved selector alias carries the exact environment pin through the real usecase executor", async () => {
  const f = fixture();
  let submitted: JobSubmission | undefined;
  const execute = createUsecaseExecutor({
    deferSpackActivation: true,
    resolvePackage: f.resolver(),
    submitJob: async (spec) => {
      submitted = spec;
      return { jobId: "job", status: "completed", collected: {} };
    },
  });
  const node = workflowDsl.WorkflowNodeSchema.parse({
    type: "SoftwareUsecaseComputing",
    id: "hello",
    name: "hello",
    usecaseVersionId: f.usecaseRevision,
    softwareVersionId: f.softwareRevision,
  });
  await execute(node, { params: {}, nodes: {} });
  expect(submitted).toMatchObject({
    command: SPACK_PINNED_EXECUTION_PLACEHOLDER,
    usecasePackageId: f.packageId,
    spackExecution: { spec: "hello@1.0 +mpi", pin: f.pin },
    softwareRequirements: [{ spec: "hello@1.0 +mpi", installable: true }],
  });
  expect(f.authorizations.sort()).toEqual(["software", "usecase"]);
  expect(f.installChecks).toEqual(["hello@1.0 +mpi"]);
});

test.each([
  "no-pin",
  "no-alias",
  "no-package",
  "different-spec",
  "revoked",
  "unmapped",
] as const)("refuses %s before installation permission can be reused", async (scenario) => {
  const f = fixture();
  const entry = f.snapshot.environment.software[0];
  if (!entry) throw new Error("Missing lock entry");
  if (scenario === "no-pin") delete entry.executionPin;
  if (scenario === "no-alias") f.snapshot.inputs.bindings = [];
  if (scenario === "no-package") f.missingPackage();
  if (scenario === "different-spec") entry.concreteSpec = "hello@2.0";
  if (scenario === "revoked") f.deny();
  await expect(
    f.resolver()(
      f.usecaseRevision,
      scenario === "unmapped" ? crypto.randomUUID() : f.softwareRevision,
    ),
  ).rejects.toThrow();
  expect(f.installChecks).toEqual([]);
});

test.each([
  "allowed",
  "missing-child",
  "wrong-identity",
  "data-denied",
  "usecase-revoked",
  "changed-workflow",
] as const)("federation dataset preflight uses immutable nested definitions and local grants: %s", async (scenario) => {
  const f = fixture();
  const childId = crypto.randomUUID();
  const data = {
    source: "data-market" as const,
    assetId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    manifestDigest: `sha256:${"d".repeat(64)}`,
    selectedEntries: ["input.txt"],
  };
  f.spec.inputs = [{ descriptor: "input", type: "Dataset", required: true }];
  f.snapshot.workflow = workflowDsl.WorkflowSchema.parse({
    name: "Parent",
    spec: {
      nodeDrafts: [
        {
          type: "SubWorkflow",
          id: "child",
          name: "Child",
          maxDepth: 2,
          ref: { kind: "ByVersion", workflowVersionId: childId },
        },
      ],
    },
  });
  f.snapshot.workflowVersions[childId] = workflowDsl.WorkflowSchema.parse({
    name: "Frozen child",
    spec: {
      nodeDrafts: [
        {
          type: "Loop",
          id: "repeat",
          name: "Repeat",
          mode: "ForEach",
          maxIterations: 1,
          over: { expr: "[1]", lang: "cel" },
          body: {
            nodeDrafts: [
              {
                type: "SoftwareUsecaseComputing",
                id: "hello",
                name: "Hello",
                usecaseVersionId: f.usecaseRevision,
                softwareVersionId: f.softwareRevision,
                inputSlots: [
                  { type: "Dataset", descriptor: "input", optional: false, contents: data },
                ],
              },
            ],
          },
        },
      ],
    },
  });
  const calls: string[] = [];
  const deps: DatasetPreflightDeps = {
    loadUsecasePackage: async () => {
      throw new Error("Mutable package lookup must not run");
    },
    resolveWorkflowVersion: async () => {
      throw new Error("Mutable child lookup must not run");
    },
    assertUsecaseExecutionAccess: async (input) => {
      expect(input).toMatchObject({
        usecaseVersionId: f.usecaseRevision,
        requester: f.snapshot.identity,
      });
      calls.push("usecase");
    },
    verifyAccess: async (input) => {
      expect(input).toEqual({
        actorUserId: f.snapshot.identity.userId,
        orgId: f.snapshot.identity.orgId,
        assetId: data.assetId,
        versionId: data.versionId,
      });
      calls.push("dataset");
      return scenario !== "data-denied";
    },
    validateUsecase: async (input) => {
      expect(input.pkg).toEqual(f.spec);
      expect(input.dataInputs).toEqual({ input: data });
      calls.push("shape");
    },
  };
  if (scenario === "missing-child") delete f.snapshot.workflowVersions[childId];
  if (scenario === "usecase-revoked") f.deny();
  const workflow =
    scenario === "changed-workflow"
      ? { ...f.snapshot.workflow, name: "Changed" }
      : f.snapshot.workflow;
  const principal = {
    ...f.snapshot.identity,
    ...(scenario === "wrong-identity" ? { userId: crypto.randomUUID() } : {}),
  };
  const validate = createFederationDatasetPreflight(f.snapshot, f.assets, deps);
  if (scenario === "allowed") {
    await validate(workflow, principal);
    expect(calls).toEqual(["usecase", "dataset", "shape"]);
    expect(f.authorizations).toEqual(["usecase"]);
  } else {
    await expect(validate(workflow, principal)).rejects.toThrow();
    expect(calls).not.toContain("shape");
  }
});

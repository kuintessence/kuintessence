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
import type { FederationAssetService } from "./assets";
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

import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentDataRoots,
  createLocalDatasetAttestation,
  validateDataDeliveryPlan,
} from "./local-data-security";

const MANAGED_ROOT_ID = "11111111-1111-4111-8111-111111111111";

async function rootsFixture() {
  const root = await mkdtemp(join(tmpdir(), "kq-data-market-"));
  const datasetRoot = join(root, "datasets");
  const jobWorkRoot = join(root, "jobs");
  const restrictedRoot = join(root, "restricted");
  await mkdir(restrictedRoot, { mode: 0o700 });
  return { root, datasetRoot, jobWorkRoot, restrictedRoot };
}

describe("AgentDataRoots", () => {
  test("creates a fixed private job root below the Agent-managed parent", async () => {
    const { datasetRoot, jobWorkRoot, restrictedRoot } = await rootsFixture();
    const roots = new AgentDataRoots({
      datasetRoot,
      managedRoots: {},
      jobWorkRoot,
      restrictedRoots: [restrictedRoot],
    });
    await roots.initialize();
    const schedulerLogDir = await roots.prepareSchedulerLogDir();
    expect(schedulerLogDir.endsWith("/jobs/.scheduler-logs")).toBe(true);
    expect((await lstat(schedulerLogDir)).mode & 0o077).toBe(0);
    const jobRoot = await roots.prepareJobRoot("job-42");
    expect(jobRoot.endsWith("/jobs/job-42")).toBe(true);
    expect((await lstat(jobRoot)).mode & 0o077).toBe(0);
    await expect(roots.prepareJobRoot("../outside")).rejects.toThrow("invalid");
    await roots.removeJobRoot("job-42");
    await expect(lstat(jobRoot)).rejects.toThrow();
  });

  test("rejects overlapping dataset and job roots", async () => {
    const { datasetRoot } = await rootsFixture();
    const roots = new AgentDataRoots({
      datasetRoot,
      managedRoots: {},
      jobWorkRoot: datasetRoot,
    });
    await expect(roots.initialize()).rejects.toThrow("must not overlap");
  });

  test("builds a deterministic per-file manifest and local attestation", async () => {
    const { datasetRoot, jobWorkRoot, restrictedRoot } = await rootsFixture();
    await mkdir(join(datasetRoot, "registered", "dataset", "nested"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(datasetRoot, "registered", "dataset", "b.txt"), "beta");
    await writeFile(join(datasetRoot, "registered", "dataset", "nested", "a.txt"), "alpha");
    const roots = new AgentDataRoots({
      datasetRoot,
      managedRoots: { [MANAGED_ROOT_ID]: "registered" },
      jobWorkRoot,
      restrictedRoots: [restrictedRoot],
    });
    await roots.initialize();
    const manifest = await roots.scanManagedDataset(MANAGED_ROOT_ID, "dataset");
    expect(manifest.files.map((file) => file.path)).toEqual(["b.txt", "nested/a.txt"]);
    expect(manifest.files.every((file) => file.sha256.length === 64)).toBe(true);
    expect(manifest.merkleRoot).toHaveLength(64);
    const attestation = createLocalDatasetAttestation(manifest);
    expect(attestation.algorithm).toBe("sha256");
    expect(attestation.manifestDigest).toHaveLength(64);
  });

  test("fails closed when a managed dataset contains a symbolic link", async () => {
    const { datasetRoot, jobWorkRoot, restrictedRoot } = await rootsFixture();
    await mkdir(join(datasetRoot, "registered", "dataset"), { recursive: true, mode: 0o700 });
    const outside = join(datasetRoot, "outside.txt");
    await writeFile(outside, "outside");
    await symlink(outside, join(datasetRoot, "registered", "dataset", "linked.txt"));
    const roots = new AgentDataRoots({
      datasetRoot,
      managedRoots: { [MANAGED_ROOT_ID]: "registered" },
      jobWorkRoot,
      restrictedRoots: [restrictedRoot],
    });
    await roots.initialize();
    await expect(roots.scanManagedDataset(MANAGED_ROOT_ID, "dataset")).rejects.toThrow(
      "symbolic link",
    );
  });

  test("rejects a requested managed root that is not configured locally", async () => {
    const { datasetRoot, jobWorkRoot } = await rootsFixture();
    await mkdir(join(datasetRoot, "registered", "dataset"), { recursive: true, mode: 0o700 });
    const roots = new AgentDataRoots({
      datasetRoot,
      managedRoots: { [MANAGED_ROOT_ID]: "registered" },
      jobWorkRoot,
    });
    await roots.initialize();
    await expect(
      roots.scanManagedDataset("22222222-2222-4222-8222-222222222222", "dataset"),
    ).rejects.toThrow("managedRootId");
  });
});

describe("validateDataDeliveryPlan", () => {
  const capabilities = {
    objectDownload: true,
    stageCopy: true,
    readonlyMount: { enabled: true, trusted: false },
  };

  test("allows supported object-download and stage-copy plans", () => {
    expect(() =>
      validateDataDeliveryPlan(
        {
          method: "object-download",
          datasetPath: "dataset",
          targetPath: "inputs",
          restricted: true,
        },
        capabilities,
      ),
    ).not.toThrow();
    expect(() =>
      validateDataDeliveryPlan(
        { method: "stage-copy", datasetPath: "dataset", targetPath: "inputs", restricted: false },
        capabilities,
      ),
    ).not.toThrow();
  });

  test("fails closed for restricted readonly mounts without a trusted capability", () => {
    expect(() =>
      validateDataDeliveryPlan(
        {
          method: "readonly-mount",
          datasetPath: "dataset",
          targetPath: "inputs",
          restricted: true,
        },
        capabilities,
      ),
    ).toThrow("trusted readonly mount");
  });

  test("rejects delivery traversal", () => {
    expect(() =>
      validateDataDeliveryPlan(
        {
          method: "object-download",
          datasetPath: "../dataset",
          targetPath: "inputs",
          restricted: false,
        },
        capabilities,
      ),
    ).toThrow("parent traversal");
  });
});

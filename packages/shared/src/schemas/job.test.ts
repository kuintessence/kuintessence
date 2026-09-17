import { describe, expect, test } from "bun:test";
import { JobSubmitSchema, StagePathSchema } from "./job";

describe("StagePathSchema", () => {
  test("accepts run-dir-relative paths", () => {
    expect(StagePathSchema.safeParse("mesh.tar.gz").success).toBe(true);
    expect(StagePathSchema.safeParse("inputs/data.csv").success).toBe(true);
    expect(StagePathSchema.safeParse("a..b.txt").success).toBe(true);
    // Spaces are legitimate in filenames and stay allowed.
    expect(StagePathSchema.safeParse("my input.csv").success).toBe(true);
  });

  test("rejects '..' path segments (run-dir escape)", () => {
    expect(StagePathSchema.safeParse("../etc/passwd").success).toBe(false);
    expect(StagePathSchema.safeParse("a/../../b").success).toBe(false);
  });

  test("rejects control characters and empties", () => {
    expect(StagePathSchema.safeParse("a\u0001b").success).toBe(false);
    expect(StagePathSchema.safeParse("a\nb").success).toBe(false);
    expect(StagePathSchema.safeParse("").success).toBe(false);
  });
});

describe("JobSubmitSchema", () => {
  test("accepts valid job submission", () => {
    const valid = {
      name: "wrf-ensemble-01",
      command: "sbatch run.sh",
      resources: {
        cpus: 4,
        memoryMb: 8192,
      },
    };
    const result = JobSubmitSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("rejects submission without name", () => {
    const invalid = {
      command: "sbatch run.sh",
      resources: { cpus: 4, memoryMb: 8192 },
    };
    const result = JobSubmitSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects negative cpu count", () => {
    const invalid = {
      name: "test",
      command: "echo hi",
      resources: { cpus: -1, memoryMb: 1024 },
    };
    const result = JobSubmitSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects a job whose inputStaging has a traversal stagePath", () => {
    const result = JobSubmitSchema.safeParse({
      name: "t",
      command: "echo hi",
      resources: { cpus: 1, memoryMb: 1024 },
      inputStaging: [{ fileMetadataId: "fm-1", stagePath: "../../etc/cron.d/x" }],
    });
    expect(result.success).toBe(false);
  });

  test("accepts a queue scheduling strategy", () => {
    const parsed = JobSubmitSchema.parse({
      name: "queued",
      command: "sbatch run.sh",
      resources: { cpus: 2, memoryMb: 2048 },
      schedulingStrategy: { queueId: "example-slurm-batch" },
    });
    expect(parsed.schedulingStrategy?.queueId).toBe("example-slurm-batch");
  });

  test("accepts preferred queue scheduling strategy", () => {
    const parsed = JobSubmitSchema.parse({
      name: "preferred",
      command: "sbatch run.sh",
      resources: { cpus: 2, memoryMb: 2048 },
      schedulingStrategy: { preferredQueueIds: ["example-slurm-fast", "example-slurm-backup"] },
    });
    expect(parsed.schedulingStrategy?.preferredQueueIds).toEqual([
      "example-slurm-fast",
      "example-slurm-backup",
    ]);
  });

  test("accepts a canonical software asset identity", () => {
    const parsed = JobSubmitSchema.parse({
      name: "frozen-software",
      command: "spack find --loaded",
      resources: { cpus: 1, memoryMb: 1024 },
      softwareRequirements: [
        {
          assetId: "00000000-0000-4000-8000-000000000001",
          name: "zlib",
          version: "1.3.1",
        },
      ],
    });
    expect(parsed.softwareRequirements?.[0]).toEqual({
      assetId: "00000000-0000-4000-8000-000000000001",
      name: "zlib",
      version: "1.3.1",
      installable: false,
    });
  });

  test("accepts dataset and legacy file references outside the executable input contract", () => {
    const parsed = JobSubmitSchema.parse({
      name: "data-bound",
      command: "sbatch run.sh",
      resources: { cpus: 2, memoryMb: 2048 },
      dataInputs: {
        dataset: {
          source: "data-market",
          assetId: "00000000-0000-4000-8000-000000000001",
          versionId: "00000000-0000-4000-8000-000000000002",
          manifestDigest: "sha256:manifest",
        },
        legacy: {
          fileMetadataId: "00000000-0000-4000-8000-000000000002",
          fileMetadataName: "legacy.csv",
        },
      },
      dataRequirements: { dataset: { acceptedFormats: ["csv"] } },
    });

    expect(parsed.dataInputs?.dataset).toMatchObject({ source: "data-market" });
    expect(parsed.dataInputs?.legacy).toMatchObject({
      source: "netdrive",
      fileMetadataName: "legacy.csv",
    });
  });
});

describe("JobSubmit requires.locality", () => {
  const BASE = { name: "j", command: "echo hi", resources: { cpus: 1, memoryMb: 512 } };

  test("accepts explicit dataSites", () => {
    const j = JobSubmitSchema.parse({
      ...BASE,
      requires: { locality: { dataSites: ["site-a", "site-b"] } },
    });
    expect(j.requires?.locality?.dataSites).toEqual(["site-a", "site-b"]);
  });

  test("requires is optional", () => {
    expect(JobSubmitSchema.parse(BASE).requires).toBeUndefined();
  });
});

import type { PlacementTrace } from "@kuintessence/shared/browser";
import { expect, test } from "vitest";
import { jobResourceMap } from "./JobResourceMap";
import type { JobDetail } from "./types";

const job: JobDetail = {
  id: "example",
  name: "Analysis",
  status: "running",
  submittedAt: "2026-01-01",
  agentId: "agent-a",
  resources: { cpus: 4, memoryMb: 2048 },
  softwareRequirements: [{ name: "samtools", version: "1.23" }],
  inputStaging: [{ fileMetadataId: "file-a", stagePath: "inputs/sample.bam" }],
  expectedOutputs: [{ descriptor: "summary", path: "summary.txt", isBatch: false }],
};
test("uses persisted job resources and file paths without inventing cluster identity or usage", () => {
  const map = jobResourceMap(job);
  expect(map.nodes.find((n) => n.id === "cluster")?.purpose.en).toBe("Not recorded · agent-a");
  expect(map.nodes.find((n) => n.id === "resources")?.name.en).toBe("Requested resources");
  expect(map.nodes.find((n) => n.id === "resources")?.purpose.en).toBe("4 CPU · 2048 MiB");
  expect(map.nodes.find((n) => n.id === "software")?.purpose.en).toBe("samtools@1.23");
  expect(map.nodes.find((n) => n.id === "inputs")?.purpose.en).toBe("inputs/sample.bam");
  expect(map.nodes.find((n) => n.id === "outputs")?.purpose.en).toBe("summary.txt");
  expect(map.edges).toHaveLength(5);
});
test("only uses the placement agent identity when it matches the recorded allocation", () => {
  const trace: PlacementTrace = {
    generatedAt: "2026-01-01",
    preview: false,
    candidateCount: 1,
    stages: [],
    finalDecision: { agentId: "other", siteName: "Unallocated center" },
  };
  expect(
    jobResourceMap(job, trace).nodes.find((n) => n.id === "cluster")?.purpose.en,
  ).not.toContain("Unallocated center");
  trace.finalDecision = { agentId: "agent-a", siteName: "Example center", schedulerType: "Slurm" };
  expect(jobResourceMap(job, trace).nodes.find((n) => n.id === "cluster")?.purpose.en).toBe(
    "Example center · agent-a · Slurm",
  );
  expect(() =>
    jobResourceMap({
      id: "minimal",
      name: "Minimal",
      status: "pending",
      submittedAt: "2026-01-01",
    }),
  ).not.toThrow();
});

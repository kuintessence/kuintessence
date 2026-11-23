import { expect, test } from "bun:test";
import { K8sAdapter } from "./k8s";
import { PbsProAdapter } from "./pbs-pro";
import { SlurmAdapter } from "./slurm";
import { TorqueAdapter } from "./torque";

const job = {
  jobId: "example",
  name: "allocation",
  command: "true",
  cpus: 8,
  memoryMb: 2048,
  gpus: 2,
  wallTimeSec: 90,
  envVars: {},
  workingDir: "/work",
};
test("renders multi-node allocations from job totals and native time constraints", () => {
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const pbsJob = { ...job, schedulerLimits: { nodeCount: 2, maxCpuTime: 300 } };
  const slurm = new SlurmAdapter("23").buildSubmitScript({
    ...job,
    schedulerLimits: { nodeCount: 2, stopTime: deadline },
  });
  for (const flag of [
    "--nodes=2",
    "--ntasks-per-node=1",
    "--cpus-per-task=4",
    "--mem=1024M",
    `--deadline=UTS${deadline}`,
  ])
    expect(slurm).toContain(flag);
  const pbs = new PbsProAdapter("23").buildSubmitScript(pbsJob);
  for (const resource of ["select=2:ncpus=4:mem=1024mb:ngpus=1", "place=scatter", "cput=00:05:00"])
    expect(pbs).toContain(resource);
  const torque = new TorqueAdapter("6").buildSubmitScript(pbsJob);
  for (const resource of ["nodes=2:ppn=4", "mem=2048mb", "cput=00:05:00"])
    expect(torque).toContain(resource);
});
test("refuses impossible allocations before scheduler submission", () => {
  expect(() =>
    new PbsProAdapter("23").buildSubmitScript({
      ...job,
      cpus: 3,
      schedulerLimits: { nodeCount: 2 },
    }),
  ).toThrow("divide evenly");
  expect(() =>
    new SlurmAdapter("23").buildSubmitScript({ ...job, schedulerLimits: { maxCpuTime: 20 } }),
  ).toThrow("CPU time");
  expect(() =>
    new SlurmAdapter("23").buildSubmitScript({ ...job, schedulerLimits: { stopTime: 1 } }),
  ).toThrow("passed");
  expect(() =>
    new K8sAdapter("v1").buildJobManifest({ ...job, schedulerLimits: { nodeCount: 2 } }),
  ).toThrow("Multi-node");
});

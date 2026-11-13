import { expect, test } from "bun:test";
import { usecase } from "@kuintessence/shared";
import { preparePublicationInput } from "./output-publication-input";

const make = (
  path = "out.dat",
  descriptor = "result",
  isBatch = false,
  paths: unknown = [path],
) => ({
  jobId: "job",
  ownerId: "owner",
  agentId: "agent",
  workingDir: "/work/job",
  workflowRunId: "run",
  spec: {
    expectedOutputs: [{ descriptor, path, isBatch, pathsOnly: true }],
    fileOutputDescriptors: [descriptor],
  },
  collected: { [usecase.batchOutputPathsDescriptor(descriptor)]: JSON.stringify(paths) },
});
test("publication binds only declared in-root paths and preserves empty batch declarations", () => {
  expect(preparePublicationInput(make()).files[0]?.source).toBe("/work/job/out.dat");
  const batch = preparePublicationInput(make("*.dat", "result", true, ["a.dat", "b.dat"]));
  expect(batch.files).toHaveLength(2);
  expect(preparePublicationInput(make("*.dat", "result", true, [])).outputs[0]?.paths).toEqual([]);
  for (const path of ["../secret", "/etc/passwd", "/work/job-other/x", "."]) {
    expect(() => preparePublicationInput(make(path))).toThrow();
  }
  expect(() => preparePublicationInput(make("out.dat", "result", false, ["other.dat"]))).toThrow(
    "declaration",
  );
  expect(() => preparePublicationInput(make("*.dat", "result", true, ["other.txt"]))).toThrow(
    "glob",
  );
  expect(() => preparePublicationInput(make("*.dat", "result", true, ["../secret.dat"]))).toThrow();
});
test("corrupt metadata, duplicate descriptors and target collisions cannot release outputs", () => {
  for (const paths of [null, {}, ["a.dat", 1]]) {
    expect(() => preparePublicationInput(make("*.dat", "result", true, paths))).toThrow();
  }
  const broken = make();
  broken.collected[usecase.batchOutputPathsDescriptor("result")] = "{";
  expect(() => preparePublicationInput(broken)).toThrow();
  const duplicate = make();
  duplicate.spec.expectedOutputs.push({
    descriptor: "result",
    path: "out.dat",
    isBatch: false,
    pathsOnly: true,
  });
  expect(() => preparePublicationInput(duplicate)).toThrow("Duplicate");
  expect(() =>
    preparePublicationInput(make("*.dat", "result", true, ["a b.dat", "a_b.dat"])),
  ).toThrow("Conflicting");
  const stdout = make("out.dat", "stdout");
  const first = stdout.spec.expectedOutputs[0];
  if (first) first.pathsOnly = false;
  stdout.collected = { stdout: "automatic stdout log" };
  expect(() => preparePublicationInput(stdout)).toThrow("metadata");
});

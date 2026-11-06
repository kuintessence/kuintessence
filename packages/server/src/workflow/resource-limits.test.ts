import { expect, test } from "bun:test";
import { constrainWorkflowResources } from "./resource-limits";

const limits = { cpus: 2, memoryMb: 128, gpus: 0, wallTimeSec: 30 };
test("delegated resources default within the signed limits and retain smaller explicit requests", () => {
  expect(constrainWorkflowResources(undefined, limits)).toEqual({ ...limits, cpus: 1 });
  expect(constrainWorkflowResources({ cpus: 2, memoryMb: 64, wallTimeSec: 10 }, limits)).toEqual({
    cpus: 2,
    memoryMb: 64,
    wallTimeSec: 10,
    gpus: 0,
  });
});
test("explicit excess and invalid resource values are rejected, never silently clamped", () => {
  for (const resources of [
    { cpus: 3 },
    { memoryMb: 129 },
    { gpus: 1 },
    { wallTimeSec: 31 },
    { memoryMb: 0 },
    { cpus: 1.5 },
    { wallTimeSec: Infinity },
  ])
    expect(() => constrainWorkflowResources(resources, limits)).toThrow("authorized limit");
  expect(() => constrainWorkflowResources({}, { ...limits, wallTimeSec: 0 })).toThrow(
    "authorized limit",
  );
});

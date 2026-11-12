import { expect, test } from "bun:test";
import { parseSiteOperations } from "./site-operations";

const report = {
  version: 1,
  observedAt: Date.now(),
  transport: "ssh-forward",
  trust: "single-user",
  executor: "slurm",
  materials: { state: "idle" },
  installation: { state: "running", active: 1 },
  jobs: { state: "blocked", active: 1 },
  transfers: { state: "idle" },
  update: { phase: "staged", release: "a".repeat(64) },
};
test("site telemetry rejects stale, invalid and free-form secret fields without breaking heartbeat", () => {
  expect(parseSiteOperations(JSON.stringify(report))?.trust).toBe("single-user");
  expect(parseSiteOperations(JSON.stringify({ ...report, token: "secret" }))).toBeUndefined();
  expect(parseSiteOperations(JSON.stringify({ ...report, observedAt: 1 }))).toBeUndefined();
  expect(
    parseSiteOperations(JSON.stringify({ ...report, jobs: { state: "running", active: -1 } })),
  ).toBeUndefined();
  expect(parseSiteOperations("{".repeat(9000))).toBeUndefined();
});

test("audit context accepts bounded digests and rejects ready shortcuts and paths", () => {
  const auditContext = {
    siteProfileDigest: `sha256:${"c".repeat(64)}`,
    runtimeDigest: `sha256:${"d".repeat(64)}`,
  };
  expect(parseSiteOperations(JSON.stringify({ ...report, auditContext }))?.auditContext).toEqual(
    auditContext,
  );
  expect(
    parseSiteOperations(
      JSON.stringify({ ...report, auditContext: { ...auditContext, ready: true } }),
    ),
  ).toBeUndefined();
  expect(
    parseSiteOperations(
      JSON.stringify({
        ...report,
        auditContext: { ...auditContext, runtimeDigest: "/private/runtime" },
      }),
    ),
  ).toBeUndefined();
});

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createUsecaseExecutor,
  runWorkflow,
  SPACK_EXECUTION_PLACEHOLDER,
  workflowDsl,
} from "@kuintessence/shared";
import { selectedCase } from "../spack-case/fixture";
import {
  assertWorkflowCompleted,
  managedWorkflow,
  managedWorkflowPackage,
} from "./workflow-contract";

const previous = process.env.KQ_PR_SPACK_CASE;
const assets = { usecaseId: randomUUID(), softwareRevisionId: randomUUID() };
const queueId = randomUUID();
const prefix = "/srv/kq/spack/releases/11111111-1111-4111-8111-111111111111/root";

afterEach(() => {
  if (previous === undefined) delete process.env.KQ_PR_SPACK_CASE;
  else process.env.KQ_PR_SPACK_CASE = previous;
});

describe("managed workflow acceptance contract", () => {
  test.each(["hello", "samtools"])("%s uses governed revisions and output dependencies", async (id) => {
    process.env.KQ_PR_SPACK_CASE = id;
    const fixture = selectedCase();
    const pkg = managedWorkflowPackage();
    const workflow = managedWorkflow(assets, queueId, prefix);
    const executions: string[] = [];
    const result = await runWorkflow(workflow, createUsecaseExecutor({
      deferSpackActivation: true,
      resolvePackage: async (usecaseId, revisionId) => {
        expect({ usecaseId, softwareRevisionId: revisionId }).toEqual(assets);
        return pkg;
      },
      submitJob: async (job) => {
        expect(job.schedulingStrategy).toEqual({ queueId });
        expect(job.resources).toEqual({ cpus: 2, wallTimeSec: 120 });
        expect(job.command).toBe(SPACK_EXECUTION_PLACEHOLDER);
        expect(job.spackExecution?.spec).toBe(fixture.spec);
        expect(job.spackExecution?.command).toContain(`${prefix}/bin/${fixture.name}`);
        expect(job.spackExecution?.command).toContain('test "$1" = ');
        expect(job.spackExecution?.command).toContain(
          `set -e; test "$1" = ${job.nodeId === "compute" ? 0 : 3}; set -euo pipefail\n`,
        );
        expect(job.spackExecution?.command).toMatch(
          job.nodeId === "compute" ? /kq-workflow 0$/ : /kq-workflow 3$/,
        );
        executions.push(job.nodeId);
        return { jobId: randomUUID(), status: "completed", collected: { stdout: "KQ_WORKFLOW_VALUE=3\n" } };
      },
    }));
    expect(executions).toEqual(["compute", "verify"]);
    expect(result.status).toEqual({ compute: "Succeeded", verify: "Succeeded" });
    expect(result.values.verify?.values).toEqual({ count: 3 });
    expect(pkg.softwareRef).toEqual({
      source: "platform-fork", name: fixture.name, version: fixture.version,
    });
    const script = workflow.parameters[0]?.default;
    expect(typeof script).toBe("string");
    expect(script).not.toContain("spack load");
    expect(script).not.toContain("export PATH");
    expect(script).not.toContain("/usr/bin/env -i");
    expect(pkg.valueOutputs[0]?.onMissing).toBe("Fail");
    expect(workflowDsl.WorkflowSchema.safeParse(workflow).success).toBe(true);
  });

  test("missing output fails the workflow instead of accepting a zero exit", async () => {
    process.env.KQ_PR_SPACK_CASE = "hello";
    const calls: string[] = [];
    const result = await runWorkflow(managedWorkflow(assets, queueId, prefix), createUsecaseExecutor({
      deferSpackActivation: true,
      resolvePackage: async () => managedWorkflowPackage(),
      submitJob: async (job) => {
        calls.push(job.nodeId);
        return { jobId: randomUUID(), status: "completed", collected: { stdout: "unrelated\n" } };
      },
    }));
    expect(result.status.compute).toBe("Failed");
    expect(calls).toEqual(["compute"]);
  });

  function completed() {
    return {
      id: randomUUID(), status: "completed",
      stepJobs: { compute: randomUUID(), verify: randomUUID() },
      result: {
        status: { compute: "Succeeded", verify: "Succeeded" },
        values: {
          compute: { status: "Succeeded", values: { count: 3 } },
          verify: { status: "Succeeded", values: { count: 3 } },
        },
      },
    };
  }

  test("requires distinct job IDs and exact node results", () => {
    const value = completed();
    expect(assertWorkflowCompleted(value, value.id)).toEqual({ runId: value.id, jobs: value.stepJobs });
    for (const change of [
      { status: "failed" },
      { stepJobs: { ...value.stepJobs, verify: value.stepJobs.compute } },
      { stepJobs: { compute: value.stepJobs.compute } },
      { result: null },
      { result: { ...value.result, status: { compute: "Succeeded", verify: "Skipped" } } },
      { result: { ...value.result, values: { ...value.result.values, verify: { status: "Succeeded", values: { count: "3" } } } } },
    ]) {
      expect(() => assertWorkflowCompleted({ ...value, ...change }, value.id)).toThrow();
    }
    expect(() => assertWorkflowCompleted(value, randomUUID())).toThrow();
  });

  test("workflow mode remains opt-in and precedes scheduler startup", async () => {
    const runner = await readFile(new URL("../run.sh", import.meta.url), "utf8");
    for (const flag of ["--spack-workflow-hello", "--spack-workflow-samtools"]) {
      expect(runner).toContain(flag);
    }
    expect(runner).toContain("unset KQ_PR_MATERIAL_EPOCH KQ_PR_SPACK_CASE KQ_PR_SPACK_WORKFLOW");
    expect(runner.indexOf("workflow-assets.ts")).toBeLessThan(
      runner.indexOf("300 scheduler registry"),
    );
    const overlay = await readFile(
      new URL("../../compose/docker-compose.pr-spack-workflow.yml", import.meta.url), "utf8",
    );
    expect(overlay).toContain("case-control:/case-control:ro");
    expect(overlay).not.toContain("case-server:");
    expect(overlay).not.toContain("ports:");
    const caseFile = await readFile(new URL("case.ts", import.meta.url), "utf8");
    expect(caseFile).toContain('process.env.KQ_PR_SPACK_WORKFLOW === "1"');
    expect(caseFile).toContain("verifyManagedWorkflow(token, state.workflow)");
    expect(caseFile).toContain("assert.notEqual(receipt.runId, state.workflow?.runId)");
  });
});

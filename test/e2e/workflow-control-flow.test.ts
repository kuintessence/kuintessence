import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { inArray } from "drizzle-orm";
import { createPgDb, type PgDb, usecasePackages, workflowTemplates } from "../../packages/db/src";
import type { usecase } from "../../packages/shared/src";
import { governedShellPackage, seedE2eSoftwareRevision } from "./fixtures/governed-package";
import { type Stack, startStack } from "./fixtures/stack";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const BASH_STDOUT_PKG_ID = "22222222-2222-4222-8222-222222222101";
const SOFTWARE_ID = "22222222-2222-4222-8222-222222222201";
const CHILD_WORKFLOW_TEMPLATE_ID = "22222222-2222-4222-8222-222222222301";
const INVALID_CHILD_WORKFLOW_TEMPLATE_ID = "22222222-2222-4222-8222-222222222302";
const SELF_REF_CHILD_WORKFLOW_TEMPLATE_ID = "22222222-2222-4222-8222-222222222303";
const CHAIN_MIDDLE_WORKFLOW_TEMPLATE_ID = "22222222-2222-4222-8222-222222222304";
const CHAIN_LEAF_WORKFLOW_TEMPLATE_ID = "22222222-2222-4222-8222-222222222305";
const DEPTH_LIMITED_MIDDLE_WORKFLOW_TEMPLATE_ID = "22222222-2222-4222-8222-222222222306";
const MISSING_OUTPUT_CHILD_WORKFLOW_TEMPLATE_ID = "22222222-2222-4222-8222-222222222307";
const AMBIGUOUS_OUTPUT_CHILD_WORKFLOW_TEMPLATE_ID = "22222222-2222-4222-8222-222222222308";
const SUCCEED_WITH_LAST_MIDDLE_WORKFLOW_TEMPLATE_ID = "22222222-2222-4222-8222-222222222309";
const MISSING_CHILD_WORKFLOW_TEMPLATE_ID = "22222222-2222-4222-8222-222222222399";
const PACKAGE_IDS = [BASH_STDOUT_PKG_ID];
let stack: Stack;
let db: PgDb;
let cliConfigDir: string;
let cliConfigFile: string;
const workflowDirs: string[] = [];

beforeAll(async () => {
  stack = await startStack();
  db = createPgDb(stack.databaseUrl);
  await seedPackages(db);
  cliConfigDir = mkdtempSync(join(tmpdir(), "kq-control-flow-cli-e2e-"));
  cliConfigFile = join(cliConfigDir, "config.json");
  writeFileSync(
    cliConfigFile,
    JSON.stringify({ serverUrl: stack.serverBaseUrl, token: stack.adminToken }),
  );
}, 300_000);

afterAll(async () => {
  await stack?.stop();
  if (cliConfigDir) {
    rmSync(cliConfigDir, { recursive: true, force: true });
  }
  for (const dir of workflowDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("e2e: workflow control flow through CLI + Server + Agent + Slurm", () => {
  test("skips a when=false node and propagates the skip to its dependent", async () => {
    const yamlPath = writeWorkflowYaml(whenSkipWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.skip_me).toBe("Skipped");
    expect(final.result?.status.downstream).toBe("Skipped");
    expect(final.stepJobs.skip_me).toBeUndefined();
    expect(final.stepJobs.downstream).toBeUndefined();

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("skip_me: Skipped");
    expect(status.stdout).toContain("downstream: Skipped");
  }, 180_000);

  test("runs the selected Switch branch and skips the unselected branch", async () => {
    const yamlPath = writeWorkflowYaml(switchWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.pick).toBe("Succeeded");
    expect(final.result?.status.fast_path).toBe("Succeeded");
    expect(final.result?.status.slow_path).toBe("Skipped");
    expect(final.result?.values.fast_path?.values.score).toBe(1);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("fast_path: Succeeded");
    expect(status.stdout).toContain("slow_path: Skipped");
    expect(status.stdout).toContain('"score":1');
  }, 180_000);

  test("runs the Switch default branch when no case matches", async () => {
    const yamlPath = writeWorkflowYaml(switchDefaultWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.pick).toBe("Succeeded");
    expect(final.result?.status.fast_path).toBe("Skipped");
    expect(final.result?.status.slow_path).toBe("Succeeded");
    expect(final.result?.values.slow_path?.values.score).toBe(2);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("fast_path: Skipped");
    expect(status.stdout).toContain("slow_path: Succeeded");
    expect(status.stdout).toContain('"score":2');
  }, 180_000);

  test("runs Generate -> Loop ForEach -> Reduce Statistics", async () => {
    const yamlPath = writeWorkflowYaml(loopReduceWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 180_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.gen).toBe("Succeeded");
    expect(final.result?.status.sweep).toBe("Succeeded");
    expect(final.result?.status.stats).toBe("Succeeded");
    expect(final.result?.values.sweep?.values.values).toEqual([1, 2, 3]);
    expect(final.result?.values.stats?.values.stats).toBe("metric,value\nmean,2\nmax,3\nmin,1\n");

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("stats: Succeeded");
    expect(status.stdout).toContain("metric,value");
  }, 240_000);

  test("fails a ForEach Loop when generated items exceed maxIterations", async () => {
    const yamlPath = writeWorkflowYaml(loopMaxIterationsWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "failed", 120_000);

    expect(final.status).toBe("failed");
    expect(final.result?.status.gen).toBe("Succeeded");
    expect(final.result?.status.sweep).toBe("Failed");
    expect(final.stepJobs.sweep).toBeUndefined();

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("sweep: Failed");
  }, 180_000);

  test("runs a While Loop until convergence", async () => {
    const yamlPath = writeWorkflowYaml(whileConvergenceWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 180_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.solveLoop).toBe("Succeeded");
    expect(final.result?.values.solveLoop?.values.finalResidual).toBe(0.25);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("solveLoop: Succeeded");
    expect(status.stdout).toContain('"finalResidual":0.25');
  }, 240_000);

  test("fails a While Loop when onExhausted is Fail", async () => {
    const yamlPath = writeWorkflowYaml(whileExhaustedFailWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "failed", 180_000);

    expect(final.status).toBe("failed");
    expect(final.result?.status.solveLoop).toBe("Failed");
    expect(final.stepJobs.solve).toMatch(/^[0-9a-f-]{36}$/);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("solveLoop: Failed");
  }, 240_000);

  test("keeps the last While Loop output when onExhausted is SucceedWithLast", async () => {
    const yamlPath = writeWorkflowYaml(whileExhaustedSucceedWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 180_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.solveLoop).toBe("Succeeded");
    expect(final.result?.values.solveLoop?.values.finalResidual).toBe(0.5);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("solveLoop: Succeeded");
    expect(status.stdout).toContain('"finalResidual":0.5');
  }, 240_000);

  test("runs Reduce Collect, Concat, and ExtractTable reducers", async () => {
    const yamlPath = writeWorkflowYaml(reduceGalleryWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 240_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.wordCollect).toBe("Succeeded");
    expect(final.result?.status.wordConcat).toBe("Succeeded");
    expect(final.result?.status.table).toBe("Succeeded");
    expect(final.result?.values.wordCollect?.values.words).toEqual(["alpha", "beta"]);
    expect(final.result?.values.wordConcat?.values.joined).toBe("alphabeta");
    expect(final.result?.values.table?.values.rows).toBe(
      "reynolds,doubled,cl\n100,200,1\n250,500,2.5\n",
    );

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("wordConcat: Succeeded");
    expect(status.stdout).toContain("reynolds,doubled,cl");
  }, 300_000);

  test("runs an inline SubWorkflow body through the CLI stack", async () => {
    const yamlPath = writeWorkflowYaml(subWorkflowInlineWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.nested).toBe("Succeeded");
    expect(final.stepJobs.inner).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.result?.values.nested?.values).toEqual({});

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("nested: Succeeded");
  }, 180_000);

  test("runs a ByVersion SubWorkflow from a persisted workflow template", async () => {
    await seedChildWorkflowTemplate(db);
    const yamlPath = writeWorkflowYaml(subWorkflowByVersionWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.persisted_child).toBe("Succeeded");
    expect(final.stepJobs.inner_by_version).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.result?.values.persisted_child?.values.refined).toBe(42);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("persisted_child: Succeeded");
    expect(status.stdout).toContain('"refined":42');
  }, 180_000);

  test("fails a ByVersion SubWorkflow when the workflow template is missing", async () => {
    const yamlPath = writeWorkflowYaml(
      subWorkflowByVersionWorkflow(MISSING_CHILD_WORKFLOW_TEMPLATE_ID, "missing_child"),
    );

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "failed", 120_000);

    expect(final.status).toBe("failed");
    expect(final.result?.status.missing_child).toBe("Failed");
    expect(final.stepJobs.inner_by_version).toBeUndefined();

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("missing_child: Failed");
  }, 180_000);

  test("fails a ByVersion SubWorkflow when the persisted template is invalid", async () => {
    await seedInvalidChildWorkflowTemplate(db);
    const yamlPath = writeWorkflowYaml(
      subWorkflowByVersionWorkflow(INVALID_CHILD_WORKFLOW_TEMPLATE_ID, "invalid_child"),
    );

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "failed", 120_000);

    expect(final.status).toBe("failed");
    expect(final.result?.status.invalid_child).toBe("Failed");
    expect(final.stepJobs.inner_by_version).toBeUndefined();

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("invalid_child: Failed");
  }, 180_000);

  test("fails a ByVersion SubWorkflow cycle when maxDepth is exceeded", async () => {
    await seedSelfReferentialChildWorkflowTemplate(db);
    const yamlPath = writeWorkflowYaml(
      subWorkflowByVersionWorkflow(SELF_REF_CHILD_WORKFLOW_TEMPLATE_ID, "recursive_child"),
    );

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "failed", 120_000);

    expect(final.status).toBe("failed");
    expect(final.result?.status.recursive_child).toBe("Failed");
    expect(final.stepJobs).toEqual({});

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("recursive_child: Failed");
  }, 180_000);

  test("runs a multi-level ByVersion chain with parameter and output mapping", async () => {
    await seedChainedWorkflowTemplates(db, CHAIN_MIDDLE_WORKFLOW_TEMPLATE_ID, 8);
    const yamlPath = writeWorkflowYaml(chainedSubWorkflowByVersionWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.chained_child).toBe("Succeeded");
    expect(final.stepJobs.leaf_compute).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.result?.values.chained_child?.values.finalAnswer).toBe(70);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("chained_child: Succeeded");
    expect(status.stdout).toContain('"finalAnswer":70');
  }, 180_000);

  test("fails a multi-level ByVersion chain when an inner maxDepth is exceeded", async () => {
    await seedChainedWorkflowTemplates(db, DEPTH_LIMITED_MIDDLE_WORKFLOW_TEMPLATE_ID, 1);
    const yamlPath = writeWorkflowYaml(
      chainedSubWorkflowByVersionWorkflow(DEPTH_LIMITED_MIDDLE_WORKFLOW_TEMPLATE_ID),
    );

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "failed", 120_000);

    expect(final.status).toBe("failed");
    expect(final.result?.status.chained_child).toBe("Failed");
    expect(final.stepJobs.leaf_compute).toBeUndefined();

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("chained_child: Failed");
  }, 180_000);

  test("succeeds a ByVersion node with empty values when a declared output is absent", async () => {
    await seedMissingOutputChildWorkflowTemplate(db);
    const yamlPath = writeWorkflowYaml(
      subWorkflowOutputMappingWorkflow(
        MISSING_OUTPUT_CHILD_WORKFLOW_TEMPLATE_ID,
        "missing_output",
        "not_present",
      ),
    );

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.missing_output).toBe("Succeeded");
    expect(final.stepJobs.inner_missing_output).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.result?.values.missing_output?.values).toEqual({});

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("missing_output: Succeeded");
  }, 180_000);

  test("succeeds a ByVersion node with empty values when a declared output is ambiguous", async () => {
    await seedAmbiguousOutputChildWorkflowTemplate(db);
    const yamlPath = writeWorkflowYaml(
      subWorkflowOutputMappingWorkflow(
        AMBIGUOUS_OUTPUT_CHILD_WORKFLOW_TEMPLATE_ID,
        "ambiguous_output",
        "answer",
      ),
    );

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.ambiguous_output).toBe("Succeeded");
    expect(final.stepJobs.left_answer).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.stepJobs.right_answer).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.result?.values.ambiguous_output?.values).toEqual({});

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("ambiguous_output: Succeeded");
  }, 180_000);

  test("succeeds a ByVersion chain with empty values when onDepthExceeded is SucceedWithLast", async () => {
    await seedChainedWorkflowTemplates(
      db,
      SUCCEED_WITH_LAST_MIDDLE_WORKFLOW_TEMPLATE_ID,
      1,
      "SucceedWithLast",
    );
    const yamlPath = writeWorkflowYaml(
      chainedSubWorkflowByVersionWorkflow(SUCCEED_WITH_LAST_MIDDLE_WORKFLOW_TEMPLATE_ID),
    );

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.chained_child).toBe("Succeeded");
    expect(final.stepJobs.leaf_compute).toBeUndefined();
    expect(final.result?.values.chained_child?.values).toEqual({});

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("chained_child: Succeeded");
  }, 180_000);

  test("fails an inline SubWorkflow when maxDepth is exceeded", async () => {
    const yamlPath = writeWorkflowYaml(subWorkflowDepthFailureWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "failed", 120_000);

    expect(final.status).toBe("failed");
    expect(final.result?.status.outer).toBe("Failed");
    expect(final.stepJobs.inner).toBeUndefined();

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("outer: Failed");
  }, 180_000);
});

async function seedPackages(dbHandle: PgDb): Promise<void> {
  await dbHandle.delete(usecasePackages).where(inArray(usecasePackages.id, PACKAGE_IDS));
  await seedE2eSoftwareRevision(dbHandle, SOFTWARE_ID);
  await dbHandle.insert(usecasePackages).values([
    {
      id: BASH_STDOUT_PKG_ID,
      name: "mock-bash-io",
      version: "1",
      spec: bashPackage(),
    },
  ]);
}

async function seedChildWorkflowTemplate(dbHandle: PgDb): Promise<void> {
  await dbHandle
    .delete(workflowTemplates)
    .where(inArray(workflowTemplates.id, [CHILD_WORKFLOW_TEMPLATE_ID]));
  await dbHandle.insert(workflowTemplates).values({
    id: CHILD_WORKFLOW_TEMPLATE_ID,
    name: "child-by-version-e2e",
    version: "1",
    description: "Child workflow template used by SubWorkflow ByVersion E2E.",
    yamlContent: subWorkflowChildTemplateYaml(),
    tags: ["e2e"],
  });
}

async function seedInvalidChildWorkflowTemplate(dbHandle: PgDb): Promise<void> {
  await dbHandle
    .delete(workflowTemplates)
    .where(inArray(workflowTemplates.id, [INVALID_CHILD_WORKFLOW_TEMPLATE_ID]));
  await dbHandle.insert(workflowTemplates).values({
    id: INVALID_CHILD_WORKFLOW_TEMPLATE_ID,
    name: "invalid-child-by-version-e2e",
    version: "1",
    description: "Invalid child workflow template used by SubWorkflow ByVersion E2E.",
    yamlContent: "name: invalid-child\nspec:\n  nodeDrafts: [",
    tags: ["e2e"],
  });
}

async function seedSelfReferentialChildWorkflowTemplate(dbHandle: PgDb): Promise<void> {
  await dbHandle
    .delete(workflowTemplates)
    .where(inArray(workflowTemplates.id, [SELF_REF_CHILD_WORKFLOW_TEMPLATE_ID]));
  await dbHandle.insert(workflowTemplates).values({
    id: SELF_REF_CHILD_WORKFLOW_TEMPLATE_ID,
    name: "recursive-child-by-version-e2e",
    version: "1",
    description: "Self-referential child workflow template used by SubWorkflow maxDepth E2E.",
    yamlContent: selfReferentialChildTemplateYaml(),
    tags: ["e2e"],
  });
}

async function seedChainedWorkflowTemplates(
  dbHandle: PgDb,
  middleWorkflowTemplateId: string,
  innerMaxDepth: number,
  onDepthExceeded?: "Fail" | "SucceedWithLast",
): Promise<void> {
  await dbHandle
    .delete(workflowTemplates)
    .where(
      inArray(workflowTemplates.id, [middleWorkflowTemplateId, CHAIN_LEAF_WORKFLOW_TEMPLATE_ID]),
    );
  await dbHandle.insert(workflowTemplates).values([
    {
      id: CHAIN_LEAF_WORKFLOW_TEMPLATE_ID,
      name: "leaf-by-version-e2e",
      version: "1",
      description: "Leaf workflow template used by chained SubWorkflow ByVersion E2E.",
      yamlContent: leafChildTemplateYaml(),
      tags: ["e2e"],
    },
    {
      id: middleWorkflowTemplateId,
      name: "middle-by-version-e2e",
      version: "1",
      description: "Middle workflow template used by chained SubWorkflow ByVersion E2E.",
      yamlContent: middleChildTemplateYaml(innerMaxDepth, onDepthExceeded),
      tags: ["e2e"],
    },
  ]);
}

async function seedMissingOutputChildWorkflowTemplate(dbHandle: PgDb): Promise<void> {
  await dbHandle
    .delete(workflowTemplates)
    .where(inArray(workflowTemplates.id, [MISSING_OUTPUT_CHILD_WORKFLOW_TEMPLATE_ID]));
  await dbHandle.insert(workflowTemplates).values({
    id: MISSING_OUTPUT_CHILD_WORKFLOW_TEMPLATE_ID,
    name: "missing-output-child-by-version-e2e",
    version: "1",
    description: "Child workflow template with no matching output for ByVersion E2E.",
    yamlContent: missingOutputChildTemplateYaml(),
    tags: ["e2e"],
  });
}

async function seedAmbiguousOutputChildWorkflowTemplate(dbHandle: PgDb): Promise<void> {
  await dbHandle
    .delete(workflowTemplates)
    .where(inArray(workflowTemplates.id, [AMBIGUOUS_OUTPUT_CHILD_WORKFLOW_TEMPLATE_ID]));
  await dbHandle.insert(workflowTemplates).values({
    id: AMBIGUOUS_OUTPUT_CHILD_WORKFLOW_TEMPLATE_ID,
    name: "ambiguous-output-child-by-version-e2e",
    version: "1",
    description: "Child workflow template with ambiguous matching outputs for ByVersion E2E.",
    yamlContent: ambiguousOutputChildTemplateYaml(),
    tags: ["e2e"],
  });
}

function bashPackage(): usecase.UsecasePackage {
  return governedShellPackage({
    usecase: {
      commandFile: "bash",
      inputSlots: [
        {
          kind: "Text",
          descriptor: "script",
          refMaterials: [{ kind: "ArgRef", descriptor: "script", sort: 0 }],
        },
      ],
    },
    software: { kind: "Bare" },
    arguments: [{ descriptor: "script", valueFormat: "-lc {}" }],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [],
  });
}

function switchWorkflow(): string {
  return workflowYaml({
    name: "control_flow_switch_e2e",
    nodes: [
      {
        type: "Switch",
        id: "pick",
        name: "pick",
        cases: [{ when: { expr: "params.mode == 'fast'" }, to: "fast_path" }],
        default: "slow_path",
      },
      softwareNode("fast_path", [
        textSlot("script", celString('printf "branch=fast\\nscore=1\\n"')),
        valueOverride("score", "int", "score=([0-9]+)"),
      ]),
      softwareNode("slow_path", [
        textSlot("script", celString('printf "branch=slow\\nscore=2\\n"')),
        valueOverride("score", "int", "score=([0-9]+)"),
      ]),
    ],
    relations: [],
    parameters: [{ name: "mode", type: "string", default: "fast" }],
  });
}

function whenSkipWorkflow(): string {
  return workflowYaml({
    name: "control_flow_when_skip_e2e",
    nodes: [
      softwareNode(
        "skip_me",
        [
          textSlot("script", celString('printf "value=1\\n"')),
          valueOverride("value", "int", "value=([0-9]+)"),
        ],
        { when: { expr: "false" } },
      ),
      softwareNode("downstream", [
        textSlot("script", celString('printf "value=2\\n"')),
        valueOverride("value", "int", "value=([0-9]+)"),
      ]),
    ],
    relations: [{ fromId: "skip_me", toId: "downstream", slotRelations: [] }],
    parameters: [],
  });
}

function switchDefaultWorkflow(): string {
  return workflowYaml({
    name: "control_flow_switch_default_e2e",
    nodes: [
      {
        type: "Switch",
        id: "pick",
        name: "pick",
        cases: [{ when: { expr: "params.mode == 'fast'" }, to: "fast_path" }],
        default: "slow_path",
      },
      softwareNode("fast_path", [
        textSlot("script", celString('printf "branch=fast\\nscore=1\\n"')),
        valueOverride("score", "int", "score=([0-9]+)"),
      ]),
      softwareNode("slow_path", [
        textSlot("script", celString('printf "branch=slow\\nscore=2\\n"')),
        valueOverride("score", "int", "score=([0-9]+)"),
      ]),
    ],
    relations: [],
    parameters: [{ name: "mode", type: "string", default: "slow" }],
  });
}

function loopReduceWorkflow(): string {
  return workflowYaml({
    name: "loop_reduce_e2e",
    nodes: [
      {
        type: "Generate",
        id: "gen",
        name: "gen",
        rule: { kind: "Enumeration", values: [1, 2, 3] },
        output: { descriptor: "items", as: "List" },
      },
      {
        type: "Loop",
        id: "sweep",
        name: "sweep",
        mode: "ForEach",
        over: { expr: "nodes.gen.values.items" },
        maxIterations: 3,
        body: {
          nodeDrafts: [
            softwareNode("work", [
              textSlot(
                "script",
                `${celString('printf "value=')} + string(loop.item) + ${celString('\\n"')}`,
              ),
              valueOverride("value", "int", "value=([0-9]+)"),
            ]),
          ],
        },
        outputs: [
          { descriptor: "values", from: { node: "work", output: "value" }, aggregate: "Collect" },
        ],
      },
      {
        type: "Reduce",
        id: "stats",
        name: "stats",
        from: { loop: "sweep", output: "values" },
        reducer: { kind: "Statistics", over: "values", metrics: ["mean", "max", "min"] },
        output: { kind: "SingleFile", descriptor: "stats" },
      },
    ],
    relations: [
      { fromId: "gen", toId: "sweep", slotRelations: [] },
      { fromId: "sweep", toId: "stats", slotRelations: [] },
    ],
    parameters: [],
  });
}

function loopMaxIterationsWorkflow(): string {
  return workflowYaml({
    name: "loop_max_iterations_e2e",
    nodes: [
      {
        type: "Generate",
        id: "gen",
        name: "gen",
        rule: { kind: "Enumeration", values: [1, 2, 3] },
        output: { descriptor: "items", as: "List" },
      },
      {
        type: "Loop",
        id: "sweep",
        name: "sweep",
        mode: "ForEach",
        over: { expr: "nodes.gen.values.items" },
        maxIterations: 2,
        body: { nodeDrafts: [softwareNode("work", [textSlot("script", celString("true"))])] },
        outputs: [
          { descriptor: "values", from: { node: "work", output: "value" }, aggregate: "Collect" },
        ],
      },
    ],
    relations: [{ fromId: "gen", toId: "sweep", slotRelations: [] }],
    parameters: [],
  });
}

function whileConvergenceWorkflow(): string {
  return whileWorkflow({
    name: "while_convergence_e2e",
    until: "nodes.solve.values.residual <= 0.25",
    maxIterations: 6,
    onExhausted: "Fail",
  });
}

function whileExhaustedFailWorkflow(): string {
  return whileWorkflow({
    name: "while_exhausted_fail_e2e",
    until: "false",
    maxIterations: 2,
    onExhausted: "Fail",
  });
}

function whileExhaustedSucceedWorkflow(): string {
  return whileWorkflow({
    name: "while_exhausted_succeed_e2e",
    until: "false",
    maxIterations: 2,
    onExhausted: "SucceedWithLast",
  });
}

function whileWorkflow(input: {
  name: string;
  until: string;
  maxIterations: number;
  onExhausted: "Fail" | "SucceedWithLast";
}): string {
  return workflowYaml({
    name: input.name,
    nodes: [
      {
        type: "Loop",
        id: "solveLoop",
        name: "solveLoop",
        mode: "While",
        until: { expr: input.until },
        maxIterations: input.maxIterations,
        onExhausted: input.onExhausted,
        body: {
          nodeDrafts: [
            softwareNode("solve", [
              textSlot(
                "script",
                `${celString('printf "residual=')} + string(1.0 / (loop.iteration + 1)) + ${celString('\\n"')}`,
              ),
              valueOverride("residual", "double", "residual=([0-9.]+)"),
            ]),
          ],
        },
        outputs: [{ descriptor: "finalResidual", from: { node: "solve", output: "residual" } }],
      },
    ],
    relations: [],
    parameters: [],
  });
}

function reduceGalleryWorkflow(): string {
  return workflowYaml({
    name: "reduce_gallery_e2e",
    nodes: [
      {
        type: "Generate",
        id: "words",
        name: "words",
        rule: { kind: "Enumeration", values: ["alpha", "beta"] },
        output: { descriptor: "items", as: "List" },
      },
      {
        type: "Loop",
        id: "wordSweep",
        name: "wordSweep",
        mode: "ForEach",
        over: { expr: "nodes.words.values.items" },
        maxIterations: 4,
        body: {
          nodeDrafts: [
            softwareNode("emitWord", [
              textSlot(
                "script",
                `${celString('printf "word=')} + string(loop.item) + ${celString('\\n"')}`,
              ),
              valueOverride("word", "string", "word=([a-z]+)"),
            ]),
          ],
        },
        outputs: [
          { descriptor: "parts", from: { node: "emitWord", output: "word" }, aggregate: "Collect" },
        ],
      },
      {
        type: "Reduce",
        id: "wordCollect",
        name: "wordCollect",
        from: { loop: "wordSweep", output: "parts" },
        reducer: { kind: "Collect" },
        output: { kind: "SingleFile", descriptor: "words" },
      },
      {
        type: "Reduce",
        id: "wordConcat",
        name: "wordConcat",
        from: { loop: "wordSweep", output: "parts" },
        reducer: { kind: "Concat" },
        output: { kind: "SingleFile", descriptor: "joined" },
      },
      {
        type: "Generate",
        id: "cases",
        name: "cases",
        rule: {
          kind: "Enumeration",
          values: [{ reynolds: 100 }, { reynolds: 250 }],
        },
        output: { descriptor: "items", as: "List" },
      },
      {
        type: "Loop",
        id: "caseSweep",
        name: "caseSweep",
        mode: "ForEach",
        over: { expr: "nodes.cases.values.items" },
        maxIterations: 4,
        body: {
          nodeDrafts: [
            softwareNode("solveCase", [
              textSlot(
                "script",
                `${celString('printf "doubled=')} + string(loop.item.reynolds * 2) + ${celString("\\ncl=")} + string(loop.item.reynolds / 100) + ${celString('\\n"')}`,
              ),
              valueOverride("doubled", "double", "doubled=([0-9.]+)"),
            ]),
          ],
        },
        outputs: [
          {
            descriptor: "doubledValues",
            from: { node: "solveCase", output: "doubled" },
            aggregate: "Collect",
          },
        ],
      },
      {
        type: "Reduce",
        id: "table",
        name: "table",
        from: { loop: "caseSweep", output: "doubledValues" },
        reducer: {
          kind: "ExtractTable",
          columns: [
            { name: "reynolds", type: "double", source: { loopItem: "reynolds" } },
            { name: "doubled", type: "double", source: { node: "solveCase", output: "doubled" } },
            {
              name: "cl",
              type: "double",
              source: { collectedOut: "stdout" },
              extract: { kind: "Regex", pattern: "cl=([0-9.]+)", group: 1 },
            },
          ],
        },
        output: { kind: "SingleFile", descriptor: "rows" },
      },
    ],
    relations: [
      { fromId: "words", toId: "wordSweep", slotRelations: [] },
      { fromId: "wordSweep", toId: "wordCollect", slotRelations: [] },
      { fromId: "wordSweep", toId: "wordConcat", slotRelations: [] },
      { fromId: "cases", toId: "caseSweep", slotRelations: [] },
      { fromId: "caseSweep", toId: "table", slotRelations: [] },
    ],
    parameters: [],
  });
}

function subWorkflowInlineWorkflow(): string {
  return workflowYaml({
    name: "subworkflow_inline_e2e",
    nodes: [
      {
        type: "SubWorkflow",
        id: "nested",
        name: "nested",
        maxDepth: 4,
        ref: {
          kind: "Inline",
          body: {
            nodeDrafts: [
              softwareNode("inner", [
                textSlot("script", celString('printf "value=7\\n"')),
                valueOverride("value", "int", "value=([0-9]+)"),
              ]),
            ],
            nodeRelations: [],
          },
        },
      },
    ],
    relations: [],
    parameters: [],
  });
}

function subWorkflowByVersionWorkflow(
  workflowVersionId = CHILD_WORKFLOW_TEMPLATE_ID,
  nodeId = "persisted_child",
): string {
  return workflowYaml({
    name: "subworkflow_by_version_e2e",
    nodes: [
      {
        type: "SubWorkflow",
        id: nodeId,
        name: nodeId,
        maxDepth: 4,
        ref: { kind: "ByVersion", workflowVersionId },
        inputs: [{ to: { param: "seed" }, from: { expr: "params.seed" } }],
        outputs: [{ descriptor: "refined", from: { workflowOutput: "answer" } }],
      },
    ],
    relations: [],
    parameters: [{ name: "seed", type: "int", default: 42 }],
  });
}

function subWorkflowChildTemplateYaml(): string {
  return workflowYaml({
    name: "subworkflow_child_template_e2e",
    nodes: [
      softwareNode("inner_by_version", [
        textSlot(
          "script",
          `${celString('printf "answer=')} + string(params.seed) + ${celString('\\n"')}`,
        ),
        valueOverride("answer", "int", "answer=([0-9]+)"),
      ]),
    ],
    relations: [],
    parameters: [{ name: "seed", type: "int", default: 7 }],
  });
}

function chainedSubWorkflowByVersionWorkflow(
  workflowVersionId = CHAIN_MIDDLE_WORKFLOW_TEMPLATE_ID,
): string {
  return workflowYaml({
    name: "subworkflow_by_version_chain_e2e",
    nodes: [
      {
        type: "SubWorkflow",
        id: "chained_child",
        name: "chained_child",
        maxDepth: 8,
        ref: { kind: "ByVersion", workflowVersionId },
        inputs: [{ to: { param: "base" }, from: { expr: "params.seed" } }],
        outputs: [{ descriptor: "finalAnswer", from: { workflowOutput: "refined" } }],
      },
    ],
    relations: [],
    parameters: [{ name: "seed", type: "int", default: 4 }],
  });
}

function subWorkflowOutputMappingWorkflow(
  workflowVersionId: string,
  nodeId: string,
  workflowOutput: string,
): string {
  return workflowYaml({
    name: "subworkflow_by_version_output_mapping_e2e",
    nodes: [
      {
        type: "SubWorkflow",
        id: nodeId,
        name: nodeId,
        maxDepth: 4,
        ref: { kind: "ByVersion", workflowVersionId },
        outputs: [{ descriptor: "mapped", from: { workflowOutput } }],
      },
    ],
    relations: [],
    parameters: [],
  });
}

function middleChildTemplateYaml(
  innerMaxDepth: number,
  onDepthExceeded?: "Fail" | "SucceedWithLast",
): string {
  return workflowYaml({
    name: "subworkflow_middle_template_e2e",
    nodes: [
      {
        type: "SubWorkflow",
        id: "middle_to_leaf",
        name: "middle_to_leaf",
        maxDepth: innerMaxDepth,
        ...(onDepthExceeded === undefined ? {} : { onDepthExceeded }),
        ref: { kind: "ByVersion", workflowVersionId: CHAIN_LEAF_WORKFLOW_TEMPLATE_ID },
        inputs: [{ to: { param: "seed" }, from: { expr: "params.base + params.offset" } }],
        outputs: [{ descriptor: "refined", from: { workflowOutput: "answer" } }],
      },
    ],
    relations: [],
    parameters: [
      { name: "base", type: "int", default: 1 },
      { name: "offset", type: "int", default: 3 },
    ],
  });
}

function missingOutputChildTemplateYaml(): string {
  return workflowYaml({
    name: "subworkflow_missing_output_child_template_e2e",
    nodes: [
      softwareNode("inner_missing_output", [
        textSlot("script", celString('printf "answer=11\\n"')),
        valueOverride("answer", "int", "answer=([0-9]+)"),
      ]),
    ],
    relations: [],
    parameters: [],
  });
}

function ambiguousOutputChildTemplateYaml(): string {
  return workflowYaml({
    name: "subworkflow_ambiguous_output_child_template_e2e",
    nodes: [
      softwareNode("left_answer", [
        textSlot("script", celString('printf "answer=1\\n"')),
        valueOverride("answer", "int", "answer=([0-9]+)"),
      ]),
      softwareNode("right_answer", [
        textSlot("script", celString('printf "answer=2\\n"')),
        valueOverride("answer", "int", "answer=([0-9]+)"),
      ]),
    ],
    relations: [],
    parameters: [],
  });
}

function leafChildTemplateYaml(): string {
  return workflowYaml({
    name: "subworkflow_leaf_template_e2e",
    nodes: [
      softwareNode("leaf_compute", [
        textSlot(
          "script",
          `${celString('printf "answer=')} + string(params.seed * 10) + ${celString('\\n"')}`,
        ),
        valueOverride("answer", "int", "answer=([0-9]+)"),
      ]),
    ],
    relations: [],
    parameters: [{ name: "seed", type: "int", default: 2 }],
  });
}

function selfReferentialChildTemplateYaml(): string {
  return workflowYaml({
    name: "subworkflow_recursive_child_template_e2e",
    nodes: [
      {
        type: "SubWorkflow",
        id: "recursive_link",
        name: "recursive_link",
        maxDepth: 2,
        ref: { kind: "ByVersion", workflowVersionId: SELF_REF_CHILD_WORKFLOW_TEMPLATE_ID },
      },
    ],
    relations: [],
    parameters: [],
  });
}

function subWorkflowDepthFailureWorkflow(): string {
  return workflowYaml({
    name: "subworkflow_depth_failure_e2e",
    nodes: [
      {
        type: "SubWorkflow",
        id: "outer",
        name: "outer",
        maxDepth: 1,
        onDepthExceeded: "Fail",
        ref: {
          kind: "Inline",
          body: {
            nodeDrafts: [
              {
                type: "SubWorkflow",
                id: "innerSub",
                name: "innerSub",
                maxDepth: 1,
                onDepthExceeded: "Fail",
                ref: {
                  kind: "Inline",
                  body: {
                    nodeDrafts: [
                      softwareNode("inner", [
                        textSlot("script", celString('printf "value=7\\n"')),
                        valueOverride("value", "int", "value=([0-9]+)"),
                      ]),
                    ],
                    nodeRelations: [],
                  },
                },
              },
            ],
            nodeRelations: [],
          },
        },
      },
    ],
    relations: [],
    parameters: [],
  });
}

function workflowYaml(input: {
  name: string;
  nodes: unknown[];
  relations: unknown[];
  parameters: unknown[];
}): string {
  return JSON.stringify(
    {
      name: input.name,
      description: "Mock control-flow workflow e2e.",
      parameters: input.parameters,
      spec: {
        nodeDrafts: input.nodes,
        nodeRelations: input.relations,
      },
    },
    null,
    2,
  );
}

function softwareNode(
  id: string,
  slotsAndOverrides: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const inputSlots = slotsAndOverrides.filter(
    (item) => !("valueOutputsOverride" in objectOf(item)),
  );
  const override = slotsAndOverrides.find((item) => "valueOutputsOverride" in objectOf(item));
  return {
    type: "SoftwareUsecaseComputing",
    id,
    name: id,
    usecaseVersionId: BASH_STDOUT_PKG_ID,
    softwareVersionId: SOFTWARE_ID,
    ...extra,
    inputSlots,
    ...(objectOf(override).valueOutputsOverride
      ? { valueOutputsOverride: objectOf(override).valueOutputsOverride }
      : {}),
  };
}

function textSlot(descriptor: string, expr: string): Record<string, unknown> {
  return {
    type: "Text",
    descriptor,
    from: { expr },
  };
}

function valueOverride(
  descriptor: string,
  type: "int" | "double" | "string",
  pattern: string,
): Record<string, unknown> {
  return {
    valueOutputsOverride: [
      {
        descriptor,
        type,
        from: { collectedOutDescriptor: "stdout" },
        extract: { kind: "Regex", pattern, group: 1 },
      },
    ],
  };
}

function celString(value: string): string {
  if (value.includes("'")) {
    throw new Error("test CEL strings must not contain single quotes");
  }
  return `'${value}'`;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function writeWorkflowYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kq-control-flow-workflow-"));
  workflowDirs.push(dir);
  const path = join(dir, "workflow.yaml");
  writeFileSync(path, content);
  return path;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = spawn(["bun", "run", join(REPO_ROOT, "packages/cli/src/index.ts"), ...args], {
    env: { ...process.env, KQ_CONFIG_FILE: cliConfigFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`kq ${args.join(" ")} failed with exit ${exitCode}\n${stdout}\n${stderr}`);
  }
  return { stdout, stderr };
}

function parseRunId(stdout: string): string {
  const match = /Run ID: ([0-9a-f-]{36})/.exec(stdout);
  if (!match?.[1]) {
    throw new Error(`CLI output did not contain a run id:\n${stdout}`);
  }
  return match[1];
}

async function pollWorkflow(
  runId: string,
  expectedStatus: "completed" | "failed",
  timeoutMs: number,
): Promise<WorkflowRunDetail> {
  const deadline = Date.now() + timeoutMs;
  let last: WorkflowRunDetail | undefined;
  while (Date.now() < deadline) {
    last = await api<WorkflowRunDetail>(`/api/workflows/${runId}`, { method: "GET" });
    if (last.status === expectedStatus) {
      return last;
    }
    if (last.status === "completed" || last.status === "failed" || last.status === "cancelled") {
      throw new Error(`Workflow ${runId} ended with unexpected status: ${JSON.stringify(last)}`);
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Workflow ${runId} did not reach ${expectedStatus}: ${JSON.stringify(last)}`);
}

async function api<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${stack.adminToken}`);
  const res = await fetch(`${stack.serverBaseUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface WorkflowRunDetail {
  id: string;
  status: string;
  stepJobs: Record<string, string>;
  result?: {
    status: Record<string, string>;
    values: Record<string, { status: string; values: Record<string, unknown> }>;
  } | null;
}

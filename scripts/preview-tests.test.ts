import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

const root = resolve(import.meta.dir, "..");
const sourceRef = "${{ inputs.source_sha || github.event.pull_request.head.sha || github.sha }}";
const sourceSha = "a".repeat(40);
const repository = "example/platform";
const sourceHead = { sha: sourceSha, ref: "feat/preview", repo: { full_name: repository } };
const suites = {
  ci: "ci.yml",
  schedulers: "pr-scheduler-tests.yml",
  workflows: "spack-workflow-execution.yml",
};

interface Step {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Job {
  name?: string;
  if?: string;
  needs?: string | string[];
  uses?: string;
  secrets?: unknown;
  with?: Record<string, unknown>;
  outputs?: Record<string, string>;
  steps?: Step[];
  strategy?: {
    "fail-fast": boolean;
    matrix: {
      case?: string[];
      scheduler?: string[];
      include?: { label?: string; case?: string; flag: string }[];
    };
  };
}

interface Workflow {
  name: string;
  "run-name"?: string;
  on: Record<
    string,
    {
      branches?: string[];
      paths?: string[];
      types?: string[];
      inputs?: Record<string, { type: string; required?: boolean; default?: unknown }>;
    } | null
  >;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
}

async function workflow(name = "preview-tests.yml"): Promise<Workflow> {
  return parse(await readFile(resolve(root, ".github/workflows", name), "utf8")) as Workflow;
}

interface PullRequest {
  number: number;
  state: string;
  draft: boolean;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } | null };
}

interface ResolverContext {
  eventName: string;
  repo: { owner: string; repo: string };
  ref: string;
  sha: string;
  payload: {
    pull_request?: PullRequest;
    inputs?: { pr_number?: unknown };
  };
}

async function resolverFixture(eventName = "pull_request") {
  const preview = await workflow();
  const script = preview.jobs.resolve?.steps?.find((step) => step.id === "source")?.with?.script;
  if (typeof script !== "string") throw new Error("Missing preview resolver");
  const pr: PullRequest = {
    number: 17,
    state: "open",
    draft: false,
    head: structuredClone(sourceHead),
    base: { ref: "feat/stacked-base", repo: { full_name: repository } },
  };
  const context: ResolverContext = {
    eventName,
    repo: { owner: "example", repo: "platform" },
    ref: eventName === "pull_request" ? "refs/pull/17/merge" : "refs/heads/feat/preview",
    sha: eventName === "pull_request" ? "b".repeat(40) : sourceSha,
    payload:
      eventName === "pull_request"
        ? { pull_request: structuredClone(pr) }
        : { inputs: { pr_number: "17" } },
  };
  const outputs = new Map<string, string>();
  const requests: number[] = [];
  const github = {
    rest: {
      pulls: {
        get: async (input: { owner: string; repo: string; pull_number: number }) => {
          expect(input.owner).toBe("example");
          expect(input.repo).toBe("platform");
          requests.push(input.pull_number);
          return { data: pr };
        },
      },
    },
  };
  const core = { setOutput: (name: string, value: string) => outputs.set(name, value) };
  const execute = runInNewContext(`(async ({ github, context, core }) => {\n${script}\n})`) as (
    args: { github: typeof github; context: ResolverContext; core: typeof core },
  ) => Promise<void>;
  return {
    pr,
    context,
    github,
    outputs,
    requests,
    execute: () => execute({ github, context, core }),
  };
}

describe("preview source resolution", () => {
  test("accepts a stacked PR head rather than the event merge commit", async () => {
    const fixture = await resolverFixture();
    await fixture.execute();
    expect(fixture.requests).toEqual([17]);
    expect([...fixture.outputs]).toEqual([["source_sha", sourceSha]]);
    expect(fixture.context.sha).not.toBe(sourceSha);
  });

  test("accepts dispatch only on the current PR head branch and commit", async () => {
    const fixture = await resolverFixture("workflow_dispatch");
    await fixture.execute();
    expect(fixture.requests).toEqual([17]);
    expect([...fixture.outputs]).toEqual([["source_sha", sourceSha]]);
  });

  const invalidPullRequests: [string, Partial<PullRequest>][] = [
    ["closed", { state: "closed" }],
    ["draft", { draft: true }],
    ["fork", { head: { ...sourceHead, repo: { full_name: "other/platform" } } }],
    ["deleted head repository", { head: { ...sourceHead, repo: null } }],
    ["other base repository", { base: { ref: "main", repo: { full_name: "other/platform" } } }],
    ["invalid SHA", { head: { ...sourceHead, sha: "main" } }],
    ["updated head", { head: { ...sourceHead, sha: "c".repeat(40) } }],
  ];

  test.each(invalidPullRequests)("rejects %s", async (_label, change) => {
    for (const event of ["pull_request", "workflow_dispatch"]) {
      const fixture = await resolverFixture(event);
      Object.assign(fixture.pr, change);
      await expect(fixture.execute()).rejects.toThrow();
      expect(fixture.outputs.size).toBe(0);
    }
  });

  const invalidDispatches: [string, Partial<ResolverContext>][] = [
    ["another branch", { ref: "refs/heads/main" }],
    ["tag", { ref: "refs/tags/preview" }],
    ["stale SHA", { sha: "b".repeat(40) }],
    ["zero PR number", { payload: { inputs: { pr_number: "0" } } }],
    ["non-numeric PR", { payload: { inputs: { pr_number: "17;exit" } } }],
    ["numeric input", { payload: { inputs: { pr_number: 17 } } }],
    ["missing PR number", { payload: { inputs: {} } }],
    ["unsafe integer", { payload: { inputs: { pr_number: "9007199254740992" } } }],
  ];

  test.each(invalidDispatches)("rejects dispatch %s", async (_label, change) => {
    const fixture = await resolverFixture("workflow_dispatch");
    Object.assign(fixture.context, change);
    await expect(fixture.execute()).rejects.toThrow();
    expect(fixture.outputs.size).toBe(0);
  });

  test("rejects an event from a different source repository", async () => {
    const fixture = await resolverFixture();
    if (!fixture.context.payload.pull_request) throw new Error("Missing PR fixture");
    fixture.context.payload.pull_request.head.repo = { full_name: "other/platform" };
    await expect(fixture.execute()).rejects.toThrow();
    expect(fixture.outputs.size).toBe(0);
  });

  test("rejects unsupported events before looking up a PR", async () => {
    const fixture = await resolverFixture("push");
    await expect(fixture.execute()).rejects.toThrow();
    expect(fixture.requests).toEqual([]);
    expect(fixture.outputs.size).toBe(0);
  });

  test("fails closed on PR API failure", async () => {
    const fixture = await resolverFixture();
    fixture.github.rest.pulls.get = async () => {
      throw new Error("Fixture lookup unavailable");
    };
    await expect(fixture.execute()).rejects.toThrow("Fixture lookup unavailable");
    expect(fixture.outputs.size).toBe(0);
  });
});

describe("preview test orchestration", () => {
  test("has unrestricted PR bases and read-only permissions", async () => {
    const preview = await workflow();
    expect(preview.name).toBe("PR preview tests");
    expect(Object.keys(preview.on).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    expect(preview.on.pull_request).toEqual({
      types: ["opened", "synchronize", "reopened", "ready_for_review", "labeled", "unlabeled"],
    });
    expect(preview.on.workflow_dispatch?.inputs?.pr_number).toMatchObject({
      type: "string",
      required: true,
    });
    expect(preview.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(preview.jobs.resolve?.outputs).toEqual({
      source_sha: "${{ steps.source.outputs.source_sha }}",
    });
    const resolveSteps = preview.jobs.resolve?.steps ?? [];
    expect(resolveSteps.some((step) => step.uses?.includes("checkout"))).toBe(false);
    expect(Object.keys(preview.jobs).sort()).toEqual([
      "all-required-tests",
      "ci",
      "resolve",
      "schedulers",
      "workflows",
    ]);
    for (const [id, file] of Object.entries(suites)) {
      const job = preview.jobs[id];
      expect(job?.name).toBe(id);
      expect(job?.needs).toBe("resolve");
      expect(job?.uses).toBe(`./.github/workflows/${file}`);
      expect(job?.secrets).toBeUndefined();
      expect(job?.if).toBeUndefined();
      expect(job?.with).toEqual({
        source_sha: "${{ needs.resolve.outputs.source_sha }}",
        ...(id === "ci" ? { run_runtime_checks: true } : {}),
      });
    }
  });

  test("title, resolver and concurrency share the ignored-label predicate", async () => {
    const preview = await workflow();
    const ignoredLabelCondition =
      "((github.event.action == 'labeled' && github.event.label.name != 'TRUST_PR_CREATOR') || " +
      "(github.event.action == 'unlabeled' && github.event.label.name != 'preview-paused'))";
    const normalize = (expression: string) => expression.replace(/\s+/g, " ").trim();
    expect(normalize(preview["run-name"] ?? "")).toContain(ignoredLabelCondition);
    expect(normalize(preview.jobs.resolve?.if ?? "")).toContain(`!${ignoredLabelCondition}`);
    expect(normalize(preview.concurrency.group)).toContain(ignoredLabelCondition);
  });

  test("label titles match resolution while fork and draft guards remain independent", async () => {
    const preview = await workflow();
    const condition = preview.jobs.resolve?.if;
    if (!condition) throw new Error("Missing preview event guard");
    const titleExpression = preview["run-name"]?.trim().match(/^\$\{\{([\s\S]*)\}\}$/)?.[1];
    if (!titleExpression) throw new Error("Missing preview run-name expression");
    const events: [string, string, boolean][] = [
      ["opened", "", true],
      ["synchronize", "", true],
      ["reopened", "", true],
      ["ready_for_review", "", true],
      ["labeled", "TRUST_PR_CREATOR", true],
      ["unlabeled", "preview-paused", true],
      ["labeled", "preview-paused", false],
      ["unlabeled", "TRUST_PR_CREATOR", false],
      ["labeled", "documentation", false],
      ["unlabeled", "documentation", false],
    ];
    for (const [action, label, accepted] of events) {
      for (const draft of [false, true]) {
        for (const sameRepository of [false, true]) {
          const github = {
            event_name: "pull_request",
            repository,
            event: {
              action,
              label: { name: label },
              pull_request: {
                draft,
                head: {
                  repo: { full_name: sameRepository ? repository : "other/platform" },
                },
              },
            },
          };
          expect(runInNewContext(condition, { github })).toBe(
            accepted && !draft && sameRepository,
          );
          expect(runInNewContext(titleExpression, { github })).toBe(
            accepted ? "PR preview tests" : "PR preview tests (ignored label event)",
          );
        }
      }
    }
    const dispatch = { github: { event_name: "workflow_dispatch" } };
    expect(runInNewContext(condition, dispatch)).toBe(true);
    expect(runInNewContext(titleExpression, dispatch)).toBe("PR preview tests");
  });

  test("ignored labels cannot cancel an eligible test run", async () => {
    const preview = await workflow();
    const group = preview.concurrency.group;
    expect(preview.concurrency["cancel-in-progress"]).toBe(true);
    const key = (action: string, label: string) =>
      group.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expression: string) =>
        String(
          runInNewContext(expression, {
            github: {
              event: {
                action,
                label: { name: label },
                pull_request: { number: 17 },
              },
              run_id: 123,
              ref: "refs/pull/17/merge",
            },
            inputs: {},
          }),
        ),
      );
    const eligible = key("synchronize", "");
    expect(key("labeled", "TRUST_PR_CREATOR")).toBe(eligible);
    expect(key("unlabeled", "preview-paused")).toBe(eligible);
    const ignoredLabels: [string, string][] = [
      ["labeled", "documentation"],
      ["unlabeled", "documentation"],
      ["labeled", "preview-paused"],
      ["unlabeled", "TRUST_PR_CREATOR"],
    ];
    for (const [action, label] of ignoredLabels) {
      expect(key(action, label)).not.toBe(eligible);
    }
  });

  test("pins all checkouts and keeps reusable concurrency separate", async () => {
    for (const file of [...Object.values(suites), "spack-material-artifacts.yml"]) {
      const child = await workflow(file);
      expect(child.on.workflow_call?.inputs?.source_sha?.type).toBe("string");
      expect(child.concurrency.group).toContain("inputs.source_sha && github.run_id");
      expect(child.permissions).toEqual({ contents: "read" });
      for (const job of Object.values(child.jobs)) {
        expect(job.secrets).toBeUndefined();
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith("actions/checkout@")) continue;
          expect(step.with).toMatchObject({ ref: sourceRef, "persist-credentials": false });
        }
      }
    }
    for (const file of Object.values(suites)) {
      expect((await workflow(file)).on.workflow_call?.inputs?.source_sha?.required).toBe(true);
    }
  });

  test("does not skip reusable runtime suites based on the caller event", async () => {
    const ci = await workflow("ci.yml");
    expect(ci.on.pull_request?.branches).toBeUndefined();
    const required = [
      "lint-and-typecheck",
      "spack-artifact-imports",
      "test",
      "e2e-slice",
      "rustfs-deployments",
      "spack-lifecycle-portal",
      "spack-upstream",
    ];
    for (const id of required) {
      expect(ci.jobs[id]?.if).toBe("inputs.run_runtime_checks || inputs.source_sha");
    }
    expect(ci.jobs["spack-artifact-imports"]?.with).toMatchObject({
      source_sha: sourceRef,
      publish_artifact: false,
      acknowledge_redistribution: false,
    });
    for (const file of [suites.schedulers, suites.workflows]) {
      const child = await workflow(file);
      expect(Object.keys(child.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
      for (const job of Object.values(child.jobs)) expect(job.if).toBeUndefined();
    }
    const commands = ci.jobs["lint-and-typecheck"]?.steps?.map((step) => step.run ?? "").join("\n");
    expect(commands).toContain("bun test deploy/preview/*.test.* deploy/seed/*.test.*");
    expect(commands).toContain(
      "bun node_modules/typescript/bin/tsc --project deploy/seed/tsconfig.json",
    );
    expect(commands).toContain("for script in deploy/preview/*.cjs; do");
    expect(commands).toContain('node --check "$script"');
    expect(commands).toContain("bash -n deploy/preview/remote.sh");
    expect(commands).toContain("bun run test:helm");
    const staticSteps = ci.jobs["static-checks"]?.steps ?? [];
    expect(staticSteps.some((step) => step.run === "bun test scripts/preview-tests.test.ts")).toBe(
      true,
    );
  });

  test("retains all required matrix cases", async () => {
    const ci = await workflow(suites.ci);
    expect(ci.jobs["spack-artifact-imports"]?.strategy?.matrix.case).toEqual(["hello", "samtools"]);
    const schedulers = await workflow(suites.schedulers);
    const managedCases = schedulers.jobs["spack-managed"]?.strategy?.matrix.include ?? [];
    expect(managedCases.map((entry) => entry.label)).toEqual([
      "GNU Hello",
      "samtools",
      "GNU Hello artifact bootstrap",
      "samtools artifact bootstrap",
      "GNU Hello Web import",
      "samtools Web import",
    ]);
    expect(managedCases.map((entry) => entry.flag)).toEqual([
      "--spack-managed",
      "--spack-samtools",
      "--spack-artifact-hello",
      "--spack-artifact-samtools",
      "--spack-web-hello",
      "--spack-web-samtools",
    ]);
    expect(schedulers.jobs.scheduler?.strategy?.matrix.scheduler).toEqual(["slurm", "pbs"]);
    expect(schedulers.jobs.scheduler?.name).toBe("Scheduler (${{ matrix.scheduler }})");
    expect(schedulers.jobs["spack-case"]).toBeDefined();
    const workflows = await workflow(suites.workflows);
    const managedWorkflow = workflows.jobs["managed-workflow"];
    expect(managedWorkflow?.needs).toBe("contracts");
    expect(managedWorkflow?.name).toBe("Managed workflow (${{ matrix.case }})");
    const workflowCases = managedWorkflow?.strategy?.matrix.include ?? [];
    expect(workflowCases.map((entry) => entry.case)).toEqual(["hello", "samtools", "samtools-file"]);
  });

  test("runs real seed DB contracts between migrations and unit tests", async () => {
    const ci = await workflow(suites.ci);
    const steps = ci.jobs.test?.steps ?? [];
    const migrations = steps.findIndex((step) => step.run === "bun run db:migrate");
    const seed = steps.findIndex((step) => step.run === "bun test deploy/seed/store.test.ts");
    const unit = steps.findIndex((step) => step.run === "bun run test:unit");
    expect(migrations).toBeGreaterThanOrEqual(0);
    expect(seed).toBeGreaterThan(migrations);
    expect(unit).toBeGreaterThan(seed);
    expect(steps[seed]?.if).toBeUndefined();
    expect(steps[seed]?.env).toEqual({
      SEED_TEST_DATABASE_URL: "postgres://kq:kq@localhost:5432/kuintessence",
      LOG_LEVEL: "warn",
    });
  });

  test("freezes explicit child names for the deployment gate", async () => {
    const names: Record<string, Record<string, string>> = {
      "ci.yml": {
        "generate-db-migrations": "Generate database migrations",
        "static-checks": "Static checks",
        "lint-and-typecheck": "Full typecheck + Helm validation",
        "spack-artifact-imports": "Spack artifact imports (${{ matrix.case }})",
        test: "Unit + integration tests",
        "e2e-slice": "E2E slice (CLI -> Server -> Agent -> Slurm)",
        "rustfs-deployments": "RustFS Compose + AIO",
        "spack-lifecycle-portal": "Spack lifecycle portal",
        "spack-upstream": "Spack HTTP and SOCKS online imports",
      },
      "pr-scheduler-tests.yml": {
        "spack-managed": "Spack ${{ matrix.label }} managed installation",
        "spack-case": "Spack GNU Hello single-step case",
        scheduler: "Scheduler (${{ matrix.scheduler }})",
      },
      "spack-workflow-execution.yml": {
        contracts: "contracts",
        "managed-workflow": "Managed workflow (${{ matrix.case }})",
      },
      "spack-material-artifacts.yml": {
        "export-and-import": "export-and-import",
      },
    };
    for (const [file, expected] of Object.entries(names)) {
      const child = await workflow(file);
      const actual = Object.fromEntries(
        Object.entries(child.jobs).map(([id, job]) => [id, job.name]),
      );
      expect(actual).toEqual(expected);
    }
  });

  test("the final gate rejects every non-success suite result", async () => {
    const gate = (await workflow()).jobs["all-required-tests"];
    expect(gate?.name).toBe("all-required-tests");
    expect(gate?.if).toBe("always() && needs.resolve.result != 'skipped'");
    for (const result of ["success", "failure", "cancelled", "skipped"]) {
      expect(
        runInNewContext(gate?.if ?? "", {
          always: () => true,
          needs: { resolve: { result } },
        }),
      ).toBe(result !== "skipped");
    }
    expect(gate?.needs).toEqual(["resolve", "ci", "schedulers", "workflows"]);
    const step = gate?.steps?.[0];
    expect(step?.env).toEqual({
      RESOLVE_RESULT: "${{ needs.resolve.result }}",
      CI_RESULT: "${{ needs.ci.result }}",
      SCHEDULERS_RESULT: "${{ needs.schedulers.result }}",
      WORKFLOWS_RESULT: "${{ needs.workflows.result }}",
    });
    if (!step?.run) throw new Error("Missing all-required-tests gate");
    const success = {
      RESOLVE_RESULT: "success",
      CI_RESULT: "success",
      SCHEDULERS_RESULT: "success",
      WORKFLOWS_RESULT: "success",
    };
    const cases = [{ results: success, accepted: true }];
    for (const key of Object.keys(success)) {
      for (const value of ["failure", "cancelled", "skipped", "neutral", "", "SUCCESS"]) {
        cases.push({ results: { ...success, [key]: value }, accepted: false });
      }
    }
    for (const input of cases) {
      const child = Bun.spawn({
        cmd: ["bash", "-euo", "pipefail", "-c", step.run],
        env: { PATH: process.env.PATH, ...input.results },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ results: input.results, accepted: code === 0 }).toEqual(input);
    }
  });
});

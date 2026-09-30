const { describe, expect, test } = require("bun:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const { testsPassed, REQUIRED_JOBS } = require("./gate.cjs");

const BASE = [
  "resolve",
  "ci / Static checks",
  "ci / Full typecheck + Helm validation",
  "ci / Unit + integration tests",
  "ci / RustFS Compose + AIO",
  "all-required-tests",
];
const SPACK = [
  "ci / Spack artifact imports (hello) / export-and-import",
  "ci / Spack artifact imports (samtools) / export-and-import",
  "ci / Spack lifecycle portal",
  "ci / Spack HTTP and SOCKS online imports",
  "schedulers / Spack GNU Hello managed installation",
  "schedulers / Spack samtools managed installation",
  "schedulers / Spack GNU Hello artifact bootstrap managed installation",
  "schedulers / Spack samtools artifact bootstrap managed installation",
  "schedulers / Spack GNU Hello Web import managed installation",
  "schedulers / Spack samtools Web import managed installation",
  "schedulers / Spack GNU Hello single-step case",
  "workflows / contracts",
  "workflows / Managed workflow (hello)",
  "workflows / Managed workflow (samtools)",
  "workflows / Managed workflow (samtools-file)",
];
const SCHEDULERS = [
  "ci / E2E slice (CLI -> Server -> Agent -> Slurm)",
  "schedulers / Scheduler (slurm)",
  "schedulers / Scheduler (pbs)",
];
const scopes = [
  { spack: false, schedulers: false },
  { spack: true, schedulers: false },
  { spack: false, schedulers: true },
  { spack: true, schedulers: true },
];
const job = (name, conclusion = "success") => ({ name, status: "completed", conclusion });
const namesFor = (scope) => [
  ...BASE, ...(scope.spack ? SPACK : []), ...(scope.schedulers ? SCHEDULERS : []),
];
const jobsFor = (scope) => namesFor(scope).map((name) => job(name));
const fullJobs = () => REQUIRED_JOBS.map((name) => job(name));

describe("scoped test suite acceptance", () => {
  test("retains the complete legacy REQUIRED_JOBS contract and strict default", () => {
    expect([...REQUIRED_JOBS].sort()).toEqual([...BASE, ...SPACK, ...SCHEDULERS].sort());
    expect(testsPassed(fullJobs())).toBe(true);
    expect(testsPassed([...fullJobs(), job("Additional successful check")])).toBe(true);
    expect(testsPassed(BASE.map((name) => job(name)))).toBe(false);
  });

  test.each(scopes)("requires exactly the selected groups for %j", (scope) => {
    const selected = jobsFor(scope);
    const omitted = REQUIRED_JOBS.filter((name) => !namesFor(scope).includes(name));
    expect(testsPassed(selected, scope)).toBe(true);
    expect(testsPassed([...selected, ...omitted.map((name) => job(name, "skipped"))], scope)).toBe(true);
    expect(testsPassed(fullJobs(), scope)).toBe(true);
    for (const name of namesFor(scope)) {
      expect(testsPassed(selected.filter((entry) => entry.name !== name), scope)).toBe(false);
      for (const conclusion of ["skipped", "failure", "cancelled", "timed_out", null]) {
        expect(testsPassed(selected.map((entry) => entry.name === name ? job(name, conclusion) : entry), scope))
          .toBe(false);
      }
    }
    for (const name of omitted) {
      for (const conclusion of ["failure", "cancelled", "timed_out", null]) {
        expect(testsPassed([...selected, job(name, conclusion)], scope)).toBe(false);
      }
    }
  });

  test("never exempts unknown skipped names or the required ci reusable caller", () => {
    const scope = scopes[0];
    for (const name of [
      "unknown", "ci", "ci / New optional test", "workflows / unknown",
      "schedulers / Spack unknown", "ci / Spack artifact imports (unknown)",
      "workflows / Managed workflow (unknown)", "schedulers / Scheduler (unknown)",
    ]) {
      expect(testsPassed([...jobsFor(scope), job(name, "skipped")], scope)).toBe(false);
    }
    expect(testsPassed([
      ...jobsFor(scope), job("ci / Generate database migrations", "skipped"),
    ], scope)).toBe(true);
  });

  test.each([
    ["ci / spack-artifact-imports", "spack"],
    ["ci / Spack artifact imports", "spack"],
    ["ci / Spack artifact imports ()", "spack"],
    ["ci / Spack artifact imports (${{ matrix.case }})", "spack"],
    ["ci / Spack artifact imports (hello)", "spack"],
    ["ci / Spack artifact imports (samtools)", "spack"],
    ["schedulers / spack-managed", "spack"],
    ["schedulers / Spack managed installation", "spack"],
    ["schedulers / Spack  managed installation", "spack"],
    ["schedulers / Spack ${{ matrix.label }} managed installation", "spack"],
    ["workflows / managed-workflow", "spack"],
    ["workflows / Managed workflow", "spack"],
    ["workflows / Managed workflow ()", "spack"],
    ["workflows / Managed workflow (${{ matrix.case }})", "spack"],
    ["workflows", "spack"],
    ["schedulers / scheduler", "schedulers"],
    ["schedulers / Scheduler", "schedulers"],
    ["schedulers / Scheduler ()", "schedulers"],
    ["schedulers / Scheduler (${{ matrix.scheduler }})", "schedulers"],
  ])("only permits unselected completed skipped placeholder %s", (name, group) => {
    const selected = { spack: false, schedulers: false, [group]: true };
    expect(testsPassed([...jobsFor(scopes[0]), job(name, "skipped")], scopes[0])).toBe(true);
    expect(testsPassed([...jobsFor(selected), job(name, "skipped")], selected)).toBe(false);
    for (const conclusion of ["failure", "cancelled", "timed_out", null]) {
      expect(testsPassed([...jobsFor(scopes[0]), job(name, conclusion)], scopes[0])).toBe(false);
    }
  });

  test("the scheduler reusable placeholder requires both its groups to be unselected", () => {
    for (const scope of scopes) {
      expect(testsPassed([...jobsFor(scope), job("schedulers", "skipped")], scope))
        .toBe(!scope.spack && !scope.schedulers);
    }
  });

  test("rejects malformed scopes, unfinished jobs and duplicate names", () => {
    for (const scope of [null, {}, false, { spack: false }, { spack: "false", schedulers: false }]) {
      expect(testsPassed(fullJobs(), scope)).toBe(false);
    }
    for (const jobs of [null, {}, [null], []]) expect(testsPassed(jobs, scopes[0])).toBe(false);
    for (const status of ["queued", "in_progress", undefined]) {
      expect(testsPassed([...jobsFor(scopes[0]), { ...job("workflows", "skipped"), status }], scopes[0]))
        .toBe(false);
    }
    for (const scope of scopes) {
      expect(testsPassed([...jobsFor(scope), job("resolve")], scope)).toBe(false);
    }
    expect(testsPassed([
      ...jobsFor(scopes[0]), job(SPACK[0], "skipped"), job(SPACK[0], "skipped"),
    ], scopes[0])).toBe(false);
  });
});

const sha = "a".repeat(40);
function fixture(options = {}) {
  const outputs = {};
  const scopeCalls = [];
  const requests = [];
  const run = {
    id: 12, path: ".github/workflows/preview-tests.yml", event: options.event ?? "pull_request",
    status: "completed", conclusion: "success", head_sha: sha,
    head_repository: { full_name: "example/project" }, pull_requests: [{ number: 17 }],
    ...(options.run ?? {}),
  };
  const pr = {
    number: 17, state: "open", draft: false, user: { login: "member" },
    changed_files: options.files?.length ?? 0,
    labels: [{ name: "TRUST_PR_CREATOR" }],
    base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "example/project" } },
    head: { sha, ref: "feature", repo: { full_name: "example/project" } },
    ...(options.pr ?? {}),
  };
  let pullReads = 0;
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: ++pullReads > 1 ? { ...pr, ...options.reread } : pr }),
        listFiles: "files",
      },
      repos: { getCollaboratorPermissionLevel: async () => ({
        data: { permission: options.permission ?? "write" },
      }) },
      actions: {
        getWorkflowRun: async () => ({ data: run }),
        listJobsForWorkflowRun: "jobs",
        listWorkflowRuns: "runs",
      },
    },
    paginate: async (method, params) => {
      requests.push({ method, params });
      if (options.queryError === method) throw new Error("Mock API unavailable");
      if (method === "jobs") {
        return params.run_id === run.id
          ? options.jobs ?? jobsFor(scopes[0])
          : options.newerJobs ?? [job("resolve", "skipped")];
      }
      if (method === "runs") return options.runs ?? [run];
      if (method === "files") return options.files;
      throw new Error("Unexpected API method");
    },
  };
  const context = {
    repo: { owner: "example", repo: "project" },
    payload: {
      workflow_run: run, repository: { default_branch: "main" },
      inputs: { scope: { spack: false, schedulers: false } },
    },
  };
  const core = {
    setOutput: (key, value) => { outputs[key] = value; },
    info: () => {},
  };
  const module = { exports: {} };
  runInNewContext(readFileSync(join(__dirname, "gate.cjs"), "utf8"), {
    module,
    require: (name) => {
      expect(name).toBe("./test-scope.cjs");
      return { pullRequestScope: async (...args) => {
        scopeCalls.push(args);
        if (options.scopeError) throw new Error("Mock scope unavailable");
        if (options.files) return require("./test-scope.cjs").pullRequestScope(...args);
        return options.scope ?? scopes[0];
      } };
    },
  });
  return {
    outputs, scopeCalls, requests, github, context, pr, run,
    execute: () => module.exports.gate({ github, context, core }),
  };
}

describe("trusted controller scope derivation", () => {
  test.each(["pull_request", "workflow_dispatch"])("legacy complete %s runs need no scope API", async (event) => {
    const state = fixture({ event, jobs: fullJobs(), scopeError: true });
    await state.execute();
    expect(state.outputs.allowed).toBe("true");
    expect(state.scopeCalls).toHaveLength(0);
  });

  test.each(scopes)("scoped PR runs derive %j from the live PR through the controller", async (scope) => {
    const state = fixture({ scope, jobs: jobsFor(scope) });
    await state.execute();
    expect(state.outputs.allowed).toBe("true");
    expect(state.scopeCalls).toHaveLength(scope.spack && scope.schedulers ? 0 : 1);
    if (state.scopeCalls.length) {
      const [github, repo, pr] = state.scopeCalls[0];
      expect(github).toBe(state.github);
      expect(repo).toBe(state.context.repo);
      expect(pr).toBe(state.pr);
    }
    expect(state.outputs.sha).toBe(sha);
    expect(state.requests[0].params.filter).toBe("latest");
    expect(state.requests.at(-1).params.head_sha).toBe(sha);
  });

  test("dispatch requires every group even if the payload claims an empty scope", async () => {
    const state = fixture({ event: "workflow_dispatch", scopeError: true });
    await state.execute();
    expect(state.outputs.allowed).toBe("false");
    expect(state.scopeCalls).toHaveLength(0);
  });

  test("PR-reported scope cannot exempt groups selected by the trusted helper", async () => {
    const state = fixture({ scope: { spack: true, schedulers: true } });
    await state.execute();
    expect(state.outputs.allowed).toBe("false");
    expect(state.scopeCalls).toHaveLength(1);
  });

  test("real scope helper checks PR files and both sides of renames", async () => {
    const docs = fixture({ files: [{ filename: "docs/preview.md", status: "modified" }] });
    await docs.execute();
    expect(docs.outputs.allowed).toBe("true");
    expect(docs.requests.find(({ method }) => method === "files").params).toEqual({
      owner: "example", repo: "project", pull_number: 17, per_page: 100,
    });
    const renamed = fixture({ files: [{
      filename: "docs/preview.md", previous_filename: "packages/agent/src/spack/runtime.ts", status: "renamed",
    }] });
    await renamed.execute();
    expect(renamed.outputs.allowed).toBe("false");
  });

  test.each([
    "packages/server/src/grpc/dispatcher.ts",
    ".github/workflows/pr-scheduler-tests.yml",
  ])("real helper requires Spack as well as scheduler success for %s", async (filename) => {
    const files = [{ filename, status: "modified" }];
    for (const spackJobs of [[], SPACK.map((name) => job(name, "skipped"))]) {
      const state = fixture({
        files,
        jobs: [...jobsFor({ spack: false, schedulers: true }), ...spackJobs],
      });
      await state.execute();
      expect(state.scopeCalls).toHaveLength(1);
      expect(state.requests.some(({ method }) => method === "files")).toBe(true);
      expect(state.outputs.allowed).toBe("false");
      expect(state.outputs.sha).toBeUndefined();
    }
    const complete = fixture({ files, jobs: fullJobs() });
    await complete.execute();
    expect(complete.outputs.allowed).toBe("true");
    expect(complete.outputs.sha).toBe(sha);
    expect(complete.scopeCalls).toHaveLength(0);
  });

  test("real scope lookup and PR snapshot failures cannot open the gate", async () => {
    for (const options of [
      { queryError: "files" },
      { reread: { base: { sha: "c".repeat(40) } } },
      { reread: { head: { sha: "c".repeat(40) } } },
      { pr: { changed_files: 2 } },
    ]) {
      const state = fixture({ files: [{ filename: "docs/preview.md" }], ...options });
      await expect(state.execute()).rejects.toThrow();
      expect(state.outputs.allowed).toBe("false");
    }
  });

  test.each(["scope", "jobs", "runs"])("query failure at %s remains fail closed", async (stage) => {
    const state = fixture({ scopeError: stage === "scope", queryError: stage });
    await expect(state.execute()).rejects.toThrow();
    expect(state.outputs.allowed).toBe("false");
    expect(state.outputs.sha).toBeUndefined();
  });

  test.each([
    { permission: "read" },
    { pr: { labels: [] } },
    { pr: { state: "closed" } },
    { pr: { draft: true } },
    { pr: { base: { ref: "other" } } },
    { pr: { head: { sha: "c".repeat(40), repo: { full_name: "example/project" } } } },
    { pr: { head: { sha, repo: { full_name: "fork/project" } } } },
    { run: { event: "push" } },
    { run: { path: ".github/workflows/another.yml" } },
    { run: { conclusion: "failure" } },
  ])("retains live trust and revision rejection before reading scope: %j", async (options) => {
    const state = fixture(options);
    await state.execute();
    expect(state.outputs.allowed).toBe("false");
    expect(state.scopeCalls).toHaveLength(0);
  });

  test("a scoped green run cannot bypass a newer failed or unfinished run", async () => {
    for (const status of ["completed", "in_progress"]) {
      const state = fixture();
      const newer = { ...state.run, id: 13, status, conclusion: status === "completed" ? "failure" : null };
      const checked = fixture({ runs: [state.run, newer] });
      await checked.execute();
      expect(checked.scopeCalls).toHaveLength(1);
      expect(checked.outputs.allowed).toBe("false");
    }
  });

  test("retains the exact ignored-label exception but rejects one that actually ran tests", async () => {
    const original = fixture();
    const newer = { ...original.run, id: 13, display_title: "PR preview tests (ignored label event)" };
    const ignored = fixture({ runs: [newer] });
    await ignored.execute();
    expect(ignored.outputs.allowed).toBe("true");
    const ranTests = fixture({ runs: [newer], newerJobs: [job("resolve")] });
    await ranTests.execute();
    expect(ranTests.outputs.allowed).toBe("false");
  });
});

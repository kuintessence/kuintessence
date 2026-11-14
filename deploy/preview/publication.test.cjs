const { describe, expect, test } = require("bun:test");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { gate, REQUIRED_JOBS } = require("./gate.cjs");
const { COMPONENTS, imagesFromMetadata } = require("./images.cjs");
const { findPublication, handoff, publicationName } = require("./publication.cjs");
const sha = "a".repeat(40);
const tooling = "b".repeat(40);

function gateFixture() {
  const outputs = {};
  const run = {
    id: 12, run_attempt: 2, path: ".github/workflows/preview-tests.yml", event: "pull_request",
    head_sha: sha, head_repository: { full_name: "example/project" },
    status: "in_progress", conclusion: null, pull_requests: [{ number: 17 }],
  };
  const pr = {
    number: 17, state: "open", draft: false, user: { login: "member" },
    base: { ref: "main" }, head: { sha, repo: { full_name: "example/project" } },
    labels: [{ name: "TRUST_PR_CREATOR" }],
  };
  let jobsRead = false;
  const github = {
    rest: {
      actions: { getWorkflowRun: async () => ({ data: run }), listJobsForWorkflowRun: "jobs", listWorkflowRuns: "runs" },
      pulls: { get: async () => ({ data: pr }) },
      repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: "write" } }) },
    },
    paginate: async (method) => {
      if (method === "runs") return [run];
      jobsRead = true;
      return REQUIRED_JOBS.map((name) => ({ name, status: "completed", conclusion: "success" }));
    },
  };
  const context = {
    eventName: "workflow_run", repo: { owner: "example", repo: "project" },
    payload: { action: "requested", workflow_run: run, repository: { default_branch: "main" } },
  };
  return { github, context, core: { setOutput: (key, value) => { outputs[key] = value; }, info() {} },
    outputs, run, pr, jobsRead: () => jobsRead };
}

describe("parallel preview build boundaries", () => {
  test("early build checks trust but can never authorize deployment", async () => {
    const f = gateFixture();
    await gate(f, { buildOnly: true });
    expect(f.outputs).toMatchObject({ allowed: "true", tested: "false", test_attempt: "2", sha });
    expect(f.jobsRead()).toBe(false);
    await gate(f);
    expect(f.outputs.allowed).toBe("false");
    f.context.payload.action = "completed";
    await expect(gate(f, { buildOnly: true })).rejects.toThrow("requested");
    expect(f.outputs.tested).toBe("false");
    f.run.status = "completed"; f.run.conclusion = "success";
    await gate(f);
    expect(f.outputs.tested).toBe("true");
    expect(f.jobsRead()).toBe(true);
  });

  test.each(["paused", "untrusted", "failed", "ignored", "stale"])("early builds reject %s", async (state) => {
    const f = gateFixture();
    if (state === "paused") f.pr.labels.push({ name: "preview-paused" });
    if (state === "untrusted") f.pr.labels = [];
    if (state === "failed") { f.run.status = "completed"; f.run.conclusion = "failure"; }
    if (state === "ignored") f.run.display_title = "PR preview tests (ignored label event)";
    if (state === "stale") f.pr.head.sha = "c".repeat(40);
    await gate(f, { buildOnly: true });
    expect(f.outputs.allowed).toBe("false");
    expect(f.outputs.tested).toBe("false");
  });

  test("artifact discovery accepts only successful matching default-branch controllers", async () => {
    for (const change of [{}, { event: "pull_request" }, { head_branch: "feature" },
      { head_sha: sha }, { path: ".github/workflows/fake.yml" }, { conclusion: "failure" },
      { status: "in_progress" }, { head_repository: { full_name: "fork/project" } }]) {
      const outputs = {};
      const run = { id: 99, path: ".github/workflows/preview.yml", event: "workflow_run",
        head_branch: "main", head_sha: tooling, head_repository: { full_name: "example/project" },
        status: "completed", conclusion: "success", ...change };
      const name = publicationName(12, 2);
      await findPublication({
        github: { rest: { actions: { listArtifactsForRepo: "artifacts", getWorkflowRun: async () => ({ data: run }) } },
          paginate: async (_method, options) => { expect(options.name).toBe(name); return [
            { name, expired: true, workflow_run: { id: 99 } },
            { name: "wrong", expired: false, workflow_run: { id: 99 } },
            { name, expired: false, workflow_run: { id: 99 } },
          ]; } },
        context: { repo: { owner: "example", repo: "project" }, sha: tooling,
          payload: { repository: { default_branch: "main" } } },
        core: { setOutput: (key, value) => { outputs[key] = value; } },
      }, { testRun: 12, testAttempt: 2 });
      expect(outputs.reuse_run).toBe(Object.keys(change).length ? undefined : "99");
    }
  });

  test("handoff binds reuse to the exact tests, controller, source and publishing identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "kq-publication-"));
    try {
      const source = join(dir, "source.json"), target = join(dir, "images.json");
      const env = { IMAGE_OWNER: "example", PREVIEW_SHA: sha, PREVIEW_PR: "17", PREVIEW_RUN: "99",
        PREVIEW_ATTEMPT: "1", TEST_RUN_ID: "12", TEST_ATTEMPT: "2", TOOLING_SHA: tooling,
        GITHUB_OUTPUT: join(dir, "outputs") };
      const metadata = Object.fromEntries(COMPONENTS.map((name) => [name, { "containerimage.digest": `sha256:${"c".repeat(64)}` }]));
      const images = imagesFromMetadata(metadata, "example", sha, { pr: "17", run: "99", attempt: "1" });
      writeFileSync(source, JSON.stringify(images));
      const publication = handoff(source, target, env);
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(images);
      const reusedEnv = { ...env, REUSE_RUN: "99", PREVIEW_RUN: "100" };
      writeFileSync(source, JSON.stringify(publication));
      expect(handoff(source, target, reusedEnv).publishRun).toBe("99");
      for (const [key, value] of Object.entries({ testRun: "13", testAttempt: "3", toolingSha: sha, publishRun: "98", publishAttempt: "2" })) {
        writeFileSync(source, JSON.stringify({ ...publication, [key]: value }));
        expect(() => handoff(source, target, reusedEnv)).toThrow();
      }
      writeFileSync(source, JSON.stringify(publication));
      for (const [key, value] of Object.entries({ PREVIEW_SHA: tooling, PREVIEW_PR: "18", IMAGE_OWNER: "other" })) {
        expect(() => handoff(source, target, { ...reusedEnv, [key]: value })).toThrow();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

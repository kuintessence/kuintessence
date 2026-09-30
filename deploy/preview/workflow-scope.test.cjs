const { describe, expect, test } = require("bun:test");
const { workflowScope } = require("./workflow-scope.cjs");

const sha = "a".repeat(40);
const repo = { owner: "example", repo: "project" };

function fixture(message = "fix(workflow): update execution", changes = {}) {
  const pr = { number: 17, head: { sha }, base: { sha: "b".repeat(40) } };
  const requests = [];
  const github = { rest: {
    repos: { getCommit: async (input) => {
      requests.push(["commit", input]);
      return { data: { sha, commit: { message }, ...changes.commit } };
    } },
    pulls: { get: async (input) => {
      requests.push(["pull", input]);
      return { data: { ...pr, ...changes.pr } };
    } },
  } };
  return { github, pr, requests };
}

describe("workflow test tiers", () => {
  test.each([true, false])("automatic PRs select only the source-related baseline: %s", async (spack) => {
    const f = fixture();
    expect(await workflowScope(f.github, repo, f.pr, { event: "pull_request", spack }))
      .toBe(spack ? "quick" : "none");
    expect(f.requests).toEqual([
      ["commit", { ...repo, ref: sha }],
      ["pull", { ...repo, pull_number: 17 }],
    ]);
  });

  test.each([
    "[full-workflows]",
    "test(workflow): validate before merge [full-workflows]",
    "test(workflow): validate\n\n[full-workflows]\n",
    "literal $(exit 1) [full-workflows]",
  ])("only the pinned commit message can request full workflows: %s", async (message) => {
    const f = fixture(message);
    for (const spack of [true, false]) {
      expect(await workflowScope(f.github, repo, f.pr, { event: "pull_request", spack }))
        .toBe("full");
    }
  });

  test.each(["[full-workflow]", "[FULL-WORKFLOWS]", "full-workflows", "[skip ci]", ""])(
    "near matches do not opt in: %s", async (message) => {
      const f = fixture(message);
      expect(await workflowScope(f.github, repo, f.pr, { event: "pull_request", spack: true }))
        .toBe("quick");
    },
  );

  test("manual runs force the full matrix without requiring the commit API", async () => {
    const f = fixture();
    expect(await workflowScope(f.github, repo, f.pr, { event: "workflow_dispatch", spack: false }))
      .toBe("full");
    expect(f.requests).toEqual([]);
  });

  test.each([
    { commit: { sha: "c".repeat(40) } },
    { commit: { commit: {} } },
    { commit: { commit: { message: null } } },
    { pr: { head: { sha: "c".repeat(40) } } },
    { pr: { base: { sha: "c".repeat(40) } } },
  ])("fails closed on missing or stale inputs: %j", async (changes) => {
    const f = fixture("[full-workflows]", changes);
    await expect(workflowScope(f.github, repo, f.pr, { event: "pull_request", spack: true }))
      .rejects.toThrow();
  });

  test("invalid events and scope flags fail before querying GitHub", async () => {
    const f = fixture();
    for (const options of [{ event: "push", spack: true }, { event: "pull_request", spack: "true" }]) {
      await expect(workflowScope(f.github, repo, f.pr, options)).rejects.toThrow();
    }
    expect(f.requests).toEqual([]);
  });

  test("commit lookup errors never silently select quick", async () => {
    const f = fixture();
    f.github.rest.repos.getCommit = async () => { throw new Error("Unavailable"); };
    await expect(workflowScope(f.github, repo, f.pr, { event: "pull_request", spack: true }))
      .rejects.toThrow("Unavailable");
  });
});

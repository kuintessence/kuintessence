const { describe, expect, test } = require("bun:test");
const { classifyPaths, pullRequestScope } = require("./test-scope.cjs");

const NONE = { spack: false, schedulers: false };
const SPACK = { spack: true, schedulers: false };
const SCHEDULERS = { spack: false, schedulers: true };
const BOTH = { spack: true, schedulers: true };

describe("preview heavy test path policy", () => {
  test.each([
    "README.md", "README.zh-CN.md", "packages/agent/README.md",
    "docs/spack-material-lifecycle.md", "plan/ci.md", "plans/preview.md",
    "packages/docs-site/src/index.ts",
    "deploy/preview/test-scope.cjs", "deploy/preview/test-scope.test.cjs",
    "deploy/preview/scheduler.Dockerfile", "deploy/preview/remote.sh",
    "deploy/helm/kq-platform/templates/scheduler.yaml",
    ".github/workflows/preview.yml",
    ".github/workflows/preview-tests.yml", ".github/workflows/preview-cleanup.yml",
    "packages/web/src/routes/dashboard.tsx", "packages/web/src/components/ui/button.tsx",
    "packages/web/src/lib/use-motion-presence.ts", "packages/web/e2e/app-shell.spec.ts",
    "packages/web/src/routes/cp.users.tsx", "packages/web/src/styles.css",
    "packages/web/src/components/files/FilesPage.tsx",
    "packages/web/src/lib/use-media-query.ts", "packages/web/src/lib/format.ts",
    "packages/web/src/lib/query-client-notes.ts",
    "packages/cli/src/version.ts", "packages/cli/src/tui/viewport.ts",
  ])("does not enable heavy suites for %s", (filename) => {
    expect(classifyPaths([{ filename }])).toEqual(NONE);
  });

  test.each([
    "packages/cli/src/commands/software.ts", "packages/cli/src/lib/local-spack.ts",
    "packages/cli/src/lib/local-spack.test.ts",
    "packages/agent/src/spack/installer.ts",
    "packages/agent/src/spack/worker/install_worker.py",
    "packages/agent/test/integration/spack.real.test.ts",
    "packages/registry/src/services/recipe-git.ts",
    "packages/registry/src/config.ts",
    "packages/server/src/software-governance/operation-service.ts",
    "packages/server/src/services/software-availability.ts",
    "packages/server/src/routes/agent-spack-materials.ts",
    "packages/web/src/routes/software.spack.$source.$name.tsx",
    "packages/web/src/routes/agents.$agentId.software.tsx",
    "packages/web/src/routes/cp.software.tsx",
    "packages/web/src/routes/workflows/new.tsx",
    "packages/web/src/routes/workflows/index.tsx",
    "packages/web/src/routes/workflows/$runId.tsx",
    "packages/web/src/routes/workflows/-new.test.tsx",
    "packages/web/src/components/workflows/NewWorkflowPage.tsx",
    "packages/web/src/components/workflow/WorkflowEditorShell.tsx",
    "packages/web/src/components/software/MaterialLifecycle.tsx",
    "packages/web/src/lib/spack-materials-client.ts",
    "packages/web/src/lib/recipe-repositories-client.ts",
    "packages/web/src/lib/use-cp-software.ts",
    "packages/web/e2e/material-artifacts.spec.ts",
    "packages/web/e2e/fixtures/material-lifecycle.tsx",
    "packages/web/e2e/workflows.spec.ts",
    "packages/web/e2e/workflow-file-binding-layout.spec.ts",
    "packages/web/src/main.tsx",
    "packages/web/src/routeTree.gen.ts",
    "packages/web/src/routes/__root.tsx",
    "packages/web/src/routes/login.tsx",
    "packages/web/src/routes/-login.test.tsx",
    "packages/web/src/components/AppShell.tsx",
    "packages/web/src/components/ProtectedRoute.tsx",
    "packages/web/src/components/ThemeProvider.tsx",
    "packages/web/src/lib/auth.ts",
    "packages/web/src/lib/auth.test.ts",
    "packages/web/src/lib/auth-redirect.ts",
    "packages/web/src/lib/authenticated-fetch.ts",
    "packages/web/src/lib/query-client.ts",
    "packages/web/src/lib/api-client.ts",
    "packages/web/src/lib/api-schemas/workflows.ts",
    "packages/web/src/lib/local-mode.ts",
    "packages/web/src/lib/active-organization.ts",
    "packages/web/src/lib/platform-paths.ts",
    "packages/web/src/lib/platform-capabilities.ts",
    "packages/web/src/lib/mobile-management-policy.ts",
    "packages/web/src/lib/i18n.ts",
    "packages/web/src/lib/monaco-env.ts",
    "packages/web/src/locales/materials.en.json",
    "packages/web/src/locales/recipes.en.json",
    "packages/web/src/locales/workflow-editor.zh.json",
    "packages/web/index.html",
    "packages/web/nginx.conf",
    "packages/web/tsconfig.json",
    "packages/web/bunfig.toml",
    "packages/web/.env.example",
    "packages/web/vite.config.ts",
    "packages/web/playwright.config.ts",
    "scripts/spack-web-managed.test.ts", "scripts/recipe-proxy-config.test.ts",
    "scripts/generate-spack-package-metadata.ts",
    "deploy/pr-test/spack-case/scheduler.Dockerfile",
    "deploy/pr-test/spack-managed/case.ts",
    "deploy/compose/docker-compose.pr-spack-workflow.yml",
    ".github/workflows/spack-workflow-execution.yml",
    ".github/workflows/spack-material-artifacts.yml",
  ])("enables Spack for %s", (filename) => {
    expect(classifyPaths([{ filename }])).toEqual(SPACK);
  });

  test.each([
    "packages/cli/src/commands/submit.ts", "packages/cli/src/commands/cancel.ts",
    "packages/cli/src/commands/list.ts", "packages/cli/src/commands/status.test.ts",
    "packages/cli/src/commands/logs.ts", "packages/cli/src/commands/ssh.ts",
    "packages/agent/src/adapters/slurm.ts",
    "packages/agent/src/executor/job.ts",
    "packages/agent/src/executor.ts",
    "packages/server/src/scheduler/filters/software.ts",
    "packages/server/src/routes/jobs.ts",
    "packages/server/src/services/job-service.ts",
    "packages/server/src/services/queue-registry.ts",
    "test/e2e/cli-to-slurm.test.ts", "test/e2e/fixtures/stack.ts",
    "scripts/pr-scheduler-compose.test.ts",
    "deploy/pr-test/check.sh", "deploy/pr-test/scheduler-entrypoint.sh",
    "deploy/pr-test/scheduler.Dockerfile", "deploy/pr-test/configs/slurm.conf",
    "deploy/schedulers/pbs/entrypoint.sh",
    "deploy/compose/docker-compose.schedulers.yml",
    ".github/workflows/scheduler-image-architecture.yml",
  ])("enables schedulers for %s", (filename) => {
    expect(classifyPaths([{ filename }])).toEqual(SCHEDULERS);
  });

  test.each([
    "packages/cli/src/index.ts", "packages/cli/src/agent-serve/server.ts",
    "packages/cli/src/commands/workflow.ts", "packages/cli/src/commands/dsl.ts",
    "packages/cli/src/commands/agent.ts", "packages/cli/src/commands/config.ts",
    "packages/cli/src/commands/login.ts", "packages/cli/src/lib/api-client.ts",
    "packages/cli/src/lib/config.test.ts", "packages/cli/src/lib/local-scheduler.ts",
    "packages/cli/src/lib/oidc-browser-flow.ts", "packages/cli/src/lib/sse-client.ts",
    ".github/workflows/ci.yml",
    "packages/agent/src/server-client.ts", "packages/agent/src/index.ts",
    "packages/agent/src/stream.ts", "packages/agent/src/stream.test.ts",
    "packages/agent/src/config.ts", "packages/agent/src/config.test.ts",
    "packages/agent/src/sandbox/dispatch-processor.ts",
    "packages/agent/src/sandbox/runtime-reference.ts",
    "packages/agent/src/sandbox/restricted-execution-profile.ts",
    "packages/agent/src/queue/outbound-queue.ts",
    "packages/agent/src/staging/stage-in.ts",
    "packages/agent/src/new-runtime/helper.ts",
    "packages/shared/src/workflow/spack-execution.ts",
    "packages/db/migrations/0044_schema.sql",
    "packages/proto/proto/kuintessence/v1/agent_service.proto",
    "packages/server/src/services/placement-orchestrator.ts",
    "packages/server/src/services/workflow-placement-builder.ts",
    "packages/server/src/services/workflow-artifact.ts",
    "packages/server/src/services/workflow-authorization.ts",
    "packages/server/src/workflow/job-submitter.ts",
    "packages/server/src/workflow/async-runner.ts",
    "packages/server/src/workflow/runner.ts",
    "packages/server/src/workflow/execution.integration.test.ts",
    "packages/server/src/grpc/dispatcher.ts",
    "packages/server/src/grpc/dispatcher.test.ts",
    "packages/server/src/grpc/agent-handler.ts",
    "packages/server/src/grpc/server.ts",
    "packages/server/src/routes/workflows.ts",
    "packages/server/src/routes/workflows-authz-unit.test.ts",
    "packages/server/src/routes/dsl.ts",
    "packages/server/src/config.ts", "packages/server/src/index.ts",
    "package.json", "packages/web/package.json", "packages/agent/package.json",
    "packages/docs-site/package.json",
    "bun.lock", "packages/web/bun.lock", "pnpm-lock.yaml", "package-lock.json",
    "tsconfig.base.json", "packages/agent/tsconfig.json",
    ".dockerignore", "Dockerfile", "packages/server/Dockerfile",
    "deploy/dev/Dockerfile", "deploy/pr-test/workspace.Dockerfile.dockerignore",
    "deploy/schedulers/base/Dockerfile", "deploy/schedulers/slurm/Dockerfile",
    "deploy/schedulers/common/start-agent.sh",
    "deploy/pr-test/run.sh", "deploy/pr-test/runtime.ts",
    "deploy/compose/docker-compose.pr-test.yml",
    ".github/workflows/pr-scheduler-tests.yml",
  ])("conservatively enables both for shared dependency %s", (filename) => {
    expect(classifyPaths([{ filename }])).toEqual(BOTH);
  });

  test("combines independent paths without changing the input", () => {
    const files = [
      Object.freeze({ filename: "packages/agent/src/spack/installer.ts" }),
      Object.freeze({ filename: "packages/agent/src/adapters/slurm.ts" }),
    ];
    expect(classifyPaths(Object.freeze(files))).toEqual(BOTH);
    expect(classifyPaths([])).toEqual(NONE);
    expect(classifyPaths([{ filename: "docs/ci.md" }])).toEqual(NONE);
  });

  test.each(["added", "modified", "removed"])("matches %s files without reading a checkout", (status) => {
    expect(classifyPaths([{ filename: "packages/agent/src/spack/installer.ts", status }]))
      .toEqual(SPACK);
    expect(classifyPaths([{ filename: "packages/agent/src/adapters/slurm.ts", status }]))
      .toEqual(SCHEDULERS);
    expect(classifyPaths([{ filename: "packages/shared/src/index.ts", status }]))
      .toEqual(BOTH);
  });

  test("matches both rename directions, including moves into ignored paths", () => {
    for (const [oldPath, newPath, expected] of [
      ["packages/agent/src/spack/installer.ts", "docs/installer.txt", SPACK],
      ["packages/agent/src/adapters/slurm.ts", "deploy/preview/slurm.ts", SCHEDULERS],
      ["packages/shared/src/index.ts", "docs/index.ts", BOTH],
      ["packages/agent/src/spack/installer.ts", "packages/agent/src/adapters/slurm.ts", BOTH],
      ["packages/web/src/routes/workflows/new.tsx", "docs/workflow.tsx", SPACK],
      ["packages/web/src/lib/auth.ts", "docs/auth.ts", SPACK],
      ["packages/server/src/workflow/job-submitter.ts", "docs/submitter.ts", BOTH],
      ["packages/agent/src/sandbox/runtime-reference.ts", "docs/runtime.ts", BOTH],
      ["packages/server/src/grpc/dispatcher.ts", "docs/dispatcher.ts", BOTH],
      [".github/workflows/pr-scheduler-tests.yml", "docs/pr-scheduler-tests.yml", BOTH],
      [".github/workflows/ci.yml", "docs/ci.yml", BOTH],
      ["packages/cli/src/commands/submit.ts", "docs/submit.ts", SCHEDULERS],
      ["packages/cli/src/lib/local-spack.ts", "docs/local-spack.ts", SPACK],
      ["packages/cli/src/lib/api-client.ts", "docs/api-client.ts", BOTH],
    ]) {
      for (const reverse of [false, true]) {
        expect(classifyPaths([{
          status: "renamed",
          filename: reverse ? oldPath : newPath,
          previous_filename: reverse ? newPath : oldPath,
        }])).toEqual(expected);
      }
    }
  });

  test("deletions retain coverage for Web entrypoints and shared execution paths", () => {
    for (const filename of [
      "packages/web/src/main.tsx", "packages/web/src/lib/query-client.ts",
      "packages/web/src/routes/workflows/new.tsx",
    ]) {
      expect(classifyPaths([{ filename, status: "removed" }])).toEqual(SPACK);
    }
    for (const filename of [
      "packages/agent/src/stream.ts", "packages/agent/src/config.ts",
      "packages/server/src/routes/workflows.ts",
      "packages/server/src/grpc/dispatcher.ts",
      ".github/workflows/pr-scheduler-tests.yml",
    ]) {
      expect(classifyPaths([{ filename, status: "removed" }])).toEqual(BOTH);
    }
  });

  test.each([
    "", "/docs/a.md", "../docs/a.md", "./docs/a.md", "docs/../a.md",
    "docs//a.md", "docs/", "docs\\a.md", "docs/a\n.md", "docs/a\u0000.md",
    "C:/docs/a.md", null, 12,
  ])("rejects invalid current or previous path %j", (path) => {
    expect(() => classifyPaths([{ filename: path }])).toThrow("PR file path");
    expect(() => classifyPaths([{ filename: "docs/a.md", previous_filename: path }]))
      .toThrow("PR file path");
  });

  test("rejects malformed lists and duplicates even after both suites are enabled", () => {
    for (const files of [null, {}, "docs/a.md"]) {
      expect(() => classifyPaths(files)).toThrow("PR file list");
    }
    for (const file of [null, {}, [], "docs/a.md", { filename: "docs/a.md", status: "renamed" }]) {
      expect(() => classifyPaths([{ filename: "package.json" }, file])).toThrow("PR file path");
    }
    expect(() => classifyPaths([{ filename: "docs/a.md" }, { filename: "docs/a.md" }]))
      .toThrow("duplicate");
    expect(classifyPaths([{ filename: "docs/中文说明.md" }])).toEqual(NONE);
  });
});

function fixture(files = [{ filename: "docs/ci.md" }]) {
  const repo = { owner: "example", repo: "project" };
  const pr = {
    number: 17, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) },
    changed_files: files.length,
  };
  const calls = [];
  const state = { files, latest: structuredClone(pr) };
  const github = {
    rest: { pulls: {
      listFiles: "list-files",
      get: async (options) => {
        calls.push(["get", options]);
        if (state.getError) throw state.getError;
        return { data: state.latest };
      },
    } },
    paginate: async (method, options) => {
      calls.push(["paginate", method, options]);
      if (state.listError) throw state.listError;
      return state.files;
    },
  };
  return { github, repo, pr, calls, state };
}

describe("PR scope snapshot validation", () => {
  test("uses all paginated paths then rechecks the PR before returning scope", async () => {
    const files = Array.from({ length: 101 }, (_, index) => ({ filename: `docs/${index}.md` }));
    files[100] = { filename: "packages/agent/src/spack/installer.ts", status: "removed" };
    const f = fixture(files);
    expect(await pullRequestScope(f.github, f.repo, f.pr)).toEqual(SPACK);
    expect(f.calls).toEqual([
      ["paginate", "list-files", { ...f.repo, pull_number: 17, per_page: 100 }],
      ["get", { ...f.repo, pull_number: 17 }],
    ]);
  });

  test("counts rename entries once while matching both paths", async () => {
    const f = fixture([{
      filename: "docs/old.ts", previous_filename: "packages/shared/src/old.ts", status: "renamed",
    }]);
    expect(await pullRequestScope(f.github, f.repo, f.pr)).toEqual(BOTH);
  });

  test.each([0, 3000])("accepts a complete %s-file list with a stable snapshot", async (count) => {
    const f = fixture(Array.from({ length: count }, (_, index) => ({ filename: `docs/${index}.md` })));
    expect(await pullRequestScope(f.github, f.repo, f.pr)).toEqual(NONE);
    expect(f.calls).toHaveLength(2);
  });

  test.each([-1, 1.5, "1", undefined, null, NaN, Infinity])(
    "rejects invalid changed_files %s before requests",
    async (count) => {
      const f = fixture();
      f.pr.changed_files = count;
      await expect(pullRequestScope(f.github, f.repo, f.pr)).rejects.toThrow("snapshot");
      expect(f.calls).toEqual([]);
    },
  );

  test("rejects over-limit PRs instead of trusting the API's truncated listing", async () => {
    const f = fixture();
    f.pr.changed_files = 3001;
    await expect(pullRequestScope(f.github, f.repo, f.pr)).rejects.toThrow("3000-file");
    expect(f.calls).toEqual([]);
  });

  test.each(["missing", "extra", "duplicate", "not-array", "over-limit", "invalid-path"])(
    "fails closed for a %s listing",
    async (kind) => {
      const f = fixture([{ filename: "docs/a.md" }, { filename: "docs/b.md" }]);
      if (kind === "missing") f.state.files = f.state.files.slice(0, 1);
      if (kind === "extra") f.state.files = [...f.state.files, { filename: "docs/c.md" }];
      if (kind === "duplicate") f.state.files = [f.state.files[0], f.state.files[0]];
      if (kind === "not-array") f.state.files = {};
      if (kind === "over-limit") {
        f.state.files = Array.from({ length: 3001 }, (_, index) => ({ filename: `docs/${index}.md` }));
      }
      if (kind === "invalid-path") f.state.files[1] = { filename: "../docs/b.md" };
      await expect(pullRequestScope(f.github, f.repo, f.pr)).rejects.toThrow();
      expect(f.calls).toHaveLength(1);
    },
  );

  test.each(["head", "base", "count", "number"])(
    "rejects a changed %s snapshot even when the listed paths are docs-only",
    async (field) => {
      const f = fixture();
      if (field === "head") f.state.latest.head.sha = "c".repeat(40);
      if (field === "base") f.state.latest.base.sha = "c".repeat(40);
      if (field === "count") f.state.latest.changed_files++;
      if (field === "number") f.state.latest.number++;
      await expect(pullRequestScope(f.github, f.repo, f.pr)).rejects.toThrow("PR changed");
      expect(f.calls).toHaveLength(2);
    },
  );

  test.each(["number", "head", "base"])("validates initial and final %s identity", async (field) => {
    for (const latest of [false, true]) {
      const f = fixture();
      const target = latest ? f.state.latest : f.pr;
      if (field === "number") target.number = "17";
      else target[field] = { sha: "not-a-commit" };
      await expect(pullRequestScope(f.github, f.repo, f.pr)).rejects.toThrow("snapshot");
      expect(f.calls).toHaveLength(latest ? 2 : 0);
    }
  });

  test.each(["head", "base"])("rejects a trailing newline in the %s SHA", async (field) => {
    const f = fixture();
    f.pr[field].sha += "\n";
    await expect(pullRequestScope(f.github, f.repo, f.pr)).rejects.toThrow("snapshot");
    expect(f.calls).toEqual([]);
  });

  test.each(["listError", "getError"])("propagates %s without returning an empty scope", async (field) => {
    const f = fixture();
    const error = new Error("Mock GitHub API unavailable");
    f.state[field] = error;
    await expect(pullRequestScope(f.github, f.repo, f.pr)).rejects.toBe(error);
    expect(f.calls).toHaveLength(field === "listError" ? 1 : 2);
  });
});

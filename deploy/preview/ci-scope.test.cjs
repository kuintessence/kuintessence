const { describe, expect, test } = require("bun:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { classifyCIChange } = require("./ci-scope.cjs");

const NONE = { spack: false, schedulers: false };
const BOTH = { spack: true, schedulers: true };
const workflow = readFileSync(join(__dirname, "../../.github/workflows/ci.yml"), "utf8");

function editJob(source, name, field = "name", value = "Updated job") {
  const lines = source.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  for (let index = start + 1; index < lines.length && !/^  \S/.test(lines[index]); index++) {
    if (lines[index].startsWith(`    ${field}:`)) {
      lines[index] = `    ${field}: ${value}`;
      return lines.join("\n");
    }
  }
  lines.splice(start + 1, 0, `    ${field}: ${value}`);
  return lines.join("\n");
}

describe("CI job change scope", () => {
  test("adding a production image contract check does not select Spack or schedulers", () => {
    const before = workflow.replace(
      "      - name: Check production image publication contracts\n" +
      "        run: bun test scripts/production-images.test.cjs\n\n", "",
    );
    expect(before).not.toBe(workflow);
    expect(classifyCIChange(before, workflow)).toEqual(NONE);
    expect(classifyCIChange(workflow, before)).toEqual(NONE);
  });

  test.each([
    "generate-db-migrations", "static-checks", "lint-and-typecheck", "test", "rustfs-deployments",
  ])("changes to baseline job %s keep the heavy groups disabled", (job) => {
    expect(classifyCIChange(workflow, editJob(workflow, job, "timeout-minutes", "25"))).toEqual(NONE);
  });

  test.each(["spack-artifact-imports", "spack-lifecycle-portal", "spack-upstream"])(
    "changes to %s select Spack only", (job) => {
      expect(classifyCIChange(workflow, editJob(workflow, job, "timeout-minutes", "25")))
        .toEqual({ spack: true, schedulers: false });
    },
  );

  test("scheduler job edits select schedulers and combine with Spack edits", () => {
    const scheduler = editJob(workflow, "e2e-slice", "timeout-minutes", "25");
    expect(classifyCIChange(workflow, scheduler)).toEqual({ spack: false, schedulers: true });
    expect(classifyCIChange(workflow, editJob(scheduler, "spack-upstream", "timeout-minutes", "25")))
      .toEqual(BOTH);
  });

  test("step changes inside a heavy job still select its group", () => {
    expect(classifyCIChange(workflow, workflow.replace("run: bun run test:e2e", "run: bun run test:e2e --timeout=5000")))
      .toEqual({ spack: false, schedulers: true });
    expect(classifyCIChange(workflow, workflow.replace("Run complete Web unit suite", "Run Web tests")))
      .toEqual(NONE);
  });

  test("global workflow changes, job additions/removals and shared outputs select both groups", () => {
    for (const changed of [
      workflow.replace("contents: read", "contents: write"),
      workflow.replace("branches: [main]", "branches: [main, develop]"),
      workflow.replace("default: true", "default: false"),
      `${workflow}\n  unknown:\n    runs-on: ubuntu-latest\n`,
      workflow.replace(/  static-checks:\n[\s\S]*?(?=  lint-and-typecheck:)/, ""),
      editJob(workflow, "static-checks", "outputs", "{ result: value }"),
    ]) expect(classifyCIChange(workflow, changed)).toEqual(BOTH);
  });

  test("unknown job edits select both groups", () => {
    const before = `${workflow}\n  future-job:\n    runs-on: ubuntu-latest\n`;
    expect(classifyCIChange(before, before.replace("future-job:", "future-job:\n    timeout-minutes: 5")))
      .toEqual(BOTH);
  });

  test("unrecognized layout and YAML references conservatively select both groups", () => {
    for (const value of [
      null, "", "jobs: {}", "jobs:\n", "jobs:\n  test: {}\n", "jobs:\n  'test':\n    steps: []\n",
      "jobs:\n  test:\n    steps: []\n  test:\n    steps: []\n",
      workflow.replace("jobs:", "jobs: &jobs"),
      workflow.replace("  static-checks:", "  static-checks: *shared"),
      workflow.replace("    steps:", "    steps: &shared"),
      `${workflow}\nenv:\n  SHARED: true\n`,
      workflow.replace("    steps:", "\tsteps:"),
    ]) expect(classifyCIChange(workflow, value)).toEqual(BOTH);
  });

  test("identical canonical workflows select no additional heavy group", () => {
    expect(classifyCIChange(workflow, workflow)).toEqual(NONE);
  });
});

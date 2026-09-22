import { expect, spyOn, test } from "bun:test";
import MaterialArtifactsReporter, {
  recipeHttpStages,
} from "../../../packages/web/e2e/material-artifacts.reporter";

test("artifact reporter preserves the first failing substage without raw diagnostics", () => {
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    const reporter = new MaterialArtifactsReporter();
    const child = {
      category: "test.step",
      title: "recipe-http-403",
      error: new Error("untrusted-response-must-not-be-printed"),
    };
    reporter.onStepBegin(null, null, child);
    reporter.onStepEnd(null, null, child);
    reporter.onStepEnd(null, null, { ...child, title: "recipe-submit-response" });
    reporter.onStepEnd(null, null, { ...child, title: "recipe-import" });
    reporter.onTestEnd(null, { status: "failed" });
    reporter.onEnd({ status: "failed" });
    expect(output.mock.calls.map(([value]) => value)).toEqual([
      "artifact-web stage=recipe-http-403 code=failed\n",
      "artifact-web stage=recipe-submit-response code=failed\n",
      "artifact-web stage=recipe-import code=failed\n",
      "artifact-web stage=recipe-http-403 code=failed\n",
      "artifact-web stage=runner code=failed\n",
    ]);
  } finally {
    output.mockRestore();
  }
});

test("artifact reporter ignores unknown stages and uses only fixed HTTP stage names", () => {
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    const reporter = new MaterialArtifactsReporter();
    const unknown = { category: "test.step", title: "untrusted-title", error: "untrusted-error" };
    reporter.onStepBegin(null, null, unknown);
    reporter.onStepEnd(null, null, unknown);
    reporter.onError();
    expect(output.mock.calls.map(([value]) => value)).toEqual([
      "artifact-web stage=runner code=runner-error\n",
    ]);
    expect(recipeHttpStages.map(({ status }) => status)).toEqual([
      201, 400, 401, 403, 404, 413, 415, 422, 500, 502, 503,
    ]);
    for (const { status, stage } of recipeHttpStages) {
      expect(stage).toBe(`recipe-http-${status}`);
    }
  } finally {
    output.mockRestore();
  }
});

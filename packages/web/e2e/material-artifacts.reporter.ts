export const recipeHttpStages = [
  { status: 201, stage: "recipe-http-201" },
  { status: 400, stage: "recipe-http-400" },
  { status: 401, stage: "recipe-http-401" },
  { status: 403, stage: "recipe-http-403" },
  { status: 404, stage: "recipe-http-404" },
  { status: 413, stage: "recipe-http-413" },
  { status: 415, stage: "recipe-http-415" },
  { status: 422, stage: "recipe-http-422" },
  { status: 500, stage: "recipe-http-500" },
  { status: 502, stage: "recipe-http-502" },
  { status: 503, stage: "recipe-http-503" },
] as const;

export const artifactStages = [
  "inputs",
  "login",
  "empty-store",
  "recipe-import",
  "recipe-capture-install",
  "recipe-select-bundle",
  "recipe-namespace",
  "recipe-submit-response",
  ...recipeHttpStages.map(({ stage }) => stage),
  "recipe-http-other",
  "recipe-receipt-read",
  "recipe-response-schema",
  "recipe-readback",
  "recipe-receipt-match",
  "recipe-identity",
  "recipe-summary",
  "recipe-capture-cleanup",
  "missing-file",
  "extra-file",
  "material-import",
  "material-submit-response",
  "material-summary",
  "material-catalog-binding",
  "material-inspect",
  "readback",
  "cleanup",
  "binding-output",
] as const;

export type ArtifactStage = (typeof artifactStages)[number];

interface SafeStep {
  category: string;
  title: string;
  error?: unknown;
}

// Only runner-owned stage/status values reach stdout, including on fixture failures.
export default class MaterialArtifactsReporter {
  private stage: ArtifactStage | "runner" = "runner";
  private failedStage: ArtifactStage | undefined;

  printsToStdio(): boolean {
    return true;
  }

  onStepBegin(_test: unknown, _result: unknown, step: SafeStep): void {
    const stage = artifactStages.find((candidate) => candidate === step.title);
    if (step.category === "test.step" && stage) this.stage = stage;
  }

  onStepEnd(_test: unknown, _result: unknown, step: SafeStep): void {
    const stage = artifactStages.find((candidate) => candidate === step.title);
    if (step.category === "test.step" && stage) {
      if (step.error) this.failedStage ??= stage;
      this.emit(stage, step.error ? "failed" : "ok");
    }
  }

  onTestEnd(_test: unknown, result: { status: string }): void {
    this.emit(this.failedStage ?? this.stage, result.status === "passed" ? "passed" : "failed");
  }

  onError(): void {
    this.emit(this.stage, "runner-error");
  }

  onEnd(result: { status: string }): void {
    this.emit("runner", result.status === "passed" ? "passed" : "failed");
  }

  onStdOut(): void {
    // Never forward application, browser, or worker output.
  }

  onStdErr(): void {
    // Never forward raw errors, request diagnostics, or environment values.
  }

  private emit(
    stage: ArtifactStage | "runner",
    code: "ok" | "passed" | "failed" | "runner-error",
  ): void {
    process.stdout.write(`artifact-web stage=${stage} code=${code}\n`);
  }
}

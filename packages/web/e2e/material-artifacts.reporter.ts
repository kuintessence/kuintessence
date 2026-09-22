export const artifactStages = [
  "inputs",
  "login",
  "empty-store",
  "recipe-import",
  "missing-file",
  "extra-file",
  "material-import",
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

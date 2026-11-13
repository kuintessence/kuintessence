import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { type JobSubmission, usecase } from "@kuintessence/shared";
import type { PublicationInput } from "./output-publication";

export function preparePublicationInput(input: {
  jobId: string;
  ownerId: string;
  agentId: string;
  workingDir: string;
  workflowRunId?: string;
  spec: Pick<JobSubmission, "expectedOutputs" | "fileOutputDescriptors">;
  collected: Record<string, string>;
}): PublicationInput {
  const root = posix.resolve(input.workingDir);
  if (!posix.isAbsolute(input.workingDir) || root === "/")
    throw new Error("Invalid output working directory");
  const sourcePath = (path: string) => {
    const source = posix.resolve(root, path);
    if (!path || path.includes("\0") || !source.startsWith(`${root}/`))
      throw new Error("Output path escapes working directory");
    return source;
  };
  const files: PublicationInput["files"] = [];
  const outputs: PublicationInput["outputs"] = [];
  const descriptors = new Set<string>();
  const targets = new Set<string>();
  const declared = new Set(input.spec.fileOutputDescriptors ?? []);
  for (const out of input.spec.expectedOutputs) {
    if (!declared.has(out.descriptor)) continue;
    if (descriptors.has(out.descriptor)) throw new Error("Duplicate output descriptor");
    descriptors.add(out.descriptor);
    const declaration = sourcePath(out.path);
    const metadata = input.collected[usecase.batchOutputPathsDescriptor(out.descriptor)];
    let paths: string[];
    if (metadata !== undefined) {
      const parsed: unknown = JSON.parse(metadata);
      if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== "string"))
        throw new Error("Invalid output path metadata");
      paths = parsed;
    } else {
      if (
        out.isBatch ||
        out.pathsOnly ||
        out.descriptor === "stdout" ||
        !Object.hasOwn(input.collected, out.descriptor)
      )
        throw new Error("Workflow output lacks validated path metadata");
      // Legacy text outputs have no path receipt; retain only the exact declared in-root path.
      paths = [out.path];
    }
    if (!out.isBatch && (paths.length !== 1 || sourcePath(paths[0] ?? "") !== declaration))
      throw new Error("Output metadata does not match declaration");
    const pattern = out.isBatch ? new Bun.Glob(posix.relative(root, declaration)) : undefined;
    outputs.push({ descriptor: out.descriptor, path: out.path, isBatch: out.isBatch, paths });
    const safeDescriptor = out.descriptor.replace(/[^a-zA-Z0-9._-]/g, "_");
    const prefix = `workflow-runs/${input.workflowRunId ?? "sync"}/jobs/${input.jobId}/${safeDescriptor}`;
    for (const path of paths) {
      const source = sourcePath(path);
      if (pattern && !pattern.match(posix.relative(root, source)))
        throw new Error("Output path does not match declared glob");
      const name = posix.basename(path) || out.descriptor;
      const target = out.isBatch
        ? `${prefix}/${path.replace(/[^a-zA-Z0-9._-]/g, "_") || safeDescriptor}`
        : `${prefix}-${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      if (targets.has(target)) throw new Error("Conflicting output publication targets");
      targets.add(target);
      files.push({
        descriptor: out.descriptor,
        batch: out.isBatch,
        source,
        target,
        fileName: name,
        transferId: randomUUID(),
      });
    }
  }
  if ([...declared].some((descriptor) => !descriptors.has(descriptor)))
    throw new Error("Declared file output is missing");
  return {
    jobId: input.jobId,
    ownerId: input.ownerId,
    agentId: input.agentId,
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    outputs,
    files,
  };
}

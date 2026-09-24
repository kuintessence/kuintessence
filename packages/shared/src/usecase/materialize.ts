/**
 * Pure usecase-to-command materializer.
 *
 * Resolves a SoftwareUsecaseComputing node's bound slot values into an
 * executable task (facility + argv + env + input-staging). Pure and
 * deterministic: same input → same task, no IO — so it is trivially testable
 * and auditable.
 *
 * The material `valueFormat` is tokenized on
 * whitespace FIRST, then `{}` placeholders are substituted within each token,
 * so a value containing spaces stays a single argv token (no shell splitting,
 * no injection surface).
 */

import { posix as posixPath } from "node:path";
import type { LicensedMaterialRequest } from "../schemas/job";
import { StagePathSchema } from "../schemas/job";
import { type DataAssetRequirement, legacyLicensedMaterialsToDataRequirements } from "./package";

export type SoftwareSpec =
  | {
      kind: "Spack";
      name: string;
      version?: string;
      compiler?: string;
      moduleName?: string;
      variantRef?: string;
      argumentList: string[];
    }
  | { kind: "Singularity"; image: string; tag: string }
  | { kind: "Bare" };

export type MaterialRef =
  | { kind: "ArgRef"; descriptor: string; sort: number }
  | { kind: "EnvRef"; descriptor: string }
  | { kind: "FileInputRef"; descriptor: string }
  | { kind: "StdinRef"; descriptor: string };

export interface UsecaseInputSlot {
  kind: "Text" | "File";
  descriptor: string;
  refMaterials: MaterialRef[];
}

export interface ArgumentMaterial {
  descriptor: string;
  valueFormat: string;
}
export interface EnvironmentMaterial {
  descriptor: string;
  key: string;
  valueFormat: string;
}
export type FileKind = { kind: "Normal"; name: string } | { kind: "Batched"; pattern: string };

export interface FilesomeInputMaterial {
  descriptor: string;
  fileKind: FileKind;
}

export interface FilesomeOutputMaterial {
  descriptor: string;
  fileKind: FileKind;
}

export interface FileValue {
  fileMetadataId: string;
  fileMetadataName: string;
}
export type FileInputValue = FileValue | FileValue[];

export interface MaterializeInput {
  usecase: { commandFile: string; inputSlots: UsecaseInputSlot[] };
  software: SoftwareSpec;
  arguments: ArgumentMaterial[];
  environments: EnvironmentMaterial[];
  filesomeInputs: FilesomeInputMaterial[];
  filesomeOutputs?: FilesomeOutputMaterial[];
  dataRequirements?: DataAssetRequirement[];
  licensedMaterials?: LicensedMaterialRequest[];
  inputs: Record<string, string | FileInputValue>;
}

export interface MaterializedTask {
  facility: SoftwareSpec;
  argv: string[];
  envVars: Record<string, string>;
  inputStaging: { fileMetadataId: string; stagePath: string }[];
  expectedOutputs: { descriptor: string; path: string; isBatch: boolean }[];
  dataRequirements?: DataAssetRequirement[];
  stdinText?: string;
  licensedMaterials?: LicensedMaterialRequest[];
}

function renderTokens(format: string, value: string | undefined): string[] {
  const tokens = format.split(/\s+/).filter((t) => t.length > 0);
  if (value === undefined) {
    return tokens;
  }
  return tokens.map((tok) => tok.replaceAll("{}", () => value));
}

function asText(value: string | FileInputValue | undefined, descriptor: string): string {
  if (typeof value !== "string") {
    throw new Error(`materialize: input "${descriptor}" expected a text value`);
  }
  return value;
}

function asFile(value: string | FileInputValue | undefined, descriptor: string): FileValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`materialize: input "${descriptor}" expected a file value`);
  }
  return value;
}

function asFiles(value: string | FileInputValue | undefined, descriptor: string): FileValue[] {
  if (!Array.isArray(value) || value.some((item) => item === null || typeof item !== "object")) {
    throw new Error(`materialize: input "${descriptor}" expected batched file values`);
  }
  return value;
}

export function materialize(input: MaterializeInput): MaterializedTask {
  const positioned: { sort: number; tokens: string[] }[] = [];
  const envVars: Record<string, string> = {};
  const inputStaging: { fileMetadataId: string; stagePath: string }[] = [];
  let stdinText: string | undefined;

  for (const slot of input.usecase.inputSlots) {
    for (const ref of slot.refMaterials) {
      if (ref.kind === "ArgRef") {
        const material = input.arguments.find((a) => a.descriptor === ref.descriptor);
        if (!material) {
          throw new Error(`materialize: no Argument material "${ref.descriptor}"`);
        }
        positioned.push({
          sort: ref.sort,
          tokens: renderTokens(
            material.valueFormat,
            asText(input.inputs[slot.descriptor], slot.descriptor),
          ),
        });
      } else if (ref.kind === "EnvRef") {
        const material = input.environments.find((e) => e.descriptor === ref.descriptor);
        if (!material) {
          throw new Error(`materialize: no Environment material "${ref.descriptor}"`);
        }
        envVars[material.key] = renderTokens(
          material.valueFormat,
          asText(input.inputs[slot.descriptor], slot.descriptor),
        ).join(" ");
      } else if (ref.kind === "FileInputRef") {
        const material = input.filesomeInputs.find((f) => f.descriptor === ref.descriptor);
        if (!material) {
          throw new Error(`materialize: no FilesomeInput material "${ref.descriptor}"`);
        }
        if (material.fileKind.kind === "Normal") {
          const file = asFile(input.inputs[slot.descriptor], slot.descriptor);
          inputStaging.push({
            fileMetadataId: file.fileMetadataId,
            stagePath: assertSafeStagePath(material.fileKind.name, ref.descriptor),
          });
        } else {
          const files = asFiles(input.inputs[slot.descriptor], slot.descriptor);
          for (const [index, file] of files.entries()) {
            inputStaging.push({
              fileMetadataId: file.fileMetadataId,
              stagePath: assertSafeStagePath(
                batchStagePath(material.fileKind.pattern, file, index),
                ref.descriptor,
              ),
            });
          }
        }
      } else {
        if (stdinText !== undefined) {
          throw new Error("materialize: multiple StdinRef materials are not supported");
        }
        stdinText = asText(input.inputs[slot.descriptor], slot.descriptor);
      }
    }
  }

  positioned.sort((a, b) => a.sort - b.sort);
  const argv = [input.usecase.commandFile, ...positioned.flatMap((p) => p.tokens)];

  const expectedOutputs = (input.filesomeOutputs ?? []).map((fo) => {
    const path = fo.fileKind.kind === "Normal" ? fo.fileKind.name : fo.fileKind.pattern;
    // Symmetric with input stagePath: outputs are read back relative to the run
    // dir, so a `..` would read outside it. Glob chars (`*`,`?`) stay allowed.
    const safe = StagePathSchema.safeParse(path);
    if (!safe.success) {
      throw new Error(
        `materialize: unsafe output path "${path}" for "${fo.descriptor}": ${
          safe.error.issues[0]?.message ?? "invalid"
        }`,
      );
    }
    return { descriptor: fo.descriptor, path, isBatch: fo.fileKind.kind === "Batched" };
  });

  return {
    facility: input.software,
    argv,
    envVars,
    inputStaging,
    expectedOutputs,
    dataRequirements: [
      ...(input.dataRequirements ?? []),
      ...legacyLicensedMaterialsToDataRequirements(input.licensedMaterials ?? []),
    ],
    licensedMaterials: input.licensedMaterials ?? [],
    ...(stdinText !== undefined ? { stdinText } : {}),
  };
}

function batchStagePath(pattern: string, file: FileValue, index: number): string {
  const rawName = posixPath.basename(file.fileMetadataName) || `item-${index}`;
  const safeName = rawName.replace(/[^\w.-]/g, "_");
  if (pattern.includes("*")) {
    const dir = posixPath.dirname(pattern);
    return dir === "." ? safeName : posixPath.join(dir, safeName);
  }
  const base = pattern.endsWith("/") ? pattern : `${pattern}/`;
  return `${base}${safeName}`;
}

function assertSafeStagePath(path: string, descriptor: string): string {
  const safe = StagePathSchema.safeParse(path);
  if (!safe.success) {
    throw new Error(
      `materialize: unsafe stagePath "${path}" for "${descriptor}": ${
        safe.error.issues[0]?.message ?? "invalid"
      }`,
    );
  }
  return path;
}

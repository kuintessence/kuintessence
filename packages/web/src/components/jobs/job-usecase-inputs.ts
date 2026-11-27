import type { JobDataInputs, JobUsecaseInputs } from "@kuintessence/shared/browser";
import type { TypedUsecaseInput, UsecasePackage } from "../../lib/software-client";

export type UsecaseInputs = JobUsecaseInputs;

export function softwareSummary(pkg: UsecasePackage): string {
  const software = pkg.spec.software;
  if (software.kind === "Spack") {
    return [
      `${software.name}${software.version ? `@${software.version}` : ""}`,
      ...software.argumentList,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (software.kind === "Singularity") return `${software.image}:${software.tag}`;
  return "Bare";
}

export function isBatchFileSlot(pkg: UsecasePackage, descriptor: string): boolean {
  const slot = pkg.spec.usecase.inputSlots.find((item) => item.descriptor === descriptor);
  const fileRef = slot?.refMaterials.find((ref) => ref.kind === "FileInputRef");
  if (!fileRef || fileRef.kind !== "FileInputRef")
    return (
      pkg.spec.inputs?.some(
        (input) => input.descriptor === descriptor && input.type === "FileBatch",
      ) ?? false
    );
  const material = pkg.spec.filesomeInputs.find((item) => item.descriptor === fileRef.descriptor);
  return material?.fileKind.kind === "Batched";
}

export function isStdinTextSlot(pkg: UsecasePackage, descriptor: string): boolean {
  const slot = pkg.spec.usecase.inputSlots.find((item) => item.descriptor === descriptor);
  return slot?.refMaterials.some((ref) => ref.kind === "StdinRef") ?? false;
}

function isInternalScriptSlot(slot: UsecasePackage["spec"]["usecase"]["inputSlots"][number]) {
  const normalized = slot.descriptor.trim().toLowerCase();
  return (
    slot.kind === "Text" &&
    ["script", "shell", "shell_script", "command", "cmd"].includes(normalized) &&
    slot.refMaterials.some((ref) => ref.kind === "ArgRef" || ref.kind === "StdinRef")
  );
}

export function visibleInputSlots(pkg: UsecasePackage) {
  const slots = pkg.spec.usecase.inputSlots.filter((slot) => !isInternalScriptSlot(slot));
  return [
    ...slots,
    ...(pkg.spec.inputs ?? [])
      .filter(
        (input) =>
          input.type !== "Dataset" &&
          !pkg.spec.usecase.inputSlots.some((slot) => slot.descriptor === input.descriptor),
      )
      .map((input) => ({
        descriptor: input.descriptor,
        kind:
          input.type === "File" || input.type === "FileBatch"
            ? ("File" as const)
            : ("Text" as const),
        refMaterials: [],
      })),
  ];
}

export function isDomainUsecase(pkg: UsecasePackage): boolean {
  return !pkg.spec.usecase.inputSlots.some(isInternalScriptSlot);
}

export function usecaseFieldId(descriptor: string): string {
  return `submit-usecase-input-${descriptor.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function datasetInputs(pkg: UsecasePackage | null) {
  if (pkg?.spec.softwareRef === undefined) return [];
  return pkg.spec.inputs.filter((input) => input.type === "Dataset");
}

export function usecaseInputCount(pkg: UsecasePackage): number {
  return visibleInputSlots(pkg).length + datasetInputs(pkg).length;
}

export function hasUnboundInputs(pkg: UsecasePackage): boolean {
  return visibleInputSlots(pkg).some((slot) => slot.refMaterials.length === 0);
}

export function validTextInput(value: string, contract?: TypedUsecaseInput): boolean {
  if (!value.trim()) return contract?.required === false;
  if (!contract) return true;
  if (contract.type === "Boolean" && !["true", "false"].includes(value)) return false;
  if (contract.enum && !contract.enum.includes(value)) return false;
  if (contract.pattern) {
    try {
      if (!new RegExp(contract.pattern).test(value)) return false;
    } catch {
      return false;
    }
  }
  if (contract.type === "Integer" || contract.type === "Number") {
    const number = Number(value);
    if (!Number.isFinite(number) || (contract.type === "Integer" && !Number.isInteger(number)))
      return false;
    if (contract.minimum !== undefined && number < contract.minimum) return false;
    if (contract.maximum !== undefined && number > contract.maximum) return false;
  }
  return true;
}

export function usecaseReady(
  pkg: UsecasePackage | null,
  inputs: UsecaseInputs,
  dataInputs: JobDataInputs,
  dataInputValidity: Record<string, boolean>,
): boolean {
  if (!pkg || hasUnboundInputs(pkg)) return false;
  const materialInputsReady = visibleInputSlots(pkg).every((slot) => {
    const value = inputs[slot.descriptor];
    const contract = pkg.spec.inputs?.find((input) => input.descriptor === slot.descriptor);
    if (slot.kind === "Text") {
      return validTextInput(typeof value === "string" ? value : "", contract);
    }
    if (isBatchFileSlot(pkg, slot.descriptor)) {
      return Array.isArray(value) && value.length > 0;
    }
    return value !== null && typeof value === "object" && !Array.isArray(value);
  });
  return (
    materialInputsReady &&
    datasetInputs(pkg).every((input) => {
      const selected = dataInputs[input.descriptor] !== undefined;
      if (!selected) return !input.required;
      return dataInputValidity[input.descriptor] === true;
    })
  );
}

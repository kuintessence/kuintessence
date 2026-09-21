import type {
  SpackMaterialRetirementEvidence,
  SpackMaterialRolloutEvidence,
} from "./schema-spack-materials";

interface Mutation {
  operatorId: string;
  expectedRevision: number;
}
interface PausedMutation extends Mutation {
  epoch: string;
}
export type SpackMaterialRolloutCommand =
  | { action: "inspect" }
  | ({ action: "pause" } & Mutation)
  | ({ action: "reconcile"; bindings: unknown[] } & PausedMutation)
  | ({
      action: "retire";
      bindings: unknown[];
      inventoryDigest: string;
      reason: string;
      evidence: SpackMaterialRetirementEvidence;
    } & PausedMutation)
  | ({
      action: "activate";
      inventoryDigest: string;
      evidence: SpackMaterialRolloutEvidence;
    } & PausedMutation);

export function parseSpackMaterialEpoch(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  ) {
    throw new Error("Invalid rollout identity");
  }
  return value.toLowerCase();
}

export function parseSpackMaterialRolloutCommand(input: unknown): SpackMaterialRolloutCommand {
  const value = object(input);
  if (value.action === "inspect") {
    exactKeys(value, ["action"]);
    return { action: "inspect" };
  }
  const base = {
    operatorId: parseSpackMaterialEpoch(value.operatorId),
    expectedRevision: value.expectedRevision,
  };
  if (
    typeof base.expectedRevision !== "number" ||
    !Number.isSafeInteger(base.expectedRevision) ||
    base.expectedRevision < 0 ||
    base.expectedRevision > 2_147_483_646
  ) {
    throw new Error("Invalid rollout revision");
  }
  const mutation = { ...base, expectedRevision: base.expectedRevision };
  if (value.action === "pause") {
    exactKeys(value, ["action", "operatorId", "expectedRevision"]);
    return { action: "pause", ...mutation };
  }
  const epoch = parseSpackMaterialEpoch(value.epoch);
  if (value.action === "reconcile") {
    exactKeys(value, ["action", "operatorId", "expectedRevision", "epoch", "bindings"]);
    if (!Array.isArray(value.bindings) || value.bindings.length > 64) {
      throw new Error("Invalid rollout inventory");
    }
    return { action: "reconcile", ...mutation, epoch, bindings: [...value.bindings] };
  }
  if (value.action === "activate" || value.action === "retire") {
    exactKeys(value, [
      "action",
      "operatorId",
      "expectedRevision",
      "epoch",
      "inventoryDigest",
      "evidence",
      ...(value.action === "retire" ? ["bindings", "reason"] : []),
    ]);
    if (
      typeof value.inventoryDigest !== "string" ||
      value.inventoryDigest.length !== 71 ||
      !/^sha256:[a-f0-9]{64}$/.test(value.inventoryDigest)
    ) {
      throw new Error("Invalid rollout inventory digest");
    }
    const evidence = object(value.evidence);
    const evidenceKeys = [
      "legacyProcessesStoppedAndDrained",
      "legacyAccessRevoked",
      "legacyInventoryComplete",
      ...(value.action === "retire" ? ["bindingConfigurationsRemoved"] : []),
    ];
    exactKeys(evidence, evidenceKeys);
    if (evidenceKeys.some((key) => evidence[key] !== true)) {
      throw new Error("Missing rollout evidence");
    }
    const confirmed = {
      ...mutation,
      epoch,
      inventoryDigest: value.inventoryDigest,
      evidence: {
        legacyProcessesStoppedAndDrained: true as const,
        legacyAccessRevoked: true as const,
        legacyInventoryComplete: true as const,
      },
    };
    if (value.action === "retire") {
      if (
        !Array.isArray(value.bindings) ||
        value.bindings.length === 0 ||
        value.bindings.length > 64 ||
        typeof value.reason !== "string" ||
        value.reason.length === 0 ||
        value.reason.length > 1000 ||
        value.reason.trim() !== value.reason ||
        [...value.reason].some((character) => character.charCodeAt(0) < 32 || character === "\x7f")
      ) {
        throw new Error("Invalid retirement request");
      }
      return {
        action: "retire",
        ...confirmed,
        bindings: [...value.bindings],
        reason: value.reason,
        evidence: { ...confirmed.evidence, bindingConfigurationsRemoved: true },
      };
    }
    return { action: "activate", ...confirmed };
  }
  throw new Error("Invalid rollout action");
}

function object(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("Invalid rollout object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new Error("Invalid rollout fields");
  }
}

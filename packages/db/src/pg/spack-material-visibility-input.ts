export type SpackMaterialVisibilityPolicy =
  | { mode: "inherit" }
  | { mode: "allowlist"; userIds: string[]; orgIds: string[] };

export interface SpackMaterialVisibilityChange {
  policy: SpackMaterialVisibilityPolicy;
  expectedRevision: number;
  reason: string;
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new Error("Invalid visibility object");
  }
  return value as Record<string, unknown>;
}

function identifiers(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    Array.from(value).some(
      (id) => typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Invalid visibility identities");
  }
  return [...value].sort();
}

export function parseSpackMaterialVisibilityPolicy(input: unknown): SpackMaterialVisibilityPolicy {
  if (input && typeof input === "object" && "mode" in input && input.mode === "inherit") {
    object(input, ["mode"]);
    return { mode: "inherit" };
  }
  const value = object(input, ["mode", "userIds", "orgIds"]);
  if (value.mode !== "allowlist") throw new Error("Invalid visibility mode");
  return {
    mode: "allowlist",
    userIds: identifiers(value.userIds),
    orgIds: identifiers(value.orgIds),
  };
}

export function parseSpackMaterialVisibilityChange(input: unknown): SpackMaterialVisibilityChange {
  const value = object(input, ["policy", "expectedRevision", "reason"]);
  if (
    typeof value.expectedRevision !== "number" ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    value.expectedRevision > 2_147_483_646 ||
    typeof value.reason !== "string" ||
    value.reason.length === 0 ||
    value.reason.length > 1000 ||
    value.reason.trim() !== value.reason ||
    [...value.reason].some((character) => character.charCodeAt(0) < 32 || character === "\x7f")
  ) {
    throw new Error("Invalid visibility change");
  }
  return {
    policy: parseSpackMaterialVisibilityPolicy(value.policy),
    expectedRevision: value.expectedRevision,
    reason: value.reason,
  };
}

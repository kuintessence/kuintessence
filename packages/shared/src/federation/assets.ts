import { z } from "zod";
import { FederationAssetRefSchema, FederationDigestSchema } from "./references";

const Descriptor = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/);
const RelativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected relative path without traversal",
  );

export const FederationInputManifestSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("inputs"),
    parameters: z.record(Descriptor, z.json()),
    datasets: z
      .array(
        z.strictObject({
          descriptor: Descriptor,
          asset: FederationAssetRefSchema.refine((ref) => ref.kind === "dataset"),
          selectedEntries: z.array(RelativePath).max(10000),
          targetPath: RelativePath.optional(),
        }),
      )
      .max(100),
    // Source revision IDs used in the workflow DSL are resolved only through these explicit bindings.
    bindings: z
      .array(z.strictObject({ sourceRevisionId: z.uuid(), asset: FederationAssetRefSchema }))
      .max(1000),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.datasets.map((v) => v.descriptor)).size !== value.datasets.length)
      ctx.addIssue({ code: "custom", message: "Dataset descriptors must be unique" });
    if (new Set(value.bindings.map((v) => v.sourceRevisionId)).size !== value.bindings.length)
      ctx.addIssue({ code: "custom", message: "Source revision bindings must be unique" });
  });
export type FederationInputManifest = z.infer<typeof FederationInputManifestSchema>;

export const FederationEnvironmentLockSchema = z.strictObject({
  protocolVersion: z.literal(1),
  kind: z.literal("environment-lock"),
  target: z.strictObject({
    platform: z.string().min(1).max(128),
    architecture: z.string().min(1).max(128),
  }),
  nativeLockDigest: FederationDigestSchema,
  software: z
    .array(
      z.strictObject({
        asset: FederationAssetRefSchema.refine((ref) => ref.kind === "software"),
        concreteSpec: z.string().min(1).max(4096),
        dagHash: z.string().regex(/^[a-z0-9]{7,64}$/),
      }),
    )
    .max(1000),
  sandboxRuntime: z
    .strictObject({ kind: z.enum(["OCI", "SIF"]), digest: FederationDigestSchema })
    .optional(),
});
export type FederationEnvironmentLock = z.infer<typeof FederationEnvironmentLockSchema>;

/** Content addressing for portable material only; the JWS wire format remains byte-preserving. */
export function federationCanonicalJson(value: unknown): string {
  function encode(input: unknown, depth: number): string {
    if (depth > 32) throw new Error("Federation material nesting exceeds 32 levels");
    if (input === null || typeof input === "boolean" || typeof input === "string")
      return JSON.stringify(input);
    if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input);
    if (Array.isArray(input)) {
      for (let i = 0; i < input.length; i++)
        if (!(i in input)) throw new Error("Sparse arrays are not JSON");
      return `[${input.map((item) => encode(item, depth + 1)).join(",")}]`;
    }
    if (
      typeof input === "object" &&
      input !== null &&
      [Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      return `{${Object.keys(input)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${encode((input as Record<string, unknown>)[key], depth + 1)}`,
        )
        .join(",")}}`;
    throw new Error("Federation material must be finite JSON");
  }
  const encoded = encode(value, 0);
  if (new TextEncoder().encode(encoded).length > 1048576)
    throw new Error("Federation material exceeds one MiB");
  return encoded;
}

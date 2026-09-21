import { z } from "zod";
import {
  SpackMaterialBindingSchema,
  SpackMaterialBlobSchema,
  SpackMaterialDigestSchema,
  SpackMaterialPublishSchema,
} from "./spack-materials";
import { RecipeRepositoryNameSchema, RecipeRepositorySchema } from "./spack-repositories";

export const SPACK_UPSTREAM_IMPORT_MAX_BYTES = 2 * 1024 ** 2;
export const SPACK_UPSTREAM_RECIPE_MAX_BYTES = 128 * 1024 ** 2;
export const SPACK_UPSTREAM_IMPORT_MAX_FILES = 256;

export const SpackUpstreamUrlSchema = z
  .string()
  .max(4096)
  .refine((value) => {
    if (
      !/^https:\/\//i.test(value) ||
      /[\s\\?#]/.test(value) ||
      Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ) {
      return false;
    }
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname.length > 0 &&
        !url.hostname.includes(":") &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !value
          .slice(value.indexOf("//") + 2)
          .split("/")[0]
          ?.includes("@")
      );
    } catch {
      return false;
    }
  }, "Use an HTTPS/443 domain or IPv4 URL without credentials, query parameters, or fragments");

export const SpackUpstreamImportSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("recipe"),
      repository: RecipeRepositoryNameSchema,
      url: SpackUpstreamUrlSchema,
      digest: SpackMaterialDigestSchema,
      size: z.number().int().positive().max(SPACK_UPSTREAM_RECIPE_MAX_BYTES),
    }),
    z.strictObject({
      kind: z.literal("material"),
      files: z
        .array(z.strictObject({ url: SpackUpstreamUrlSchema, blob: SpackMaterialBlobSchema }))
        .min(1)
        .max(SPACK_UPSTREAM_IMPORT_MAX_FILES),
      release: SpackMaterialPublishSchema,
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.kind !== "material") return;
    const files = new Map<string, number>();
    const urls = new Set<string>();
    let bytes = 0;
    for (const file of value.files) {
      // safeParse can collect URL refinement failures before visiting this refinement.
      const parsedUrl = SpackUpstreamUrlSchema.safeParse(file.url);
      const url = parsedUrl.success ? new URL(parsedUrl.data).href : file.url;
      if (files.has(file.blob.digest) || urls.has(url)) {
        ctx.addIssue({ code: "custom", message: "Duplicate upstream import file" });
      }
      files.set(file.blob.digest, file.blob.size);
      urls.add(url);
      bytes += file.blob.size;
    }
    if (bytes > 512 * 1024 ** 3) {
      ctx.addIssue({ code: "custom", message: "Upstream import exceeds 512 GiB" });
    }
    const referenced = new Set<string>();
    for (const blob of [value.release.lockfile, ...value.release.sources.map((s) => s.blob)]) {
      if (files.get(blob.digest) !== blob.size) {
        ctx.addIssue({ code: "custom", message: "Missing or inconsistent upstream file binding" });
      }
      referenced.add(blob.digest);
    }
    if ([...files.keys()].some((digest) => !referenced.has(digest))) {
      ctx.addIssue({ code: "custom", message: "Unreferenced upstream import file" });
    }
  });
export type SpackUpstreamImport = z.infer<typeof SpackUpstreamImportSchema>;

export const SpackUpstreamImportResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("recipe"), repository: RecipeRepositorySchema }),
  z.strictObject({ kind: z.literal("material"), binding: SpackMaterialBindingSchema }),
]);
export type SpackUpstreamImportResult = z.infer<typeof SpackUpstreamImportResultSchema>;

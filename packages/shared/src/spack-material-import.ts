import { z } from "zod";
import {
  SpackMaterialBlobSchema,
  SpackMaterialPathSchema,
  SpackMaterialPublishSchema,
} from "./spack-materials";

export const SPACK_MATERIAL_IMPORT_MAX_BYTES = 2 * 1024 ** 2;

export const SpackMaterialImportSchema = z
  .strictObject({
    version: z.literal(1),
    files: z
      .array(
        z.strictObject({
          path: SpackMaterialPathSchema,
          blob: SpackMaterialBlobSchema,
        }),
      )
      .min(1)
      .max(20_000),
    releases: z.array(SpackMaterialPublishSchema).min(1).max(200),
  })
  .superRefine((value, ctx) => {
    const files = new Map<string, number>();
    const paths = new Set<string>();
    let bytes = 0;
    for (const file of value.files) {
      if (files.has(file.blob.digest) || paths.has(file.path)) {
        ctx.addIssue({ code: "custom", message: "Duplicate material import file" });
      }
      files.set(file.blob.digest, file.blob.size);
      paths.add(file.path);
      bytes += file.blob.size;
    }
    if (bytes > 512 * 1024 ** 3) {
      ctx.addIssue({ code: "custom", message: "Material import exceeds 512 GiB" });
    }
    for (const path of paths) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        if (paths.has(parts.slice(0, i).join("/"))) {
          ctx.addIssue({ code: "custom", message: "Material import paths overlap" });
        }
      }
    }
    const referenced = new Set<string>();
    const releases = new Set<string>();
    for (const release of value.releases) {
      const identity = JSON.stringify([
        release.repository,
        release.spec,
        release.target,
        release.spackVersion,
      ]);
      if (releases.has(identity)) {
        ctx.addIssue({ code: "custom", message: "Duplicate material import release" });
      }
      releases.add(identity);
      for (const blob of [release.lockfile, ...release.sources.map((source) => source.blob)]) {
        if (files.get(blob.digest) !== blob.size) {
          ctx.addIssue({
            code: "custom",
            message: "Material import file binding is missing or inconsistent",
          });
        }
        referenced.add(blob.digest);
      }
    }
    if ([...files.keys()].some((digest) => !referenced.has(digest))) {
      ctx.addIssue({ code: "custom", message: "Unreferenced material import file" });
    }
  });

export type SpackMaterialImport = z.infer<typeof SpackMaterialImportSchema>;

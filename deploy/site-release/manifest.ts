import { siteReleaseSchema } from "../../packages/server/src/routes/site-releases";

/** The bootstrap downloader reserves each artifact's .part sibling while resuming. */
export const siteReleaseManifestSchema = siteReleaseSchema.superRefine((manifest, ctx) => {
  const names = new Set(manifest.files.map((file) => file.name));
  if (manifest.files.some((file) => names.has(`${file.name}.part`)))
    ctx.addIssue({
      code: "custom",
      message: "Artifact name conflicts with a downloader .part path",
    });
});

/** Unrecognised/new channels are formal by default; review exceptions are explicit. */
export const isFormalReleaseChannel = (channel: string) =>
  !/^(?:review|dev|test|preview)(?:-|$)/.test(channel);

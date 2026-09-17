export interface StagingItem {
  fileMetadataId: string;
  stagePath: string;
  sourceUrl?: string;
}

/**
 * Fill in a presigned MinIO GET URL for each input-staging item just before
 * dispatch, so the agent can fetch the file without a Server credential.
 * `presign` resolves a file metadata id to a short-lived URL; injected so this
 * is testable without MinIO.
 */
export async function attachStagingUrls(
  items: StagingItem[],
  presign: (fileMetadataId: string) => Promise<string>,
): Promise<StagingItem[]> {
  return Promise.all(
    items.map(async (it) => ({ ...it, sourceUrl: await presign(it.fileMetadataId) })),
  );
}

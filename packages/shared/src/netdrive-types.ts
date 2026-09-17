import { z } from "zod";

/**
 * NetDrive shared schemas (PRD F18).
 *
 * The NetDrive foundation stores file metadata in PG and blob bytes in
 * MinIO/S3. The Server never proxies bytes; clients (browser, Agent staging,
 * CLI) PUT/GET directly against the object store via short-lived
 * presigned URLs. The Server mints those URLs and acts as the metadata
 * authority.
 */

// POSIX-safe path: forward slashes only, no `..`, no leading slash. Same
// shape as the existing files-mock POSIX_KEY but with explicit `..` ban
// to keep object-store keys flat and traversal-safe.
const NETDRIVE_PATH = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9._/-]+$/, "Must be a POSIX-safe path")
  .refine((s) => !s.startsWith("/"), "Must not start with /")
  .refine((s) => !s.endsWith("/"), "Must not end with / (folder marker is not a file)")
  .refine(
    (s) => !s.split("/").some((seg) => seg === "" || seg === ".." || seg === "."),
    "Must not contain empty, . or .. segments",
  );

const SHA256_HEX = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/i, "Must be 64-char lowercase hex");

/**
 * Body for `POST /api/netdrive/upload-url`.
 *
 * The client submits intended file metadata BEFORE uploading; the Server
 * mints a presigned PUT URL and returns a `commitToken` (HMAC-style)
 * the client must echo back on `POST /api/netdrive/files` so the
 * commit cannot be forged for a different path/size.
 */
export const NetDriveUploadUrlRequestSchema = z.object({
  path: NETDRIVE_PATH,
  size: z.number().int().nonnegative(),
  /** Defaults to `application/octet-stream` when omitted. */
  contentType: z.string().min(1).max(255).optional(),
  /** Optional pre-known SHA-256 to bind to the commit token. */
  sha256: SHA256_HEX.optional(),
});

export const NetDriveUploadUrlResponseSchema = z.object({
  uploadUrl: z.string().url(),
  /** Object-store key the client uploaded to; echoed back on commit. */
  storageKey: z.string().min(1),
  /** Opaque token the Server issues; required on commit. */
  commitToken: z.string().min(1),
  /** Expiry of the upload URL (ISO 8601 UTC). */
  expiresAt: z.string(),
});

export const NetDriveCommitRequestSchema = z.object({
  path: NETDRIVE_PATH,
  size: z.number().int().nonnegative(),
  /** Defaults to `application/octet-stream` when omitted. */
  contentType: z.string().min(1).max(255).optional(),
  sha256: SHA256_HEX,
  storageKey: z.string().min(1),
  commitToken: z.string().min(1),
  /** Optional ETag the object store echoed back to the client on PUT. */
  etag: z.string().optional(),
});

export const NetDriveFileSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  contentType: z.string(),
  etag: z.string().nullable(),
  storageKey: z.string(),
  mtime: z.string(),
  createdAt: z.string(),
});

export const NetDriveListItemSchema = NetDriveFileSchema.extend({
  canUse: z.boolean(),
  canDelete: z.boolean(),
});

export const NetDriveListQuerySchema = z.object({
  prefix: z.string().max(2048).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export const NetDriveListResponseSchema = z.object({
  files: z.array(NetDriveListItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const NetDriveDownloadUrlResponseSchema = z.object({
  downloadUrl: z.string().url(),
  expiresAt: z.string(),
});

const NETDRIVE_PART_NUMBER = z.number().int().positive().max(10000);

const NetDriveUploadPartRefSchema = z.object({
  partNumber: NETDRIVE_PART_NUMBER,
  etag: z.string().min(1),
});

/** Body for `POST /api/netdrive/uploads/multipart`. */
export const NetDriveMultipartInitRequestSchema = z.object({
  path: NETDRIVE_PATH,
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1).max(255).optional(),
});

export const NetDriveMultipartInitResponseSchema = z.object({
  storageKey: z.string().min(1),
  uploadId: z.string().min(1),
  commitToken: z.string().min(1),
  /** Part size (bytes) the client must use for every part except the last. */
  partSize: z.number().int().positive(),
  expiresAt: z.string(),
});

/** Body for `POST /api/netdrive/uploads/multipart/part-urls`. */
export const NetDrivePartUrlsRequestSchema = z.object({
  storageKey: z.string().min(1),
  uploadId: z.string().min(1),
  commitToken: z.string().min(1),
  partNumbers: z.array(NETDRIVE_PART_NUMBER).min(1).max(1000),
});

export const NetDrivePartUrlsResponseSchema = z.object({
  urls: z.array(z.object({ partNumber: NETDRIVE_PART_NUMBER, url: z.string().url() })),
});

/** Body for `POST /api/netdrive/uploads/multipart/list-parts`. */
export const NetDriveListPartsRequestSchema = z.object({
  storageKey: z.string().min(1),
  uploadId: z.string().min(1),
  commitToken: z.string().min(1),
});

export const NetDriveListPartsResponseSchema = z.object({
  parts: z.array(NetDriveUploadPartRefSchema),
});

/** Body for `POST /api/netdrive/uploads/multipart/complete`. */
export const NetDriveMultipartCompleteRequestSchema = z.object({
  path: NETDRIVE_PATH,
  size: z.number().int().nonnegative(),
  sha256: SHA256_HEX,
  contentType: z.string().min(1).max(255).optional(),
  storageKey: z.string().min(1),
  uploadId: z.string().min(1),
  commitToken: z.string().min(1),
  parts: z.array(NetDriveUploadPartRefSchema).min(1),
});

/** Body for `DELETE /api/netdrive/uploads/multipart`. */
export const NetDriveMultipartAbortRequestSchema = z.object({
  storageKey: z.string().min(1),
  uploadId: z.string().min(1),
  commitToken: z.string().min(1),
});

export type NetDriveUploadUrlRequest = z.infer<typeof NetDriveUploadUrlRequestSchema>;
export type NetDriveUploadUrlResponse = z.infer<typeof NetDriveUploadUrlResponseSchema>;
export type NetDriveCommitRequest = z.infer<typeof NetDriveCommitRequestSchema>;
export type NetDriveFile = z.infer<typeof NetDriveFileSchema>;
export type NetDriveListItem = z.infer<typeof NetDriveListItemSchema>;
export type NetDriveListQuery = z.infer<typeof NetDriveListQuerySchema>;
export type NetDriveListResponse = z.infer<typeof NetDriveListResponseSchema>;
export type NetDriveDownloadUrlResponse = z.infer<typeof NetDriveDownloadUrlResponseSchema>;
export type NetDriveUploadPartRef = z.infer<typeof NetDriveUploadPartRefSchema>;
export type NetDriveMultipartInitRequest = z.infer<typeof NetDriveMultipartInitRequestSchema>;
export type NetDriveMultipartInitResponse = z.infer<typeof NetDriveMultipartInitResponseSchema>;
export type NetDrivePartUrlsRequest = z.infer<typeof NetDrivePartUrlsRequestSchema>;
export type NetDrivePartUrlsResponse = z.infer<typeof NetDrivePartUrlsResponseSchema>;
export type NetDriveListPartsRequest = z.infer<typeof NetDriveListPartsRequestSchema>;
export type NetDriveListPartsResponse = z.infer<typeof NetDriveListPartsResponseSchema>;
export type NetDriveMultipartCompleteRequest = z.infer<
  typeof NetDriveMultipartCompleteRequestSchema
>;
export type NetDriveMultipartAbortRequest = z.infer<typeof NetDriveMultipartAbortRequestSchema>;

/**
 * Agent NetDrive staging helpers.
 *
 * Stage-in: pull a registered NetDrive file id from the Server and drop the
 * blob bytes into a job's local working directory before the scheduler
 * launches the job script.
 *
 * Stage-out: register a local job-output file with the Server and upload it
 * via the presigned PUT URL the Server mints in response.
 *
 * The Agent talks to the Server over plain HTTP using a bearer token (same
 * one issued during enrollment / via the Server auth flow). MinIO is
 * accessed directly via the presigned URLs the Server mints — the Agent
 * never sees MinIO credentials.
 */

export type { HttpClient, HttpResponse } from "./http-client";
export {
  type MultipartFromFileOptions,
  type MultipartFromFileResult,
  multipartUploadFromFile,
} from "./multipart-upload-from-file";
export { type StageInOptions, type StageInResult, stageIn } from "./stage-in";
export { type StageOutOptions, type StageOutResult, stageOut } from "./stage-out";

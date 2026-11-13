import { FederationError } from "@kuintessence/shared/federation";
import type { MinioBackend } from "../storage/minio-client";

/** S3 credentials, not just the envelope, must expire within the agreed release window. */
export function signedDownloadExpiry(url: string, now: number, deadline: number) {
  const params = new URL(url).searchParams;
  const date = params.get("X-Amz-Date"),
    lifetime = params.get("X-Amz-Expires");
  const parts = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date ?? "");
  if (
    !parts ||
    !lifetime ||
    !/^\d+$/.test(lifetime) ||
    Number(lifetime) < 1 ||
    Number(lifetime) > 30 ||
    params.getAll("X-Amz-Date").length !== 1 ||
    params.getAll("X-Amz-Expires").length !== 1
  )
    throw new FederationError("POLICY_DENIED");
  const issued = Date.parse(
    `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}Z`,
  );
  const expiry = issued + Number(lifetime) * 1000;
  if (!Number.isFinite(expiry) || expiry <= now || expiry > deadline || issued > now)
    throw new FederationError("AUTHORIZATION_EXPIRED");
  return new Date(expiry).toISOString();
}

export interface FederationDownloadStorage {
  storage: Pick<MinioBackend, "head" | "presignDownload">;
  allowedOrigins: readonly string[];
}

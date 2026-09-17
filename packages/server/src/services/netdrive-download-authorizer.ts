import type { NetDriveFile } from "@kuintessence/shared";
import type { AuthzCheck, AuthzService } from "../authz/service";
import type { NetDriveService, NetDriveTransferContext } from "./netdrive";

const INPUT_FILE_UNAVAILABLE = "NetDrive input file is unavailable or no longer authorized";

interface NetDriveDownloadActor {
  email: string;
  isPlatformAdmin: boolean;
}

export interface NetDriveDownloadAuthorizerDeps {
  service: Pick<NetDriveService, "getFileById" | "mintDownloadUrlForAuthorizedFile">;
  authz?: Pick<AuthzService, "mode" | "requirePermission">;
  resolveActor: (actorUserId: string) => Promise<NetDriveDownloadActor | null>;
}

export type AuthorizedNetDriveDownloadMint = (
  actorUserId: string,
  fileId: string,
  context?: NetDriveTransferContext,
) => Promise<{ downloadUrl: string; expiresAt: string }>;

export function createAuthorizedNetDriveDownloadMint(
  deps: NetDriveDownloadAuthorizerDeps,
): AuthorizedNetDriveDownloadMint {
  return async (actorUserId, fileId, context) => {
    const file = await deps.service.getFileById(fileId);
    if (!file) throw unavailableInputFile();

    if (file.ownerId !== actorUserId) {
      await requireSharedFileUse(deps, actorUserId, file);
    }

    return deps.service.mintDownloadUrlForAuthorizedFile(actorUserId, file, context);
  };
}

async function requireSharedFileUse(
  deps: NetDriveDownloadAuthorizerDeps,
  actorUserId: string,
  file: NetDriveFile,
): Promise<void> {
  if (deps.authz?.mode !== "enforce") throw unavailableInputFile();
  const actor = await deps.resolveActor(actorUserId);
  if (!actor) throw unavailableInputFile();

  const check: AuthzCheck = {
    actorUserId,
    actorEmail: actor.email,
    resource: { type: "netdrive_file", id: file.id },
    permission: "use",
    subject: { type: "user", id: actorUserId },
    context: { route: "job_input_staging#source" },
  };
  try {
    await deps.authz.requirePermission(check, actor.isPlatformAdmin);
  } catch {
    throw unavailableInputFile();
  }
}

function unavailableInputFile(): Error {
  return new Error(INPUT_FILE_UNAVAILABLE);
}

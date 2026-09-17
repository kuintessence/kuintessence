import { describe, expect, test } from "bun:test";
import type { NetDriveFile } from "@kuintessence/shared";
import type { AuthzCheck, AuthzService } from "../authz/service";
import {
  createAuthorizedNetDriveDownloadMint,
  type NetDriveDownloadAuthorizerDeps,
} from "./netdrive-download-authorizer";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const SHARED_ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const FILE_ID = "00000000-0000-4000-8000-000000000003";

const file: NetDriveFile = {
  id: FILE_ID,
  ownerId: OWNER_ID,
  path: "inputs/mesh.tar.gz",
  size: 128,
  sha256: "a".repeat(64),
  contentType: "application/gzip",
  etag: "etag-1",
  storageKey: "netdrive/owner/mesh.tar.gz",
  mtime: "2026-08-12T00:00:00.000Z",
  createdAt: "2026-08-12T00:00:00.000Z",
};

function harness(
  options: {
    file?: NetDriveFile | null;
    mode?: "off" | "shadow" | "enforce";
    actor?: { email: string; isPlatformAdmin: boolean } | null;
    permissionError?: Error;
  } = {},
) {
  const checks: AuthzCheck[] = [];
  const platformAdminDegrades: Array<boolean | undefined> = [];
  const mints: Array<{ actorUserId: string; file: NetDriveFile; context?: object }> = [];
  const resolveActors: string[] = [];
  const mode = options.mode ?? "enforce";
  const authz: Pick<AuthzService, "mode" | "requirePermission"> = {
    mode,
    requirePermission: async (check, platformAdminDegrade) => {
      checks.push(check);
      platformAdminDegrades.push(platformAdminDegrade);
      if (options.permissionError) throw options.permissionError;
    },
  };
  const deps: NetDriveDownloadAuthorizerDeps = {
    service: {
      getFileById: async () => (options.file === undefined ? file : options.file),
      mintDownloadUrlForAuthorizedFile: async (actorUserId, foundFile, context) => {
        mints.push({ actorUserId, file: foundFile, context });
        return {
          downloadUrl: `https://minio.test/${foundFile.id}`,
          expiresAt: "2026-08-12T00:15:00.000Z",
        };
      },
    },
    authz,
    resolveActor: async (actorUserId) => {
      resolveActors.push(actorUserId);
      return options.actor === undefined
        ? { email: "shared@example.test", isPlatformAdmin: false }
        : options.actor;
    },
  };
  return {
    checks,
    platformAdminDegrades,
    mints,
    resolveActors,
    mint: createAuthorizedNetDriveDownloadMint(deps),
  };
}

describe("createAuthorizedNetDriveDownloadMint", () => {
  test("mints an owner's file with actor and job/workflow attribution", async () => {
    const h = harness();
    const context = {
      jobId: "00000000-0000-4000-8000-000000000004",
      workflowRunId: "00000000-0000-4000-8000-000000000005",
      netdriveFileIds: [FILE_ID],
    };

    await expect(h.mint(OWNER_ID, FILE_ID, context)).resolves.toEqual({
      downloadUrl: `https://minio.test/${FILE_ID}`,
      expiresAt: "2026-08-12T00:15:00.000Z",
    });
    expect(h.checks).toEqual([]);
    expect(h.resolveActors).toEqual([]);
    expect(h.mints).toEqual([{ actorUserId: OWNER_ID, file, context }]);
  });

  test("mints a shared file only after enforce-mode netdrive_file#use succeeds", async () => {
    const h = harness();
    const context = { jobId: "00000000-0000-4000-8000-000000000004" };

    await h.mint(SHARED_ACTOR_ID, FILE_ID, context);

    expect(h.checks).toEqual([
      {
        actorUserId: SHARED_ACTOR_ID,
        actorEmail: "shared@example.test",
        resource: { type: "netdrive_file", id: FILE_ID },
        permission: "use",
        subject: { type: "user", id: SHARED_ACTOR_ID },
        context: { route: "job_input_staging#source" },
      },
    ]);
    expect(h.platformAdminDegrades).toEqual([false]);
    expect(h.mints).toEqual([{ actorUserId: SHARED_ACTOR_ID, file, context }]);
  });

  test("passes the platform administrator fallback scope to the authorization service", async () => {
    const h = harness({
      actor: { email: "admin@example.test", isPlatformAdmin: true },
    });

    await h.mint(SHARED_ACTOR_ID, FILE_ID);

    expect(h.platformAdminDegrades).toEqual([true]);
  });

  test.each([
    "off",
    "shadow",
  ] as const)("fails closed for shared files when AUTHZ_MODE is %s", async (mode) => {
    const h = harness({ mode });

    await expect(h.mint(SHARED_ACTOR_ID, FILE_ID)).rejects.toThrow(
      "NetDrive input file is unavailable or no longer authorized",
    );
    expect(h.checks).toEqual([]);
    expect(h.resolveActors).toEqual([]);
    expect(h.mints).toEqual([]);
  });

  test("fails closed when shared netdrive_file#use is denied", async () => {
    const h = harness({ permissionError: new Error("denied") });

    await expect(h.mint(SHARED_ACTOR_ID, FILE_ID)).rejects.toThrow(
      "NetDrive input file is unavailable or no longer authorized",
    );
    expect(h.checks).toHaveLength(1);
    expect(h.mints).toEqual([]);
  });

  test("fails closed when the shared-file actor no longer exists", async () => {
    const h = harness({ actor: null });

    await expect(h.mint(SHARED_ACTOR_ID, FILE_ID)).rejects.toThrow(
      "NetDrive input file is unavailable or no longer authorized",
    );
    expect(h.checks).toEqual([]);
    expect(h.mints).toEqual([]);
  });

  test("fails closed when the NetDrive file no longer exists", async () => {
    const h = harness({ file: null });

    await expect(h.mint(OWNER_ID, FILE_ID)).rejects.toThrow(
      "NetDrive input file is unavailable or no longer authorized",
    );
    expect(h.checks).toEqual([]);
    expect(h.resolveActors).toEqual([]);
    expect(h.mints).toEqual([]);
  });
});

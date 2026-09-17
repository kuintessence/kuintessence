import { describe, expect, test } from "bun:test";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import {
  authorizeSoftwareAssetAccessThroughSpice,
  evaluateRuntimeAvailability,
  evaluateUsecasePolicy,
  mergeEffectiveAvailabilityPolicyLayers,
  patternMatches,
  softwareAvailabilityGrantSubjectIds,
  softwareAvailabilityOwnsUserAsset,
} from "./software-availability";

describe("software availability policy matching", () => {
  test("matches exact specs and wildcard package versions", () => {
    expect(patternMatches("gromacs@2024.1", "gromacs@2024.1")).toBe(true);
    expect(patternMatches("gromacs@2024.*", "gromacs@2024.1")).toBe(true);
    expect(patternMatches("gromacs@*", "gromacs@2025.0")).toBe(true);
    expect(patternMatches("gromacs@2024.*", "gromacs@2023.4")).toBe(false);
  });

  test("treats package names without wildcards as exact matches", () => {
    expect(patternMatches("vasp", "vasp")).toBe(true);
    expect(patternMatches("vasp", "vasp@6.4")).toBe(false);
    expect(patternMatches("vasp*", "vasp-gpu")).toBe(true);
  });

  test("usecase policy deny list blocks before default allow", () => {
    expect(
      evaluateUsecasePolicy(
        {
          usecaseDefaultAllow: true,
          usecaseAllowList: ["usecase:openfoam-*"],
          usecaseDenyList: ["usecase:openfoam-cavity"],
        },
        { name: "openfoam-cavity" },
      ),
    ).toEqual(["blocked by usecase deny list"]);
  });

  test("usecase policy allows matching whitelist entries when default deny is active", () => {
    expect(
      evaluateUsecasePolicy(
        {
          usecaseDefaultAllow: false,
          usecaseAllowList: ["usecase:gromacs-*", "asset:asset-1"],
          usecaseDenyList: [],
        },
        { name: "gromacs-md", version: "2024.1" },
      ),
    ).toEqual([]);
  });

  test("usecase policy blocks unlisted usecases when default deny is active", () => {
    expect(
      evaluateUsecasePolicy(
        {
          usecaseDefaultAllow: false,
          usecaseAllowList: ["usecase:gromacs-*"],
          usecaseDenyList: [],
        },
        { id: "asset-2", name: "openfoam-cavity" },
      ),
    ).toEqual(["usecase is not allowed by provider usecase policy"]);
  });

  test("runtime availability blocks agents without a control channel", () => {
    expect(evaluateRuntimeAvailability(false)).toEqual(["agent control channel is offline"]);
    expect(evaluateRuntimeAvailability(true)).toEqual([]);
    expect(evaluateRuntimeAvailability(null)).toEqual([]);
  });

  test("availability effective policy merge matches operation precheck list semantics", () => {
    expect(
      mergeEffectiveAvailabilityPolicyLayers({
        provider: {
          installMode: "preinstalled-only",
          allowList: [" zlib@* ", "hdf5@*"],
          denyList: ["blocked@*"],
          lockEnabled: false,
          trustedPublicAutoInstall: false,
          usecaseDefaultAllow: true,
          usecaseAllowList: ["usecase:provider"],
          usecaseDenyList: ["usecase:blocked-provider"],
        },
        cluster: {
          installMode: "trusted-public-auto-install",
          allowList: ["gromacs@*", "zlib@*"],
          denyList: ["cluster-blocked@*"],
          lockEnabled: true,
          trustedPublicAutoInstall: true,
          usecaseDefaultAllow: false,
          usecaseAllowList: ["usecase:cluster"],
          usecaseDenyList: ["usecase:blocked-cluster"],
        },
        legacy: {
          allowList: ["legacy@*", "gromacs@*"],
          denyList: ["legacy-blocked@*"],
          lockEnabled: false,
        },
        agentOverlay: {
          installMode: "explicit-install-grant",
          allowList: ["agent@*"],
          denyList: ["agent-blocked@*"],
          trustedPublicAutoInstall: false,
          usecaseDefaultAllow: true,
          usecaseAllowList: ["usecase:agent", "usecase:cluster"],
          usecaseDenyList: ["usecase:blocked-agent"],
        },
      }),
    ).toEqual({
      installMode: "explicit-install-grant",
      allowList: ["agent@*", "gromacs@*", "hdf5@*", "legacy@*", "zlib@*"],
      denyList: ["agent-blocked@*", "blocked@*", "cluster-blocked@*", "legacy-blocked@*"],
      lockEnabled: true,
      trustedPublicAutoInstall: false,
      usecaseDefaultAllow: true,
      usecaseAllowList: ["usecase:agent", "usecase:cluster", "usecase:provider"],
      usecaseDenyList: [
        "usecase:blocked-agent",
        "usecase:blocked-cluster",
        "usecase:blocked-provider",
      ],
    });
  });
});

describe("software asset SpiceDB authorization bridge", () => {
  const principal: BoundPrincipal = {
    sub: "legacy-subject",
    role: "user",
    email: "user@example.com",
    userId: "user-1",
    orgId: "org-1",
    orgIds: ["org-1"],
    memberships: [],
    capabilities: [],
  };

  test("records shadow checks without changing the local decision", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (input: unknown) => {
        calls.push(input);
        return false;
      },
    } as unknown as AuthzService;

    const decision = await authorizeSoftwareAssetAccessThroughSpice({
      authz,
      assetId: "asset-1",
      capability: "install",
      principal,
      local: { allowed: false, reason: "blocked by provider deny list" },
    });

    expect(decision).toEqual({ allowed: false, reason: "blocked by provider deny list" });
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "user@example.com",
        resource: { type: "software_asset", id: "asset-1" },
        permission: "install",
        subject: { type: "user", id: "user-1" },
        context: { capability: "install", localAllowed: false },
        localAllowed: false,
      },
    ]);
  });

  test("requires SpiceDB permission in enforce mode", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown, isPlatformAdmin: boolean) => {
        calls.push({ input, isPlatformAdmin });
      },
    } as unknown as AuthzService;

    const decision = await authorizeSoftwareAssetAccessThroughSpice({
      authz,
      assetId: "asset-1",
      capability: "use",
      principal,
      local: { allowed: true },
    });

    expect(decision).toEqual({ allowed: true });
    expect(calls).toEqual([
      {
        input: {
          actorUserId: "user-1",
          actorEmail: "user@example.com",
          resource: { type: "software_asset", id: "asset-1" },
          permission: "use",
          subject: { type: "user", id: "user-1" },
          context: { capability: "use", localAllowed: true },
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("does not let SpiceDB override Server-local business denials", async () => {
    let checked = false;
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        checked = true;
      },
    } as unknown as AuthzService;

    const decision = await authorizeSoftwareAssetAccessThroughSpice({
      authz,
      assetId: "asset-1",
      capability: "install",
      principal,
      local: { allowed: false, reason: "asset lifecycle 'revoked' blocks install" },
    });

    expect(checked).toBe(true);
    expect(decision).toEqual({
      allowed: false,
      reason: "asset lifecycle 'revoked' blocks install",
    });
  });

  test("fails closed in shadow mode when canonical user id is unavailable", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (input: unknown) => {
        calls.push(input);
        return true;
      },
    } as unknown as AuthzService;

    await expect(
      authorizeSoftwareAssetAccessThroughSpice({
        authz,
        assetId: "asset-1",
        capability: "use",
        principal: { ...principal, userId: null },
        local: { allowed: true },
      }),
    ).rejects.toThrow("Authorization principal is not bound");

    expect(calls).toEqual([]);
  });

  test("fails closed in enforce mode when canonical user id is unavailable", async () => {
    let checked = false;
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        checked = true;
      },
    } as unknown as AuthzService;

    await expect(
      authorizeSoftwareAssetAccessThroughSpice({
        authz,
        assetId: "asset-1",
        capability: "use",
        principal: { ...principal, userId: null },
        local: { allowed: true },
      }),
    ).rejects.toThrow("Authorization principal is not bound");
    expect(checked).toBe(false);
  });
});

describe("software availability canonical local subjects", () => {
  const principal: BoundPrincipal = {
    sub: "oidc-subject",
    role: "user",
    email: "user@example.com",
    userId: "11111111-1111-4111-8111-111111111111",
    orgId: "22222222-2222-4222-8222-222222222222",
    orgIds: ["22222222-2222-4222-8222-222222222222"],
    memberships: [],
    capabilities: [],
  };

  test("uses canonical users.id for local grant lookup subjects", () => {
    expect(softwareAvailabilityGrantSubjectIds(principal)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "platform",
    ]);
  });

  test("does not fall back to JWT sub for user grant lookup subjects", () => {
    expect(softwareAvailabilityGrantSubjectIds({ ...principal, userId: null })).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "platform",
    ]);
  });

  test("uses canonical users.id for software asset owner checks", () => {
    expect(
      softwareAvailabilityOwnsUserAsset(
        { ownerUserId: "11111111-1111-4111-8111-111111111111" },
        principal,
      ),
    ).toBe(true);
    expect(softwareAvailabilityOwnsUserAsset({ ownerUserId: "oidc-subject" }, principal)).toBe(
      false,
    );
  });
});

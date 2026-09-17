import { describe, expect, test } from "bun:test";
import { type DesensitizeConfig, decideAction, resolveActionForField } from "./decision";

const HARD_OFF: DesensitizeConfig = {
  globalEnabled: false,
  providers: [],
  clusters: [],
  fields: [],
};

describe("decideAction (single-field resolver)", () => {
  test("globalEnabled=false → passthrough regardless of any rule", () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: false,
      providers: [],
      clusters: [],
      fields: [{ field: "actorEmail", action: "redact" }],
    };
    expect(decideAction(cfg, { fieldPath: "actorEmail" })).toBe("passthrough");
  });

  test("globalEnabled=true with no rules → passthrough", () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [],
    };
    expect(decideAction(cfg, { fieldPath: "actorEmail" })).toBe("passthrough");
  });

  test("global field rule applies when no provider/cluster scope present", () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [{ field: "actorEmail", action: "hash" }],
    };
    expect(decideAction(cfg, { fieldPath: "actorEmail" })).toBe("hash");
  });

  test("provider rule overrides global when providerId matches", () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [{ providerId: "p1", fields: [{ field: "command", action: "redact" }] }],
      clusters: [],
      fields: [{ field: "command", action: "hash" }],
    };
    expect(decideAction(cfg, { fieldPath: "command", providerId: "p1" })).toBe("redact");
  });

  test("cluster rule overrides provider when both match", () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [{ providerId: "p1", fields: [{ field: "command", action: "hash" }] }],
      clusters: [{ clusterId: "c1", fields: [{ field: "command", action: "hide" }] }],
      fields: [{ field: "command", action: "passthrough" }],
    };
    expect(decideAction(cfg, { fieldPath: "command", providerId: "p1", clusterId: "c1" })).toBe(
      "hide",
    );
  });

  test("cluster rule wins even when only cluster matches (no provider rule)", () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [{ clusterId: "c1", fields: [{ field: "actorEmail", action: "alias" }] }],
      fields: [{ field: "actorEmail", action: "hash" }],
    };
    expect(decideAction(cfg, { fieldPath: "actorEmail", clusterId: "c1" })).toBe("alias");
  });

  test("non-matching providerId falls through to global", () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [{ providerId: "p2", fields: [{ field: "command", action: "redact" }] }],
      clusters: [],
      fields: [{ field: "command", action: "hash" }],
    };
    // providerId="p1" does not match "p2", so global rule wins
    expect(decideAction(cfg, { fieldPath: "command", providerId: "p1" })).toBe("hash");
  });

  test("hard-limit invariant: lower scope cannot loosen stricter parent action", () => {
    // global=hide is the strictest. A cluster rule asking for "passthrough"
    // must be ignored — the framework enforces tighten-only semantics.
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [{ clusterId: "c1", fields: [{ field: "command", action: "passthrough" }] }],
      fields: [{ field: "command", action: "hide" }],
    };
    expect(decideAction(cfg, { fieldPath: "command", clusterId: "c1" })).toBe("hide");
  });

  test("hard-limit invariant: cluster CAN tighten provider's looser rule", () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [{ providerId: "p1", fields: [{ field: "command", action: "hash" }] }],
      clusters: [{ clusterId: "c1", fields: [{ field: "command", action: "hide" }] }],
      fields: [],
    };
    expect(decideAction(cfg, { fieldPath: "command", providerId: "p1", clusterId: "c1" })).toBe(
      "hide",
    );
  });

  test("unknown field path → passthrough (no implicit redaction)", () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [{ field: "command", action: "redact" }],
    };
    expect(decideAction(cfg, { fieldPath: "envVars" })).toBe("passthrough");
  });
});

describe("resolveActionForField (with viewer context)", () => {
  test("passes through when global is off", () => {
    const action = resolveActionForField(HARD_OFF, {
      fieldPath: "actorEmail",
      viewerRole: "user",
      viewerOrgId: null,
      resourceOwnerId: null,
    });
    expect(action).toBe("passthrough");
  });

  test("platform_admin: framework decision wins (no automatic exemption)", () => {
    // The MVP keeps role-based exemption out of the decision engine —
    // route handlers may opt in by calling resolveActionForField with a
    // viewerRole-aware override. This test pins the contract: the engine
    // does NOT silently exempt admins.
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [{ field: "actorEmail", action: "hash" }],
    };
    expect(
      resolveActionForField(cfg, {
        fieldPath: "actorEmail",
        viewerRole: "platform_admin",
        viewerOrgId: null,
        resourceOwnerId: null,
      }),
    ).toBe("hash");
  });

  test("default off when globalEnabled is false even for fields with rules", () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: false,
      providers: [],
      clusters: [],
      fields: [{ field: "command", action: "redact" }],
    };
    expect(
      resolveActionForField(cfg, {
        fieldPath: "command",
        viewerRole: "user",
        viewerOrgId: null,
        resourceOwnerId: null,
      }),
    ).toBe("passthrough");
  });
});

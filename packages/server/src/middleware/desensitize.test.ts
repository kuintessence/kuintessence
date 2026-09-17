import { describe, expect, test } from "bun:test";
import type { DesensitizeConfig } from "../desensitize/decision";
import { type ApplyContext, applyDesensitizationToBody } from "./desensitize";

const offConfig: DesensitizeConfig = {
  globalEnabled: false,
  providers: [],
  clusters: [],
  fields: [],
};

function ctx(overrides: Partial<ApplyContext> = {}): ApplyContext {
  return {
    resourceType: "audit-log-entry",
    viewerRole: "user",
    viewerOrgId: null,
    resourceOwnerId: null,
    aliasSalt: "test-salt",
    recordAlias: async () => undefined,
    ...overrides,
  };
}

describe("applyDesensitizationToBody — globally disabled", () => {
  test("globalEnabled=false → body unchanged (deep equal)", async () => {
    const body = { actorEmail: "alice@example.com", details: { sensitive: true } };
    const out = await applyDesensitizationToBody(offConfig, body, ctx());
    expect(out).toEqual(body);
  });

  test("globalEnabled=false short-circuits even with field rules present", async () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: false,
      providers: [],
      clusters: [],
      fields: [{ field: "actorEmail", action: "redact" }],
    };
    const out = await applyDesensitizationToBody(cfg, { actorEmail: "alice@example.com" }, ctx());
    expect((out as { actorEmail: string }).actorEmail).toBe("alice@example.com");
  });
});

describe("applyDesensitizationToBody — top-level field actions", () => {
  test("redact replaces string field with ***", async () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [{ field: "actorEmail", action: "redact" }],
    };
    const out = await applyDesensitizationToBody(cfg, { actorEmail: "alice@example.com" }, ctx());
    expect((out as { actorEmail: string }).actorEmail).toBe("***");
  });

  test("hash produces 12-hex-char value", async () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [{ field: "actorEmail", action: "hash" }],
    };
    const out = await applyDesensitizationToBody(cfg, { actorEmail: "alice@example.com" }, ctx());
    expect((out as { actorEmail: string }).actorEmail).toMatch(/^[0-9a-f]{12}$/);
  });

  test("hide drops the field from the output entirely", async () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [{ field: "actorEmail", action: "hide" }],
    };
    const out = (await applyDesensitizationToBody(
      cfg,
      { actorEmail: "alice@example.com", action: "login" },
      ctx(),
    )) as Record<string, unknown>;
    expect("actorEmail" in out).toBe(false);
    expect(out.action).toBe("login");
  });

  test("alias produces a deterministic 16-hex value and records the mapping", async () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [{ field: "actorEmail", action: "alias" }],
    };
    const recorded: Array<{ aliasId: string; salt: string; original: string }> = [];
    const out = await applyDesensitizationToBody(
      cfg,
      { actorEmail: "alice@example.com" },
      ctx({
        recordAlias: async (aliasId, salt, original) => {
          recorded.push({ aliasId, salt, original });
        },
      }),
    );
    const aliased = (out as { actorEmail: string }).actorEmail;
    expect(aliased).toMatch(/^[0-9a-f]{16}$/);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      aliasId: aliased,
      salt: "test-salt",
      original: "alice@example.com",
    });
  });

  test("alias is stable across calls for same value", async () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [{ field: "actorEmail", action: "alias" }],
    };
    const a = (await applyDesensitizationToBody(
      cfg,
      { actorEmail: "alice@example.com" },
      ctx(),
    )) as { actorEmail: string };
    const b = (await applyDesensitizationToBody(
      cfg,
      { actorEmail: "alice@example.com" },
      ctx(),
    )) as { actorEmail: string };
    expect(a.actorEmail).toBe(b.actorEmail);
  });
});

describe("applyDesensitizationToBody — array of records", () => {
  test("applies actions to every element in an array body", async () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [{ field: "actorEmail", action: "redact" }],
    };
    const out = (await applyDesensitizationToBody(
      cfg,
      [
        { actorEmail: "a@x", action: "x" },
        { actorEmail: "b@y", action: "y" },
      ],
      ctx(),
    )) as Array<{ actorEmail: string; action: string }>;
    expect(out).toHaveLength(2);
    expect(out[0]?.actorEmail).toBe("***");
    expect(out[1]?.actorEmail).toBe("***");
    expect(out[0]?.action).toBe("x");
  });

  test("non-record array elements pass through unchanged", async () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [{ field: "actorEmail", action: "redact" }],
    };
    const out = (await applyDesensitizationToBody(cfg, ["a", "b", 1, null], ctx())) as unknown[];
    expect(out).toEqual(["a", "b", 1, null]);
  });
});

describe("applyDesensitizationToBody — nested envelope", () => {
  test("walks into a top-level `entries` array (audit-log shape)", async () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [{ field: "actorEmail", action: "redact" }],
    };
    const out = (await applyDesensitizationToBody(
      cfg,
      {
        entries: [
          { actorEmail: "a@x", action: "login" },
          { actorEmail: "b@y", action: "logout" },
        ],
      },
      ctx(),
    )) as { entries: Array<{ actorEmail: string }> };
    expect(out.entries[0]?.actorEmail).toBe("***");
    expect(out.entries[1]?.actorEmail).toBe("***");
  });
});

describe("applyDesensitizationToBody — preserves shape when no rule matches", () => {
  test("body without any matching field path is returned untouched", async () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [{ field: "actorEmail", action: "redact" }],
    };
    const body = { id: "abc", action: "login" };
    const out = await applyDesensitizationToBody(cfg, body, ctx());
    expect(out).toEqual(body);
  });

  test("primitives pass through unchanged", async () => {
    const cfg: DesensitizeConfig = {
      globalEnabled: true,
      providers: [],
      clusters: [],
      fields: [{ field: "x", action: "redact" }],
    };
    expect(await applyDesensitizationToBody(cfg, "string body", ctx())).toBe("string body");
    expect(await applyDesensitizationToBody(cfg, 42, ctx())).toBe(42);
    expect(await applyDesensitizationToBody(cfg, null, ctx())).toBeNull();
  });
});

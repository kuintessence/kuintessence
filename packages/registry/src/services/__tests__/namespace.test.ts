// namespace + RBAC tests.
import { describe, expect, it } from "bun:test";
import {
  checkNamespaceAccess,
  NamespaceParseError,
  NamespacePermissionError,
  parseNamespace,
  type RbacPrincipal,
  validateTag,
} from "../namespace";

const superadmin: RbacPrincipal = { sub: "u-super", role: "super_admin", orgIds: [] };
const platadmin: RbacPrincipal = { sub: "u-pa", role: "platform_admin", orgIds: [] };
const orgadminA: RbacPrincipal = { sub: "u-oaA", role: "org_admin", orgIds: ["org-A"] };
const operatorA: RbacPrincipal = { sub: "u-opA", role: "operator", orgIds: ["org-A"] };
const userA: RbacPrincipal = { sub: "u-A", role: "user", orgIds: ["org-A"] };
const userB: RbacPrincipal = { sub: "u-B", role: "user", orgIds: ["org-B"] };

describe("parseNamespace", () => {
  it("parses public", () => {
    expect(parseNamespace("public/gromacs")).toEqual({
      kind: "public",
      owner: null,
      name: "gromacs",
    });
  });
  it("parses org with multi-segment repo", () => {
    expect(parseNamespace("org/org-A/team/our-app")).toEqual({
      kind: "org",
      owner: "org-A",
      name: "team/our-app",
    });
  });
  it("parses user", () => {
    expect(parseNamespace("user/u-1/scratch")).toEqual({
      kind: "user",
      owner: "u-1",
      name: "scratch",
    });
  });
  it("rejects unknown kind", () => {
    expect(() => parseNamespace("system/foo")).toThrow(NamespaceParseError);
  });
  it("rejects org without owner", () => {
    expect(() => parseNamespace("org/")).toThrow(NamespaceParseError);
  });
  it("rejects invalid repo name", () => {
    expect(() => parseNamespace("public/Foo$Bar")).toThrow(NamespaceParseError);
  });
});

describe("checkNamespaceAccess — public", () => {
  it("allows any auth user to read", () => {
    expect(() =>
      checkNamespaceAccess(userA, { kind: "public", owner: null, name: "gromacs" }, "read"),
    ).not.toThrow();
  });
  it("denies regular user to write", () => {
    expect(() =>
      checkNamespaceAccess(userA, { kind: "public", owner: null, name: "gromacs" }, "write"),
    ).toThrow(NamespacePermissionError);
  });
  it("allows platform_admin to write", () => {
    expect(() =>
      checkNamespaceAccess(platadmin, { kind: "public", owner: null, name: "gromacs" }, "write"),
    ).not.toThrow();
  });
});

describe("checkNamespaceAccess — org", () => {
  it("member can read", () => {
    expect(() =>
      checkNamespaceAccess(userA, { kind: "org", owner: "org-A", name: "x" }, "read"),
    ).not.toThrow();
  });
  it("non-member cannot read", () => {
    expect(() =>
      checkNamespaceAccess(userB, { kind: "org", owner: "org-A", name: "x" }, "read"),
    ).toThrow(NamespacePermissionError);
  });
  it("org_admin in same org can write", () => {
    expect(() =>
      checkNamespaceAccess(orgadminA, { kind: "org", owner: "org-A", name: "x" }, "write"),
    ).not.toThrow();
  });
  it("operator in same org can read but cannot publish by default", () => {
    const namespace = { kind: "org", owner: "org-A", name: "x" } as const;
    expect(() => checkNamespaceAccess(operatorA, namespace, "read")).not.toThrow();
    expect(() => checkNamespaceAccess(operatorA, namespace, "write")).toThrow(
      NamespacePermissionError,
    );
  });
  it("regular member cannot write", () => {
    expect(() =>
      checkNamespaceAccess(userA, { kind: "org", owner: "org-A", name: "x" }, "write"),
    ).toThrow(NamespacePermissionError);
  });
  it("platform_admin can write to any org", () => {
    expect(() =>
      checkNamespaceAccess(platadmin, { kind: "org", owner: "org-A", name: "x" }, "write"),
    ).not.toThrow();
  });
});

describe("checkNamespaceAccess — user", () => {
  it("owner can read", () => {
    expect(() =>
      checkNamespaceAccess(userA, { kind: "user", owner: "u-A", name: "x" }, "read"),
    ).not.toThrow();
  });
  it("owner still needs a publisher role to write", () => {
    expect(() =>
      checkNamespaceAccess(userA, { kind: "user", owner: "u-A", name: "x" }, "write"),
    ).toThrow(NamespacePermissionError);
  });
  it("owner can write when user is configured as a publisher role", () => {
    expect(() =>
      checkNamespaceAccess(userA, { kind: "user", owner: "u-A", name: "x" }, "write", ["user"]),
    ).not.toThrow();
  });
  it("other users cannot access", () => {
    expect(() =>
      checkNamespaceAccess(userB, { kind: "user", owner: "u-A", name: "x" }, "read"),
    ).toThrow(NamespacePermissionError);
  });
  it("super_admin bypass", () => {
    expect(() =>
      checkNamespaceAccess(superadmin, { kind: "user", owner: "u-A", name: "x" }, "write"),
    ).not.toThrow();
  });
});

describe("validateTag", () => {
  it.each([
    ["v1.2.3", true, false],
    ["1.2.3", true, false],
    ["1.2.3-rc.1", true, false],
    ["1.2.3+build.5", true, false],
    ["latest", true, true],
  ])("accepts %s", (tag, ok, mutable) => {
    const r = validateTag(tag);
    if (ok) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.mutable).toBe(mutable);
    }
  });

  it.each(["dev", "main", "v1", "1.0", "release-2024"])("rejects %s", (tag) => {
    const r = validateTag(tag);
    expect(r.ok).toBe(false);
  });
});

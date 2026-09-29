const { describe, expect, test } = require("bun:test");
const { cleanupImages } = require("./ghcr-cleanup.cjs");

const COMPONENTS = ["server", "registry", "web", "db-migrate", "seed", "scheduler"];
const PACKAGES = COMPONENTS.map((component) => `kq-dev-${component}`);
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const SECRET_ERROR = "private token and raw API response must not be logged";

function tag(pr = 15, run = 42, attempt = 1) {
  return `pr-${pr}-sha-${SHA}-run-${run}-${attempt}`;
}

function version(id, tags = [tag()]) {
  return { id, name: DIGEST, metadata: { package_type: "container", container: { tags } } };
}

function apiError(status) {
  return Object.assign(new Error(SECRET_ERROR), {
    status, response: { data: { token: SECRET_ERROR } },
  });
}

function fixture(type = "Organization") {
  const context = {
    repo: { owner: "example", repo: "project" },
    payload: { repository: { owner: { type } } },
  };
  const entries = new Map(PACKAGES.map((name) => [name, {
    pkg: { name, package_type: "container", repository: { full_name: "example/project" } },
    pages: [[]],
  }]));
  const calls = [];
  const messages = [];
  const deleted = [];
  const prefix = type === "Organization"
    ? "/orgs/{org}/packages/{package_type}/{package_name}"
    : "/users/{username}/packages/{package_type}/{package_name}";
  const github = {
    request: async (route, params) => {
      calls.push({ route, params });
      const entry = entries.get(params.package_name);
      if (!entry) throw new Error("Unexpected package outside allowlist");
      if (route === `GET ${prefix}`) {
        if (entry.packageError) throw apiError(entry.packageError);
        return { data: structuredClone(entry.pkg) };
      }
      const found = entry.pages.flat().find((item) => item.id === params.package_version_id);
      if (route === `GET ${prefix}/versions/{package_version_id}`) {
        if (entry.getError) throw apiError(entry.getError);
        return { data: structuredClone(entry.current?.(found) ?? found) };
      }
      if (route === `DELETE ${prefix}/versions/{package_version_id}`) {
        if (entry.deleteError) throw apiError(entry.deleteError);
        deleted.push({ package: params.package_name, id: params.package_version_id });
        entry.pages = entry.pages.map((page) => page.filter((item) => item.id !== found.id));
        return { status: 204 };
      }
      throw new Error("Unexpected API route");
    },
    paginate: async (route, params) => {
      calls.push({ route, params, paginate: true });
      expect(route).toBe(`GET ${prefix}/versions`);
      expect(params.per_page).toBe(100);
      expect(params.state).toBe("active");
      const entry = entries.get(params.package_name);
      if (!entry) throw new Error("Unexpected pagination package");
      if (entry.listError) throw apiError(entry.listError);
      return structuredClone(entry.pages.flat());
    },
  };
  const core = {
    info: (message) => messages.push(message),
    warning: (message) => messages.push(message),
  };
  return { github, context, core, entries, calls, messages, deleted, prefix };
}

async function expectIncomplete(f, options = { pr: 15 }) {
  let caught;
  try {
    await cleanupImages(f, options);
  } catch (error) {
    caught = error;
  }
  expect(caught?.message).toBe(
    "Preview image cleanup incomplete; inspect the fixed cleanup markers.",
  );
  expect(caught?.cause).toBeUndefined();
  expect(JSON.stringify(f.messages)).not.toContain(SECRET_ERROR);
  expect(f.messages.some((message) => message.includes("code=OK"))).toBe(false);
}

describe("GHCR preview version cleanup", () => {
  test.each(["Organization", "User"])("uses owner-scoped %s routes and only six packages", async (type) => {
    const f = fixture(type);
    for (const [index, name] of PACKAGES.entries()) {
      f.entries.get(name).pages = [[version(index + 1)]];
    }
    const result = await cleanupImages(f, { pr: "15" });
    expect(result.deleted).toBe(6);
    expect(new Set(f.calls.map((call) => call.params.package_name))).toEqual(new Set(PACKAGES));
    expect(f.calls.filter((call) => call.paginate)).toHaveLength(6);
    for (const call of f.calls) {
      expect(call.params.package_type).toBe("container");
      expect(call.params[type === "Organization" ? "org" : "username"]).toBe("example");
      expect(call.params[type === "Organization" ? "username" : "org"]).toBeUndefined();
      expect(call.route.startsWith(`GET ${f.prefix}`) ||
        call.route === `DELETE ${f.prefix}/versions/{package_version_id}`).toBe(true);
    }
    expect(f.calls.filter((call) => call.route.startsWith("DELETE "))).toHaveLength(6);
  });

  test("consumes all paginated results before deleting, including versions beyond page one", async () => {
    const f = fixture();
    f.entries.get("kq-dev-server").pages = [
      Array.from({ length: 100 }, (_, index) => version(index + 1)),
      [version(101, [tag(15, 43)])],
    ];
    const result = await cleanupImages(f, { pr: 15 });
    expect(result.deleted).toBe(101);
    expect(f.deleted.at(-1)).toEqual({ package: "kq-dev-server", id: 101 });
    const pagination = f.calls.findIndex((call) => call.paginate);
    const firstDelete = f.calls.findIndex((call) => call.route.startsWith("DELETE "));
    expect(pagination).toBeGreaterThan(-1);
    expect(firstDelete).toBeGreaterThan(pagination);
  });

  test("PR 15 does not match PR 150, release tags or untagged versions", async () => {
    const f = fixture();
    f.entries.get("kq-dev-server").pages = [[
      version(1, [tag(150)]), version(2, ["release-v1"]),
      version(3, []), version(4, [tag()]), version(5, [`sha-${SHA}`]),
    ]];
    expect(await cleanupImages(f, { pr: 15 })).toEqual({
      deleted: 1, absent: 0, retained: 4, failed: 0,
    });
    expect(f.deleted).toEqual([{ package: "kq-dev-server", id: 4 }]);
  });

  test("whole-PR cleanup allows multiple recognized tags owned exclusively by that PR", async () => {
    const f = fixture();
    f.entries.get("kq-dev-server").pages = [[version(1, [tag(), tag(15, 43), tag(15, 43, 2)])]];
    expect((await cleanupImages(f, { pr: 15 })).deleted).toBe(1);
  });

  test.each([tag(150), "release-v1", "latest", `${tag()}\n`])(
    "preserves target versions shared with another or unrecognized tag %s",
    async (other) => {
      const f = fixture();
      f.entries.get("kq-dev-server").pages = [[version(1, [tag(), other]), version(2)]];
      f.entries.get("kq-dev-registry").pages = [[version(3)]];
      await expectIncomplete(f);
      expect(f.deleted).toEqual([
        { package: "kq-dev-server", id: 2 }, { package: "kq-dev-registry", id: 3 },
      ]);
      expect(f.messages.some((message) => message.includes("VERSION_SHARED_OR_UNRECOGNIZED"))).toBe(true);
    },
  );

  test.each(["repository", "missing-repository", "type", "name", "case"])(
    "refuses a package with mismatched %s and continues the allowlist",
    async (field) => {
      const f = fixture();
      const entry = f.entries.get("kq-dev-server");
      entry.pages = [[version(1)]];
      if (field === "repository") entry.pkg.repository.full_name = "example/other";
      if (field === "missing-repository") delete entry.pkg.repository;
      if (field === "type") entry.pkg.package_type = "npm";
      if (field === "name") entry.pkg.name = "kq-production-server";
      if (field === "case") entry.pkg.repository.full_name = "Example/project";
      f.entries.get("kq-dev-registry").pages = [[version(2)]];
      await expectIncomplete(f);
      expect(f.deleted).toEqual([{ package: "kq-dev-registry", id: 2 }]);
      expect(f.calls.some((call) => call.paginate && call.params.package_name === "kq-dev-server")).toBe(false);
    },
  );

  test.each(["packageError", "listError", "getError", "deleteError"])(
    "404 at %s is idempotent and does not stop other packages",
    async (phase) => {
      const f = fixture();
      const entry = f.entries.get("kq-dev-server");
      entry.pages = [[version(1)]];
      entry[phase] = 404;
      f.entries.get("kq-dev-registry").pages = [[version(2)]];
      const first = await cleanupImages(f, { pr: 15 });
      expect(first.absent).toBe(1);
      expect(first.deleted).toBe(1);
      expect((await cleanupImages(f, { pr: 15 })).deleted).toBe(0);
    },
  );

  test.each([403, 500, 503])("API %s is not swallowed and later packages are still cleaned", async (status) => {
    for (const phase of ["packageError", "listError", "getError", "deleteError"]) {
      const f = fixture();
      const entry = f.entries.get("kq-dev-server");
      entry.pages = [[version(1)]];
      entry[phase] = status;
      f.entries.get("kq-dev-registry").pages = [[version(2)]];
      await expectIncomplete(f);
      expect(f.deleted).toEqual([{ package: "kq-dev-registry", id: 2 }]);
    }
  });

  test.each(["tags", "same-pr-tag", "untagged", "digest", "id", "metadata"])(
    "rechecks %s before deleting and retains changed versions",
    async (field) => {
      const f = fixture();
      const entry = f.entries.get("kq-dev-server");
      entry.pages = [[version(1)]];
      entry.current = (listed) => {
        const changed = structuredClone(listed);
        if (field === "tags") changed.metadata.container.tags.push("release-v1");
        if (field === "same-pr-tag") changed.metadata.container.tags.push(tag(15, 99));
        if (field === "untagged") changed.metadata.container.tags = [];
        if (field === "digest") changed.name = `sha256:${"c".repeat(64)}`;
        if (field === "id") changed.id++;
        if (field === "metadata") changed.metadata.package_type = "npm";
        return changed;
      };
      await expectIncomplete(f);
      expect(f.deleted).toEqual([]);
      expect(f.messages.some((message) => message.includes("VERSION_CHANGED"))).toBe(true);
    },
  );

  test("tag ordering alone is not a mutation", async () => {
    const f = fixture();
    const entry = f.entries.get("kq-dev-server");
    entry.pages = [[version(1, [tag(), tag(15, 43)])]];
    entry.current = (listed) => ({
      ...listed,
      metadata: { package_type: "container", container: { tags: [...listed.metadata.container.tags].reverse() } },
    });
    expect((await cleanupImages(f, { pr: 15 })).deleted).toBe(1);
  });

  test("compensation deletes only the exact tag, preserving other runs of the same PR", async () => {
    const f = fixture();
    f.entries.get("kq-dev-server").pages = [[
      version(1, [tag(15, 43)]), version(2, [tag(150)]),
      version(3, [tag()]), version(4, [tag(15, 42, 2)]),
    ]];
    expect((await cleanupImages(f, { pr: 15, tag: tag() })).deleted).toBe(1);
    expect(f.deleted).toEqual([{ package: "kq-dev-server", id: 3 }]);
  });

  test("compensation refuses even same-PR shared versions", async () => {
    const f = fixture();
    f.entries.get("kq-dev-server").pages = [[version(1, [tag(), tag(15, 43)])]];
    await expectIncomplete(f, { pr: 15, tag: tag() });
    expect(f.deleted).toEqual([]);
  });

  test.each(["id", "digest", "type", "tags"])(
    "malformed listed version %s fails closed without preventing other version cleanup",
    async (field) => {
      const f = fixture();
      const invalid = version(1);
      if (field === "id") invalid.id = "../unexpected";
      if (field === "digest") invalid.name = `${DIGEST}\n`;
      if (field === "type") invalid.metadata.package_type = "npm";
      if (field === "tags") invalid.metadata.container.tags = [tag(), null];
      f.entries.get("kq-dev-server").pages = [[invalid, version(2)]];
      await expectIncomplete(f);
      expect(f.deleted).toEqual([{ package: "kq-dev-server", id: 2 }]);
      expect(f.messages.some((message) => message.includes("VERSION_INVALID"))).toBe(true);
    },
  );

  test("each DELETE follows a matching version GET", async () => {
    const f = fixture();
    f.entries.get("kq-dev-server").pages = [[version(1), version(2)]];
    await cleanupImages(f, { pr: 15 });
    for (const [index, call] of f.calls.entries()) {
      if (!call.route.startsWith("DELETE ")) continue;
      expect(f.calls[index - 1]).toEqual({
        route: `GET ${f.prefix}/versions/{package_version_id}`,
        params: call.params,
      });
    }
  });

  test.each([
    {}, { pr: 0 }, { pr: "015" }, { pr: "15\n" }, { pr: [15] },
    { pr: 15, tag: tag(150) }, { pr: 15, tag: `${tag()}\n` },
    { pr: 15, tag: "" }, { pr: 15, tag: `sha-${SHA}` },
    { pr: 15, tag: `pr-15-sha-${SHA}-run-0-1` },
  ])("invalid scope is rejected before any API call", async (options) => {
    const f = fixture();
    await expect(cleanupImages(f, options)).rejects.toThrow("Invalid preview image cleanup scope.");
    expect(f.calls).toEqual([]);
  });

  test.each(["Bot", undefined])("unknown owner type %s is rejected before requests", async (type) => {
    const f = fixture();
    f.context.payload.repository.owner.type = type;
    await expect(cleanupImages(f, { pr: 15 })).rejects.toThrow("Invalid preview image cleanup scope.");
    expect(f.calls).toEqual([]);
  });

  test.each([
    { owner: "../example", repo: "project" },
    { owner: "example\n", repo: "project" },
    { owner: "example", repo: "project\n" },
    { owner: "example", repo: ".." },
  ])("invalid repository scope is rejected before requests", async (repo) => {
    const f = fixture();
    f.context.repo = repo;
    await expect(cleanupImages(f, { pr: 15 })).rejects.toThrow("Invalid preview image cleanup scope.");
    expect(f.calls).toEqual([]);
  });
});

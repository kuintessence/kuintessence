import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  consumePendingTemplate,
  createAppTemplate,
  createSpackCatalogPackage,
  deleteSpackCatalogPackage,
  getWorkflowTemplate,
  listSpackCatalog,
  listWorkflowTemplatePage,
  listWorkflowTemplates,
  PENDING_TEMPLATE_KEY,
  parseSpackCompilers,
  parseSpackPackageFile,
  SoftwareError,
  stashPendingTemplate,
  updateSpackCatalogPackage,
  updateWorkflowTemplate,
} from "./software-client";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pending-template handoff", () => {
  test("stash + consume round-trips and clears the slot", () => {
    stashPendingTemplate({ yaml: "name: x", source: "registry" });
    const first = consumePendingTemplate();
    expect(first?.yaml).toBe("name: x");
    expect(first?.source).toBe("registry");
    // Second consumption returns null — slot has been cleared.
    expect(consumePendingTemplate()).toBeNull();
  });

  test("consume returns null when the slot is empty", () => {
    expect(consumePendingTemplate()).toBeNull();
  });

  test("consume tolerates corrupt JSON in the slot", () => {
    sessionStorage.setItem(PENDING_TEMPLATE_KEY, "{not-json");
    expect(consumePendingTemplate()).toBeNull();
  });
});

describe("listWorkflowTemplates", () => {
  function jsonResponse(body: unknown, init: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
  }

  test("returns rows on a 200 response", async () => {
    const fake = {
      workflowTemplates: [
        {
          id: "t-1",
          name: "a",
          version: "1",
          description: null,
          yamlContent: "",
          tags: [],
          createdAt: "",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(fake, { status: 200 }))),
    );
    const out = await listWorkflowTemplates();
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("a");
  });

  test("requests a paginated workflow template search and preserves total metadata", async () => {
    const fetchSpy = vi.fn((_input: RequestInfo | URL) =>
      Promise.resolve(
        jsonResponse(
          {
            templates: [],
            tags: ["hpc"],
            total: 101,
            page: 2,
            pageSize: 24,
            totalPages: 5,
            hasNext: true,
          },
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      listWorkflowTemplatePage({ page: 2, pageSize: 24, q: "climate", tag: "hpc" }),
    ).resolves.toMatchObject({ total: 101, page: 2, tags: ["hpc"], hasNext: true });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "/software/api/workflow-templates?page=2&pageSize=24&q=climate&tag=hpc",
    );
  });

  test("loads one workflow template by immutable version id", async () => {
    const template = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "child",
      version: "1.0.0",
      description: null,
      yamlContent: "name: child\nparameters: []\nspec:\n  nodeDrafts: []\n  nodeRelations: []\n",
      tags: [],
      createdAt: "",
    };
    const fetchSpy = vi.fn((_url: RequestInfo | URL) =>
      Promise.resolve(jsonResponse(template, { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(getWorkflowTemplate(template.id)).resolves.toEqual(template);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(`/software/api/workflow-templates/${template.id}`);
  });

  test("throws SoftwareError with status when the server returns 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            { error: { message: "registry down" } },
            {
              status: 503,
              statusText: "Service Unavailable",
            },
          ),
        ),
      ),
    );
    await expect(listWorkflowTemplates()).rejects.toThrow(SoftwareError);
    try {
      await listWorkflowTemplates();
      throw new Error("did not throw");
    } catch (e) {
      const err = e as SoftwareError;
      expect(err.status).toBe(503);
      expect(err.message).toBe("registry down");
    }
  });

  test("falls back to statusText when the body has no error.message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            { error: {} },
            {
              status: 404,
              statusText: "Not Found",
            },
          ),
        ),
      ),
    );
    try {
      await listWorkflowTemplates();
      throw new Error("did not throw");
    } catch (e) {
      const err = e as SoftwareError;
      expect(err.status).toBe(404);
      expect(err.message).toBe("Not Found");
    }
  });

  test("throws a SoftwareError when the server returns non-JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("oops", {
            status: 503,
            statusText: "Service Unavailable",
          }),
        ),
      ),
    );
    await expect(listWorkflowTemplates()).rejects.toThrow(SoftwareError);
    try {
      await listWorkflowTemplates();
      throw new Error("did not throw");
    } catch (e) {
      const err = e as SoftwareError;
      expect(err.status).toBe(503);
      expect(err.message).toBe("Registry returned non-JSON (is it running?)");
    }
  });

  test("attaches Authorization header when a token is set", async () => {
    localStorage.setItem("kq_token", "abc-123");
    const fetchSpy = vi.fn((_url: RequestInfo | URL, _opts?: RequestInit) =>
      Promise.resolve(jsonResponse({ workflowTemplates: [] }, { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await listWorkflowTemplates();
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ Authorization: "Bearer abc-123" });
    const headers = init?.headers as Record<string, string> | undefined;
    expect(JSON.parse(headers?.["X-Test-Principal"] ?? "{}")).toMatchObject({
      sub: "web-admin",
      role: "platform_admin",
    });
    expect(init?.credentials).toBe("same-origin");
  });
});

describe("software asset writes", () => {
  function jsonResponse(body: unknown, init: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
  }

  test("creates a Spack app template with auth and local principal headers", async () => {
    localStorage.setItem("kq_token", "abc-123");
    localStorage.setItem("kq_email", "admin@example.com");
    localStorage.setItem("kq_role", "platform_admin");
    const fetchSpy = vi.fn((_url: RequestInfo | URL, _opts?: RequestInit) =>
      Promise.resolve(
        jsonResponse(
          {
            id: "sw-1",
            name: "openfoam",
            version: "2312",
            description: null,
            spec: "openfoam@2312%gcc@13.2.0 +mpi",
            specKind: "spack",
            tags: ["spack"],
            createdAt: "2026-06-11T00:00:00.000Z",
          },
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await createAppTemplate({
      name: "openfoam",
      version: "2312",
      specKind: "spack",
      spec: "openfoam@2312%gcc@13.2.0 +mpi",
      tags: ["spack"],
    });

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/software/api/app-templates");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(
      JSON.stringify({
        name: "openfoam",
        version: "2312",
        specKind: "spack",
        spec: "openfoam@2312%gcc@13.2.0 +mpi",
        tags: ["spack"],
      }),
    );
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer abc-123",
      "Content-Type": "application/json",
    });
    const headers = init?.headers as Record<string, string> | undefined;
    expect(JSON.parse(headers?.["X-Test-Principal"] ?? "{}")).toMatchObject({
      sub: "admin@example.com",
      role: "platform_admin",
      orgIds: ["demo-org"],
    });
  });

  test("updates a workflow template through PUT", async () => {
    const fetchSpy = vi.fn((_url: RequestInfo | URL, _opts?: RequestInit) =>
      Promise.resolve(
        jsonResponse(
          {
            id: "wf-1",
            name: "updated",
            version: "1.0.1",
            description: null,
            yamlContent: "name: updated",
            tags: ["hpc"],
            createdAt: "2026-06-11T00:00:00.000Z",
          },
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await updateWorkflowTemplate("wf-1", {
      name: "updated",
      version: "1.0.1",
      yamlContent: "name: updated",
      tags: ["hpc"],
    });

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/software/api/workflow-templates/wf-1");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(
      JSON.stringify({
        name: "updated",
        version: "1.0.1",
        yamlContent: "name: updated",
        tags: ["hpc"],
      }),
    );
  });

  test("lists the local Spack catalog mirror with query parameters", async () => {
    localStorage.setItem("kq_token", "software-token");
    const fetchSpy = vi.fn((_url: RequestInfo | URL, _opts?: RequestInit) =>
      Promise.resolve(
        jsonResponse(
          {
            source:
              "https://github.com/spack/spack-packages/tree/develop/repos/spack_repo/builtin/packages",
            sourceRepository: "spack/spack-packages",
            sourceRef: "develop",
            generatedAt: "2026-06-11",
            packageCount: 8894,
            upstreamCount: 8894,
            customCount: 0,
            totalCount: 1,
            page: 1,
            pageSize: 10,
            totalPages: 1,
            hasNext: false,
            hasPrevious: false,
            packages: [{ name: "openfoam", source: "upstream", tags: [] }],
          },
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const catalog = await listSpackCatalog("openfoam", 10, "vendor", 2);

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "/software/api/spack/catalog?q=openfoam&page=2&pageSize=10&source=vendor",
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer software-token",
    });
    expect(catalog.packages).toEqual([{ name: "openfoam", source: "upstream", tags: [] }]);
  });

  test("preserves Registry OCI-style error messages on catalog reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            { errors: [{ code: "UNAUTHORIZED", message: "vendor catalog requires a principal" }] },
            { status: 401, statusText: "Unauthorized" },
          ),
        ),
      ),
    );

    try {
      await listSpackCatalog("", 24, "vendor");
      throw new Error("did not throw");
    } catch (e) {
      const err = e as SoftwareError;
      expect(err.status).toBe(401);
      expect(err.code).toBe("UNAUTHORIZED");
      expect(err.message).toBe("vendor catalog requires a principal");
    }
  });

  test("writes custom Spack catalog packages through the catalog endpoints", async () => {
    const fetchSpy = vi.fn((_url: RequestInfo | URL, _opts?: RequestInit) =>
      Promise.resolve(
        jsonResponse(
          {
            id: "catalog-official",
            name: "platform-cfd",
            source: "official",
            description: null,
            tags: ["cfd"],
            createdAt: "2026-06-11T00:00:00.000Z",
          },
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await createSpackCatalogPackage({
      name: "platform-cfd",
      source: "official",
      packageFile: "class PlatformCfd(Package): pass",
      tags: ["cfd"],
    });
    await updateSpackCatalogPackage("catalog-official", {
      name: "platform-cfd2",
      source: "official",
      tags: ["cfd"],
    });
    await deleteSpackCatalogPackage("catalog-official");

    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/software/api/spack/catalog/packages");
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        name: "platform-cfd",
        source: "official",
        packageFile: "class PlatformCfd(Package): pass",
        tags: ["cfd"],
      }),
    );
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(
      "/software/api/spack/catalog/packages/catalog-official",
    );
    expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(fetchSpy.mock.calls[2]?.[0]).toBe(
      "/software/api/spack/catalog/packages/catalog-official",
    );
    expect(fetchSpy.mock.calls[2]?.[1]?.method).toBe("DELETE");
  });

  test("parses Spack package files and compilers through parse endpoints", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            name: "openfoam",
            licenses: [],
            maintainers: [],
            versions: ["2312"],
            variants: [],
            dependencies: [],
            provides: [],
            conflicts: [],
          },
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { compilers: [{ spec: "gcc@13.2.0", name: "gcc", version: "13.2.0" }] },
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const pkg = await parseSpackPackageFile("class Openfoam(Package): pass");
    const compilers = await parseSpackCompilers("spec: gcc@13.2.0");

    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/software/api/spack/parse/package");
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ source: "class Openfoam(Package): pass" }),
    );
    expect(pkg.versions).toEqual(["2312"]);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("/software/api/spack/parse/compilers");
    expect(compilers).toEqual([{ spec: "gcc@13.2.0", name: "gcc", version: "13.2.0" }]);
  });
});

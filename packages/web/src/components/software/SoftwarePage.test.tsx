import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkflowTemplate } from "../../lib/software-client";
import { SoftwareSpackCatalogCreatePage, SoftwareUsecaseCreatePage } from "./SoftwareCreatePages";
import {
  collectTemplateTags,
  describeTemplate,
  filterTemplateViews,
  SoftwarePage,
  suggestNextTemplateVersion,
} from "./SoftwarePage";

const softwareClient = vi.hoisted(() => ({
  decideLicenseEntitlementClaim: vi.fn(),
  createAppTemplate: vi.fn(),
  createSpackCatalogPackage: vi.fn(),
  createUsecasePackage: vi.fn(),
  createWorkflowTemplate: vi.fn(),
  deleteAppTemplate: vi.fn(),
  deleteSpackCatalogPackage: vi.fn(),
  deleteUsecasePackage: vi.fn(),
  deleteWorkflowTemplate: vi.fn(),
  listAppTemplates: vi.fn(),
  listLicenseEntitlementClaims: vi.fn(),
  listSpackCatalog: vi.fn(),
  listUsecasePackagePage: vi.fn((...args: unknown[]) =>
    Promise.resolve(softwareClient.listUsecasePackages(...args)).then((result) =>
      Array.isArray(result)
        ? {
            usecasePackages: result,
            tags: [],
            total: result.length,
            page: 1,
            pageSize: 24,
            totalPages: 1,
            hasNext: false,
          }
        : result,
    ),
  ),
  listUsecasePackages: vi.fn(),
  listWorkflowTemplates: vi.fn(),
  listWorkflowTemplatePage: vi.fn((...args: unknown[]) =>
    Promise.resolve(softwareClient.listWorkflowTemplates(...args)).then((result) =>
      Array.isArray(result)
        ? {
            templates: result,
            tags: [...new Set(result.flatMap((template) => template.tags))],
            total: result.length,
            page: 1,
            pageSize: 24,
            totalPages: 1,
            hasNext: false,
          }
        : result,
    ),
  ),
  parseSpackCompilers: vi.fn(),
  parseSpackPackageFile: vi.fn(),
  stashPendingTemplate: vi.fn(),
  submitLicenseEntitlementClaim: vi.fn(),
  updateAppTemplate: vi.fn(),
  updateSpackCatalogPackage: vi.fn(),
  updateUsecasePackage: vi.fn(),
  updateWorkflowTemplate: vi.fn(),
  SoftwareError: class SoftwareError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
      this.name = "SoftwareError";
    }
  },
}));

vi.mock("../../lib/software-client", () => softwareClient);

const apiClient = vi.hoisted(() => ({
  completeDownstreamSoftwareGrants: vi.fn(),
  createSoftwareAccessRequest: vi.fn(),
  forkOfficialSoftwareAsset: vi.fn(),
  listSoftwareAccessRequests: vi.fn(),
  listSoftwareMirrorCacheStatus: vi.fn(),
  listSoftwareReviewQueue: vi.fn(),
  reviewSoftwareAsset: vi.fn(),
  reviewSoftwareAccessRequest: vi.fn(),
  submitSoftwareAsset: vi.fn(),
  updateSoftwareAssetLifecycle: vi.fn(),
}));

vi.mock("../../lib/api-client", () => apiClient);

const sandboxClient = vi.hoisted(() => ({
  listSandboxScripts: vi.fn(),
}));

vi.mock("../../lib/sandbox-client", () => sandboxClient);

vi.mock("../../lib/software-publishing-access", () => ({
  useSoftwarePublishingAccess: () => ({
    canPublish: window.localStorage.getItem("kq_role") !== "user",
    ready: true,
  }),
}));

const router = vi.hoisted(() => ({
  hash: "",
  listeners: new Set<() => void>(),
  navigate: vi.fn(),
  pathname: "/software",
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    hash,
    params,
    to,
    ...props
  }: {
    children?: ReactNode;
    hash?: string;
    params?: Record<string, string>;
    to: string;
    [key: string]: unknown;
  }) => {
    const href = Object.entries(params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      to,
    );
    return (
      <a href={`${href}${hash ? `#${hash}` : ""}`} {...props}>
        {children}
      </a>
    );
  },
  useNavigate: () => router.navigate,
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string; hash: string } }) => unknown;
  }) => {
    const React = require("react") as typeof import("react");
    return React.useSyncExternalStore(
      (listener) => {
        router.listeners.add(listener);
        return () => router.listeners.delete(listener);
      },
      () => select({ location: { pathname: router.pathname, hash: router.hash } }),
    );
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        "common.all": "All",
        "common.error": "Error",
        "common.loading": "Loading",
        "common.refresh": "Refresh",
        "software.title": "Software registry",
        "software.subtitle": "Templates",
        "software.searchPlaceholder": "Search templates",
        "software.usecaseSearchPlaceholder": "Search usecases",
        "software.clearSearch": "Clear search",
        "software.noMatches": "No matches",
        "software.clearFilters": "Clear filters",
        "software.favorite": "Favorite",
        "software.unfavorite": "Remove favorite",
        "software.favoritesOnly": "Favorites only",
        "software.pageResultCount": "Page result count",
        "software.emptyTitle": "No templates",
        "software.empty": "Create a reusable workflow template.",
        "software.emptyAction": "New workflow template",
        "software.usecaseEmptyTitle": "No software usecases",
        "software.usecaseEmptyDescription": "Create a reusable software run definition.",
        "software.usecaseEmptyAction": "New software usecase",
        "software.spackEmptyTitle": "No Spack software",
        "software.spackEmptyDescription": "Add software to the catalog.",
        "software.spackEmptyAction": "New Spack software",
        "software.summary.total": "templates",
        "software.summary.visible": "visible",
        "software.summary.tags": "tags",
        "software.card.noDescription": "No description",
        "software.card.graph": "Graph",
        "software.card.nodes": "nodes",
        "software.card.edges": "edges",
        "software.card.invalidGraph": "Invalid",
        "software.card.validation": "Validation",
        "software.card.validWorkflow": "Valid",
        "software.card.invalidWorkflow": "needs fix",
        "software.card.invalidUseUnavailable": "Invalid templates cannot be used",
        "software.card.use": "Use template",
        "software.card.usecaseRefs": "Usecase refs",
        "software.card.softwareRefs": "Software refs",
        "software.tabs.templates": "Workflow templates",
        "software.tabs.usecases": "Software usecases",
        "software.tabs.spack": "Spack software",
        "software.tabs.scripts": "Data-processing scripts",
        "software.manage.publishTemplate": "Publish workflow template",
        "software.manage.templateName": "Template name",
        "software.manage.version": "Version",
        "software.manage.description": "Description",
        "software.manage.tags": "Tags",
        "software.manage.yamlPlaceholder": "YAML",
        "software.manage.publish": "Publish",
        "software.manage.delete": "Delete",
        "software.manage.edit": "Edit",
        "software.manage.save": "Save",
        "software.manage.cancel": "Cancel",
        "software.manage.create": "Create",
        "software.manage.backToSoftware": "Back",
        "software.manage.createTemplatePage": "New workflow template",
        "software.manage.createTemplatePageDescription": "Create workflow template page",
        "software.manage.createUsecasePage": "New software usecase",
        "software.manage.createUsecasePageDescription": "Create usecase page",
        "software.manage.createCatalogPackagePage": "New Spack package",
        "software.manage.createCatalogPackagePageDescription": "Create catalog package page",
        "software.manage.editTemplate": "Edit workflow template",
        "software.manage.createUsecase": "Create software usecase",
        "software.manage.editUsecase": "Edit software usecase",
        "software.manage.usecaseName": "Usecase name",
        "software.manage.commandFile": "commandFile",
        "software.manage.inputDescriptor": "input descriptor",
        "software.manage.argumentFormat": "argument format",
        "software.manage.noSoftwareOption": "Select a catalog package first",
        "software.manage.createSpack": "Create Spack",
        "software.manage.editSpack": "Edit Spack",
        "software.manage.officialCatalog": "Spack catalog",
        "software.manage.catalogSearch": "Search packages",
        "software.manage.catalogNoMatches": "No catalog matches",
        "software.manage.catalogResults": "Package catalog",
        "software.manage.catalogResultCount": "Package result count",
        "software.manage.catalogPageStatus": "Page status",
        "software.manage.previousPage": "Previous",
        "software.manage.nextPage": "Next",
        "software.manage.packagePickerTitle": "Select package",
        "software.manage.packagePickerDescription": "Pick a package",
        "software.manage.selectedCatalogPackage": "Selected package",
        "software.manage.chooseCatalogPackage": "Choose package",
        "software.manage.changeCatalogPackage": "Change package",
        "software.manage.packageFilePlaceholder": "Paste package.py",
        "software.manage.parsePackageFile": "Parse package.py",
        "software.manage.packageMetadata": "Package metadata",
        "software.manage.versions": "Versions",
        "software.manage.versionCount": "Version count",
        "software.manage.variantCount": "Variant count",
        "software.manage.selectedSpackSpec": "Configured spec",
        "software.manage.configureSpackSpec": "Configure spec",
        "software.manage.specPickerTitle": "Configure spec",
        "software.manage.specPickerDescription": "Configure spec details",
        "software.manage.applySpec": "Apply spec",
        "software.manage.noSpecOptions": "No spec options",
        "software.manage.noSpackSpec": "Select package first",
        "software.manage.compilerParser": "Compiler parser",
        "software.manage.compilerParserPlaceholder": "Paste compilers.yaml",
        "software.manage.parseCompiler": "Parse compilers",
        "software.manage.selected": "Selected",
        "software.manage.choose": "Choose",
        "software.manage.ownerOrg": "Owner org",
        "software.manage.noCatalogTags": "No tags",
        "software.manage.sourceAll": "All sources",
        "software.manage.sourceUpstream": "upstream",
        "software.manage.sourceOfficial": "official",
        "software.manage.sourceVendor": "vendor",
        "software.manage.catalogPackageName": "Custom package",
        "software.manage.catalogPackageSource": "Package source",
        "software.manage.catalogPackageDescription": "Package description",
        "software.manage.catalogPackageTags": "Catalog tags",
        "software.manage.createCatalogPackage": "Add package",
        "software.manage.packageName": "Package",
        "software.manage.softwareVersion": "Software version",
        "software.manage.compiler": "Compiler",
        "software.manage.module": "Module",
        "software.manage.variants": "Variants",
        "software.manage.spackSpec": "Spack spec",
        "software.manage.boundSoftware": "Bound software",
        "software.manage.noTemplates": "No templates",
        "software.manage.noUsecases": "No usecases",
        "software.manage.noSoftware": "No software",
        "software.manage.templateCreated": "Template created",
        "software.manage.templateDeleted": "Template deleted",
        "software.manage.templateUpdated": "Template updated",
        "software.manage.templateVersionCreated": "Template version created",
        "software.manage.templateUnchanged": "Template unchanged",
        "software.manage.editTemplateVersionHint": "Saving creates a new version",
        "software.manage.publishTemplateVersion": "Publish new template version",
        "software.manage.usecaseCreated": "Usecase created",
        "software.manage.usecaseDeleted": "Usecase deleted",
        "software.manage.usecaseUpdated": "Usecase updated",
        "software.manage.softwareCreated": "Software created",
        "software.manage.softwareDeleted": "Software deleted",
        "software.manage.softwareUpdated": "Software updated",
        "software.manage.catalogPackageCreated": "Catalog package created",
        "software.manage.catalogPackageUpdated": "Catalog package updated",
        "software.manage.catalogPackageDeleted": "Catalog package deleted",
        "software.manage.createFailed": "Create failed",
        "software.manage.deleteFailed": "Delete failed",
        "software.manage.updateFailed": "Update failed",
        "software.governance.title": "Software governance",
        "software.governance.subtitle": "Review queue",
        "software.governance.pending": "Pending assets",
        "software.governance.trusted": "Trusted",
        "software.governance.untrusted": "Untrusted",
        "software.governance.approve": "Approve",
        "software.governance.forkOfficial": "Fork official",
        "software.governance.completeGrants": "Complete grants",
        "software.governance.deprecate": "Deprecate",
        "software.governance.reject": "Reject",
        "software.governance.revoke": "Revoke",
        "software.governance.submit": "Submit review",
        "software.governance.submitted": "Submitted",
        "software.governance.reviewed": "Reviewed",
        "software.governance.forked": "Forked",
        "software.governance.lifecycleUpdated": "Lifecycle updated",
        "software.governance.grantsCompleted": "Grants completed",
        "software.governance.actionFailed": "Action failed",
        "software.governance.kind.spack-package": "Spack package",
        "software.governance.kind.usecase": "Usecase",
        "software.governance.kind.workflow-template": "Workflow template",
        "software.governance.source.official-upstream": "Upstream",
        "software.governance.source.platform-fork": "Platform fork",
        "software.governance.source.cp-private": "CP private",
        "software.governance.source.cp-shared": "CP shared",
        "software.governance.source.sp-draft": "SP draft",
        "software.governance.source.sp-published": "SP published",
        "software.governance.lifecycle.draft": "Draft",
        "software.governance.lifecycle.submitted": "Submitted",
        "software.governance.lifecycle.published": "Published",
        "software.governance.visibility.private": "Private",
        "software.governance.visibility.platform-public": "Platform public",
        "software.roles.user": "User requests",
        "software.roles.userDesc": "User request status",
        "software.roles.publisher": "Publisher workspace",
        "software.roles.publisherDesc": "Publisher asset status",
        "software.roles.operator": "Operations queue",
        "software.roles.operatorDesc": "Operations queue status",
        "software.roles.mirror": "Mirror status",
        "software.roles.mirrorDesc": "Mirror/cache status",
        "software.access.requestInstall": "Request install",
        "software.access.requested": "Install request submitted",
        "software.access.reviewed": "Access request reviewed",
        "software.access.status.pending": "Pending",
        "software.access.status.approved": "Approved",
        "software.access.status.rejected": "Rejected",
        "software.access.status.canceled": "Canceled",
      };
      if (key === "software.templateCount") return `${opts?.count} / ${opts?.total}`;
      if (key === "software.card.loaded") return `Loaded ${opts?.name}`;
      if (key === "software.manage.catalogStats") {
        return `${opts?.count} packages from ${opts?.repo}@${opts?.ref} on ${opts?.date}`;
      }
      if (key === "software.manage.versionCount") return `${opts?.count} versions`;
      if (key === "software.manage.variantCount") return `${opts?.count} variants`;
      return labels[key] ?? key;
    },
  }),
}));

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const yamlOneNode = [
  "name: hello",
  "parameters: []",
  "spec:",
  "  nodeDrafts:",
  "    - type: SoftwareUsecaseComputing",
  "      id: a",
  "      name: A",
  '      usecaseVersionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301"',
  '      softwareVersionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7"',
  "      inputSlots:",
  "        - type: Text",
  "          descriptor: script",
  "          from:",
  "            expr: \"'echo hi'\"",
  "  nodeRelations: []",
  "",
].join("\n");

const yamlTwoNodes = [
  "name: pipe",
  "parameters: []",
  "spec:",
  "  nodeDrafts:",
  "    - type: SoftwareUsecaseComputing",
  "      id: a",
  "      name: A",
  '      usecaseVersionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301"',
  '      softwareVersionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7"',
  "      inputSlots:",
  "        - type: Text",
  "          descriptor: script",
  "          from:",
  "            expr: \"'echo a'\"",
  "    - type: NoAction",
  "      id: b",
  "      name: B",
  "  nodeRelations:",
  "    - fromId: a",
  "      toId: b",
  "      slotRelations: []",
  "",
].join("\n");

function template(overrides: Partial<WorkflowTemplate>): WorkflowTemplate {
  return {
    id: "template-id",
    name: "Template",
    version: "0.1.0",
    description: null,
    yamlContent: yamlOneNode,
    tags: [],
    createdAt: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

async function activateTab(testId: string, targetForm: string) {
  const trigger = await screen.findByTestId(testId);
  fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  await screen.findByTestId(targetForm);
}

afterEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/software");
});

beforeEach(() => {
  window.history.replaceState(null, "", "/software");
  router.pathname = "/software";
  router.hash = "";
  router.navigate.mockImplementation(({ hash, to }: { hash?: string; to: string }) => {
    router.pathname = to;
    router.hash = hash ? `#${hash}` : "";
    window.history.pushState(null, "", `${to}${router.hash}`);
    for (const listener of router.listeners) listener();
  });
  window.localStorage.setItem("kq_role", "platform_admin");
  apiClient.listSoftwareReviewQueue.mockResolvedValue([]);
  apiClient.listSoftwareAccessRequests.mockResolvedValue([]);
  apiClient.listSoftwareMirrorCacheStatus.mockResolvedValue([]);
  apiClient.completeDownstreamSoftwareGrants.mockResolvedValue({ granted: [], alreadyGranted: [] });
  apiClient.createSoftwareAccessRequest.mockResolvedValue({});
  apiClient.forkOfficialSoftwareAsset.mockResolvedValue({});
  apiClient.reviewSoftwareAsset.mockResolvedValue({});
  apiClient.reviewSoftwareAccessRequest.mockResolvedValue({});
  apiClient.submitSoftwareAsset.mockResolvedValue({});
  apiClient.updateSoftwareAssetLifecycle.mockResolvedValue({});
  softwareClient.listWorkflowTemplates.mockResolvedValue([]);
  softwareClient.listLicenseEntitlementClaims.mockResolvedValue([]);
  softwareClient.listWorkflowTemplatePage.mockImplementation((...args: unknown[]) =>
    Promise.resolve(softwareClient.listWorkflowTemplates(...args)).then((result) =>
      Array.isArray(result)
        ? {
            templates: result,
            tags: [...new Set(result.flatMap((template) => template.tags))],
            total: result.length,
            page: 1,
            pageSize: 24,
            totalPages: 1,
            hasNext: false,
          }
        : result,
    ),
  );
  sandboxClient.listSandboxScripts.mockResolvedValue([]);
  softwareClient.listAppTemplates.mockResolvedValue([]);
  softwareClient.listSpackCatalog.mockResolvedValue({
    source:
      "https://github.com/spack/spack-packages/tree/develop/repos/spack_repo/builtin/packages",
    sourceRepository: "spack/spack-packages",
    sourceRef: "develop",
    generatedAt: "2026-06-11",
    packageCount: 8896,
    upstreamCount: 8894,
    customCount: 2,
    totalCount: 4,
    page: 1,
    pageSize: 24,
    totalPages: 1,
    hasNext: false,
    hasPrevious: false,
    packages: [
      { name: "gromacs", source: "upstream", tags: [] },
      {
        name: "openfoam",
        source: "upstream",
        tags: [],
        asset: {
          id: "asset-openfoam",
          kind: "spack-package",
          name: "openfoam",
          version: "upstream",
          source: "official-upstream",
          lifecycle: "published",
          visibility: "platform-public",
          trustedForGlobalUse: true,
        },
        metadata: {
          name: "openfoam",
          homepage: "https://openfoam.org",
          licenses: ["GPL-3.0-only"],
          maintainers: [],
          versions: ["2312", "2306"],
          variants: [
            { name: "mpi", default: "True", description: "MPI", values: [] },
            {
              name: "precision",
              default: "double",
              description: "Precision",
              values: ["single", "double"],
            },
          ],
          dependencies: ["mpi"],
          provides: ["cfd-solver"],
          conflicts: [],
        },
      },
      {
        id: "catalog-official-cfd",
        name: "platform-cfd",
        source: "official",
        description: "platform package",
        tags: ["cfd"],
        createdAt: "2026-06-11T00:00:00.000Z",
      },
      {
        id: "catalog-vendor-solver",
        name: "vendor-solver",
        source: "vendor",
        description: null,
        tags: ["solver"],
        ownerOrgId: "demo-org",
        createdAt: "2026-06-11T00:00:00.000Z",
        asset: {
          id: "asset-vendor-solver",
          kind: "spack-package",
          name: "vendor-solver",
          version: "catalog",
          source: "cp-private",
          lifecycle: "draft",
          visibility: "private",
          trustedForGlobalUse: false,
        },
      },
    ],
  });
  softwareClient.listUsecasePackages.mockResolvedValue([]);
  softwareClient.listUsecasePackagePage.mockImplementation((...args: unknown[]) =>
    Promise.resolve(softwareClient.listUsecasePackages(...args)).then((result) =>
      Array.isArray(result)
        ? {
            usecasePackages: result,
            tags: [],
            total: result.length,
            page: 1,
            pageSize: 24,
            totalPages: 1,
            hasNext: false,
          }
        : result,
    ),
  );
  softwareClient.parseSpackCompilers.mockResolvedValue([
    { spec: "gcc@13.2.0", name: "gcc", version: "13.2.0" },
  ]);
  softwareClient.parseSpackPackageFile.mockResolvedValue({
    name: "parsed-openfoam",
    homepage: "https://openfoam.org",
    licenses: ["GPL-3.0-only"],
    maintainers: [],
    versions: ["12"],
    variants: [{ name: "mpi", default: "True", description: "MPI", values: [] }],
    dependencies: ["mpi"],
    provides: ["solver"],
    conflicts: [],
  });
});

test("ordinary users do not request platform governance queues", async () => {
  window.localStorage.setItem("kq_role", "user");

  render(<SoftwarePage />, { wrapper: wrapper() });

  await screen.findByTestId("software-role-flow-panel");
  await waitFor(() => {
    expect(apiClient.listSoftwareAccessRequests).toHaveBeenCalledWith({ mine: true });
  });
  expect(apiClient.listSoftwareAccessRequests).not.toHaveBeenCalledWith({ status: "pending" });
  expect(apiClient.listSoftwareReviewQueue).not.toHaveBeenCalled();
  expect(apiClient.listSoftwareMirrorCacheStatus).not.toHaveBeenCalled();
  expect(screen.queryByText("Operations queue")).toBeNull();
  expect(screen.queryByText("Mirror status")).toBeNull();
  expect(screen.queryByTestId("software-create-template-link")).toBeNull();
  expect(
    within(screen.getByTestId("software-empty")).queryByRole("link", {
      name: "New workflow template",
    }),
  ).toBeNull();

  await activateTab("software-tab-usecases", "software-usecase-empty");
  expect(screen.queryByTestId("software-create-usecase-link")).toBeNull();
  expect(
    within(screen.getByTestId("software-usecase-empty")).queryByRole("link", {
      name: "New software usecase",
    }),
  ).toBeNull();

  await activateTab("software-tab-spack", "software-spack-catalog-list");
  expect(screen.queryByTestId("software-create-spack-package-link")).toBeNull();
  expect(screen.queryByTestId("software-edit-catalog-package-catalog-vendor-solver")).toBeNull();
  expect(screen.queryByTestId("software-delete-catalog-package-catalog-vendor-solver")).toBeNull();
  expect(screen.queryByTestId("software-submit-catalog-package-catalog-vendor-solver")).toBeNull();
  expect(screen.getByTestId("software-request-catalog-package-upstream-openfoam")).toBeDefined();

  await activateTab("software-tab-scripts", "sandbox-script-empty");
  expect(screen.queryByTestId("software-create-script-link")).toBeNull();
  expect(
    within(screen.getByTestId("sandbox-script-empty")).queryByRole("link", {
      name: "sandbox.catalog.create",
    }),
  ).toBeNull();
});

describe("SoftwarePage helpers", () => {
  test("summarizes valid workflow YAML and tags", () => {
    const view = describeTemplate(template({ yamlContent: yamlTwoNodes, tags: ["hpc", "demo"] }));
    expect(view.isValidWorkflow).toBe(true);
    expect(view.nodeCount).toBe(2);
    expect(view.edgeCount).toBe(1);
    expect(view.nodeTypes).toEqual(["NoAction", "SoftwareUsecaseComputing"]);
    expect(collectTemplateTags([view.template, template({ id: "other", tags: ["demo"] })])).toEqual(
      ["demo", "hpc"],
    );
  });

  test("filters by query and tag", () => {
    const views = [
      describeTemplate(template({ id: "hello", name: "Hello", tags: ["demo"] })),
      describeTemplate(template({ id: "pipe", name: "Pipeline", tags: ["hpc"] })),
    ];
    expect(filterTemplateViews(views, "pipe", null).map((view) => view.template.id)).toEqual([
      "pipe",
    ]);
    expect(filterTemplateViews(views, "", "demo").map((view) => view.template.id)).toEqual([
      "hello",
    ]);
  });
});

describe("SoftwarePage", () => {
  test("opens the requested tab from the URL hash", async () => {
    router.hash = "#usecases";
    window.history.replaceState(null, "", "/software#usecases");

    render(<SoftwarePage />, { wrapper: wrapper() });

    await screen.findByTestId("software-usecase-list");
    expect(screen.getByTestId("software-tab-usecases").getAttribute("data-state")).toBe("active");
    expect(screen.getByTestId("software-sticky-controls")).toBeDefined();
  });

  test("follows router hash changes from the workspace sidebar", async () => {
    render(<SoftwarePage />, { wrapper: wrapper() });
    await screen.findByTestId("software-empty");

    act(() => {
      router.hash = "#usecases";
      window.history.pushState(null, "", "/software#usecases");
      for (const listener of router.listeners) listener();
    });

    await screen.findByTestId("software-usecase-list");
    expect(screen.getByTestId("software-tab-usecases").getAttribute("data-state")).toBe("active");
  });

  test("writes the tab hash when switching tabs", async () => {
    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-spack", "software-spack-catalog-summary");

    expect(window.location.hash).toBe("#spack");
    expect(router.navigate).toHaveBeenCalledWith({ to: "/software", hash: "spack" });
    expect(router.navigate).toHaveBeenCalledTimes(1);
  });

  test("switches to the embedded script catalog like the other primary software tabs", async () => {
    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-scripts", "sandbox-script-catalog");

    const scriptsTab = screen.getByTestId("software-tab-scripts");
    expect(scriptsTab.getAttribute("href")).toBeNull();
    expect(scriptsTab.getAttribute("data-state")).toBe("active");
    expect(window.location.hash).toBe("#scripts");
    expect(screen.getByTestId("sandbox-script-catalog").getAttribute("data-embedded")).toBe("true");
    expect(screen.getByTestId("software-create-script-link").getAttribute("href")).toBe(
      "/software/scripts/new",
    );
  });

  test("renders a user-facing template placeholder when the registry is empty", async () => {
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([]);

    render(<SoftwarePage />, { wrapper: wrapper() });

    const empty = await screen.findByTestId("software-empty");
    expect(within(empty).getByText("No templates")).toBeDefined();
    expect(screen.getByTestId("software-empty-placeholders").children).toHaveLength(3);
    expect(
      within(empty).getByRole("link", { name: "New workflow template" }).getAttribute("href"),
    ).toBe("/software/workflow-templates/new");
    expect(empty.textContent).not.toContain("localhost");
    expect(empty.textContent).not.toContain("docker-compose");
  });

  test("keeps toolbar stats inline and role cards compact on medium screens", async () => {
    render(<SoftwarePage />, { wrapper: wrapper() });

    const stats = await screen.findByTestId("software-summary-stats");
    expect(stats.className).toContain("inline-flex");
    expect(stats.children).toHaveLength(3);
    const overview = screen.getByTestId("software-overview");
    expect(overview.className).toContain("grid-cols-2");
    expect(overview.className).toContain("lg:grid-cols-4");
    const roleCards = screen.getByTestId("software-role-flow-panel");
    expect(roleCards.className).toContain("sm:grid-cols-2");
    expect(roleCards.className).toContain("2xl:grid-cols-4");
  });

  test("reuses the catalog placeholder for an empty software usecase tab", async () => {
    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-usecases", "software-usecase-empty");
    const empty = screen.getByTestId("software-usecase-empty");
    expect(within(empty).getByText("No software usecases")).toBeDefined();
    expect(screen.getByTestId("software-usecase-empty-placeholders").children).toHaveLength(3);
    expect(
      within(empty).getByRole("link", { name: "New software usecase" }).getAttribute("href"),
    ).toBe("/software/usecases/new");
  });

  test("reuses the catalog placeholder when the Spack catalog is empty", async () => {
    softwareClient.listSpackCatalog.mockResolvedValueOnce({
      source: "local",
      sourceRepository: "local",
      sourceRef: "main",
      generatedAt: "2026-07-15",
      packageCount: 0,
      upstreamCount: 0,
      customCount: 0,
      totalCount: 0,
      page: 1,
      pageSize: 24,
      totalPages: 1,
      hasNext: false,
      hasPrevious: false,
      packages: [],
    });
    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-spack", "software-spack-empty");
    const empty = screen.getByTestId("software-spack-empty");
    expect(within(empty).getByText("No Spack software")).toBeDefined();
    expect(screen.getByTestId("software-spack-empty-placeholders").children).toHaveLength(3);
    expect(
      within(empty).getByRole("link", { name: "New Spack software" }).getAttribute("href"),
    ).toBe("/software/spack/new");
  });

  test("searches and filters templates through server pagination", async () => {
    const hello = template({ id: "hello", name: "Hello world", tags: ["demo"] });
    const pipe = template({
      id: "pipe",
      name: "Pipeline",
      yamlContent: yamlTwoNodes,
      tags: ["hpc"],
    });
    softwareClient.listWorkflowTemplatePage.mockImplementation((input: unknown) => {
      const params = input as { q?: string; tag?: string; page?: number };
      return Promise.resolve({
        templates:
          params.q === "pipeline" || params.tag === "hpc"
            ? [pipe]
            : params.tag === "demo"
              ? [hello]
              : [hello, pipe],
        tags: ["demo", "hpc"],
        total: params.q === "pipeline" || params.tag ? 1 : 2,
        page: params.page ?? 1,
        pageSize: 24,
        totalPages: 1,
        hasNext: false,
      });
    });

    render(<SoftwarePage />, { wrapper: wrapper() });

    await screen.findByTestId("software-card-hello");
    expect(screen.getByTestId("software-count").textContent).toBe("2 / 2");
    fireEvent.change(screen.getByTestId("software-search"), { target: { value: "pipeline" } });
    await waitFor(() => expect(screen.getByTestId("software-card-pipe")).toBeDefined());
    expect(screen.queryByTestId("software-card-hello")).toBeNull();

    fireEvent.change(screen.getByTestId("software-search"), { target: { value: "" } });
    const tagFilters = await screen.findByTestId("software-tag-filters");
    await waitFor(() => expect(within(tagFilters).getAllByText("demo").length).toBeGreaterThan(0));
    fireEvent.click(within(tagFilters).getByText("demo"));
    await waitFor(() => expect(screen.getByTestId("software-card-hello")).toBeDefined());
    expect(screen.queryByTestId("software-card-pipe")).toBeNull();
    expect(softwareClient.listWorkflowTemplatePage).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 24, tag: "demo" }),
    );
  });

  test("loads the next server page of workflow templates", async () => {
    softwareClient.listWorkflowTemplatePage.mockImplementation((input: unknown) => {
      const params = input as { page?: number };
      return Promise.resolve({
        templates:
          params.page === 2
            ? [template({ id: "template-101", name: "Template 101" })]
            : [template({ id: "template-001", name: "Template 001" })],
        tags: ["bulk"],
        total: 101,
        page: params.page ?? 1,
        pageSize: 24,
        totalPages: 5,
        hasNext: params.page !== 2,
      });
    });

    render(<SoftwarePage />, { wrapper: wrapper() });
    await screen.findByTestId("software-card-template-001");
    const next = screen.getAllByTestId("software-template-next-page")[0];
    if (!next) throw new Error("Template next-page control was not rendered");
    fireEvent.click(next);
    expect(await screen.findByTestId("software-card-template-101")).toBeDefined();
    expect(softwareClient.listWorkflowTemplatePage).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2, pageSize: 24 }),
    );
  });

  test("clears stale catalog rows and write actions when a template refetch fails", async () => {
    softwareClient.listWorkflowTemplates
      .mockResolvedValueOnce([template({ id: "hello", name: "Hello world", tags: ["demo"] })])
      .mockRejectedValueOnce(new Error("template list forbidden"));

    render(<SoftwarePage />, { wrapper: wrapper() });

    expect(await screen.findByTestId("software-card-hello")).toBeDefined();
    fireEvent.click(screen.getByTestId("software-refresh"));

    expect((await screen.findByTestId("software-error")).textContent).toContain(
      "software.unreachable",
    );
    expect(screen.getByTestId("software-error").textContent).not.toContain(
      "template list forbidden",
    );
    expect(screen.getByTestId("software-count").textContent).toBe("0 / 0");
    expect(
      (screen.getByTestId("software-create-template-link") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByTestId("software-card-hello")).toBeNull();
    expect(screen.queryByTestId("software-grid")).toBeNull();
    expect(screen.getByTestId("software-sticky-controls")).toBeDefined();
    expect(softwareClient.deleteWorkflowTemplate).not.toHaveBeenCalled();
  });

  test("renders official Spack catalog mirror metadata", async () => {
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([]);

    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-spack", "software-spack-catalog-summary");
    expect(screen.getByTestId("software-spack-catalog-summary").textContent).toContain(
      "8896 packages from spack/spack-packages@develop",
    );
    expect(screen.getByTestId("software-spack-catalog-list").textContent).toContain("openfoam");
    expect(screen.getByTestId("software-spack-catalog-list").textContent).toContain("upstream");
    expect(screen.getByTestId("software-spack-catalog-list").textContent).toContain("official");
    expect(screen.getByTestId("software-spack-catalog-list").textContent).toContain("vendor");
  });

  test("clears stale Spack catalog rows and write actions when catalog refetch fails", async () => {
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([]);

    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-spack", "software-spack-catalog-summary");
    expect(screen.getByTestId("software-request-catalog-package-upstream-openfoam")).toBeDefined();
    expect(
      screen.getByTestId("software-submit-catalog-package-catalog-vendor-solver"),
    ).toBeDefined();

    softwareClient.listSpackCatalog.mockRejectedValueOnce(new Error("catalog read forbidden"));
    fireEvent.click(screen.getByTestId("software-refresh"));

    expect((await screen.findByTestId("software-error")).textContent).toContain(
      "software.unreachable",
    );
    expect(screen.getByTestId("software-error").textContent).not.toContain(
      "catalog read forbidden",
    );
    expect(screen.queryByTestId("software-spack-catalog-list")).toBeNull();
    expect(screen.queryByTestId("software-request-catalog-package-upstream-openfoam")).toBeNull();
    expect(
      screen.queryByTestId("software-submit-catalog-package-catalog-vendor-solver"),
    ).toBeNull();
    expect(apiClient.createSoftwareAccessRequest).not.toHaveBeenCalled();
    expect(apiClient.submitSoftwareAsset).not.toHaveBeenCalled();
  });

  test("renders asset governance queue, catalog badges, and submit action", async () => {
    apiClient.listSoftwareReviewQueue.mockResolvedValueOnce([
      {
        id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        kind: "workflow-template",
        name: "review-workflow",
        version: "0.1.0",
        source: "sp-published",
        lifecycle: "submitted",
        visibility: "private",
        ownerUserId: null,
        ownerOrgId: null,
        providerOrgId: null,
        supplierUserId: null,
        supplierOrgId: null,
        officialForkOfAssetId: null,
        trustedForGlobalUse: false,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
      },
    ]);
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([]);

    render(<SoftwarePage />, { wrapper: wrapper() });

    expect(
      await screen.findByTestId("software-review-asset-3f2504e0-4f89-41d3-9a0c-0305e82c3301"),
    ).toBeDefined();
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => {
      expect(apiClient.reviewSoftwareAsset).toHaveBeenCalledWith(
        "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        "approved",
        "approved from Software Center review console",
      );
    });

    await activateTab("software-tab-spack", "software-spack-catalog-summary");
    expect(
      screen.getByTestId("software-spack-asset-status-upstream-openfoam").textContent,
    ).toContain("Upstream");
    fireEvent.click(screen.getByTestId("software-request-catalog-package-upstream-openfoam"));
    await waitFor(() => {
      expect(apiClient.createSoftwareAccessRequest).toHaveBeenCalledWith({
        assetRef: { kind: "spack-package", id: "asset-openfoam" },
        capability: "install",
        reason: "requested from Software catalog",
      });
    });
    fireEvent.click(screen.getByTestId("software-submit-catalog-package-catalog-vendor-solver"));
    await waitFor(() => {
      expect(apiClient.submitSoftwareAsset).toHaveBeenCalledWith(
        "asset-vendor-solver",
        "submitted from Software Center",
      );
    });
  });

  test("clears stale governance review actions when the review queue refetch fails", async () => {
    apiClient.listSoftwareReviewQueue
      .mockResolvedValueOnce([
        {
          id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
          kind: "workflow-template",
          name: "review-workflow",
          version: "0.1.0",
          source: "sp-published",
          lifecycle: "submitted",
          visibility: "private",
          ownerUserId: null,
          ownerOrgId: null,
          providerOrgId: null,
          supplierUserId: null,
          supplierOrgId: null,
          officialForkOfAssetId: null,
          trustedForGlobalUse: false,
          createdAt: "2026-06-11T00:00:00.000Z",
          updatedAt: "2026-06-11T00:00:00.000Z",
        },
      ])
      .mockRejectedValueOnce(new Error("review queue forbidden"));
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([]);

    render(<SoftwarePage />, { wrapper: wrapper() });

    expect(
      await screen.findByTestId("software-review-asset-3f2504e0-4f89-41d3-9a0c-0305e82c3301"),
    ).toBeDefined();
    fireEvent.click(screen.getByTestId("software-refresh"));

    expect((await screen.findByTestId("software-review-queue-error")).textContent).toContain(
      "Action failed",
    );
    expect(screen.getByTestId("software-review-queue-error").textContent).not.toContain(
      "review queue forbidden",
    );
    expect(
      screen.queryByTestId("software-review-asset-3f2504e0-4f89-41d3-9a0c-0305e82c3301"),
    ).toBeNull();
    expect(screen.queryByText("Approve")).toBeNull();
    expect(apiClient.reviewSoftwareAsset).not.toHaveBeenCalled();
  });

  test("disables access request actions when access request refetch fails", async () => {
    apiClient.listSoftwareAccessRequests
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("access request list forbidden"))
      .mockResolvedValueOnce([]);
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([]);

    render(<SoftwarePage />, { wrapper: wrapper() });

    expect(await screen.findByTestId("software-request-first-access")).toBeDefined();
    fireEvent.click(screen.getByTestId("software-refresh"));

    expect((await screen.findByTestId("software-access-requests-error")).textContent).toContain(
      "Action failed",
    );
    expect(screen.getByTestId("software-access-requests-error").textContent).not.toContain(
      "access request list forbidden",
    );
    expect(
      (screen.getByTestId("software-request-first-access") as HTMLButtonElement).disabled,
    ).toBe(true);

    await activateTab("software-tab-spack", "software-spack-catalog-summary");
    const catalogRequest = await screen.findByTestId(
      "software-request-catalog-package-upstream-openfoam",
    );
    expect((catalogRequest as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(catalogRequest);

    expect(apiClient.createSoftwareAccessRequest).not.toHaveBeenCalled();
  });

  test("creates and edits custom catalog packages", async () => {
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([]);
    softwareClient.createSpackCatalogPackage.mockResolvedValueOnce({});
    softwareClient.updateSpackCatalogPackage.mockResolvedValueOnce({});
    softwareClient.deleteSpackCatalogPackage.mockResolvedValueOnce({});

    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-spack", "software-spack-catalog-summary");
    expect(screen.getByTestId("software-create-spack-package-link")).toBeDefined();
  });

  test("creates custom catalog packages from the dedicated page", async () => {
    softwareClient.createSpackCatalogPackage.mockResolvedValueOnce({});

    render(<SoftwareSpackCatalogCreatePage />, { wrapper: wrapper() });

    fireEvent.change(screen.getByTestId("software-spack-package-file"), {
      target: { value: "class ParsedOpenfoam(Package):" },
    });
    fireEvent.click(screen.getByTestId("software-spack-parse-package-file"));

    await waitFor(() => {
      expect(softwareClient.parseSpackPackageFile).toHaveBeenCalledWith(
        "class ParsedOpenfoam(Package):",
      );
    });
    expect(await screen.findByTestId("software-spack-package-metadata")).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText("Custom package"), {
      target: { value: "lab-openfoam" },
    });
    fireEvent.change(screen.getByLabelText("Package source"), { target: { value: "vendor" } });
    fireEvent.change(screen.getByPlaceholderText("Catalog tags"), { target: { value: "cfd,lab" } });
    fireEvent.submit(screen.getByTestId("software-spack-catalog-create-form"));

    await waitFor(() => {
      expect(softwareClient.createSpackCatalogPackage).toHaveBeenCalled();
    });
    expect(softwareClient.createSpackCatalogPackage.mock.calls[0]?.[0]).toEqual({
      name: "lab-openfoam",
      source: "vendor",
      description: "https://openfoam.org",
      tags: ["cfd", "lab"],
      packageFile: "class ParsedOpenfoam(Package):",
    });
  });

  test("edits and confirms deletion of catalog packages from the catalog list", async () => {
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([]);
    softwareClient.updateSpackCatalogPackage.mockResolvedValueOnce({});
    softwareClient.deleteSpackCatalogPackage.mockResolvedValueOnce({});

    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-spack", "software-spack-catalog-summary");

    fireEvent.click(screen.getByTestId("software-edit-catalog-package-catalog-official-cfd"));
    const editForm = await screen.findByTestId(
      "software-spack-catalog-package-edit-form-catalog-official-cfd",
    );
    fireEvent.change(within(editForm).getByPlaceholderText("Custom package"), {
      target: { value: "platform-cfd-updated" },
    });
    fireEvent.submit(editForm);

    await waitFor(() => {
      expect(softwareClient.updateSpackCatalogPackage).toHaveBeenCalled();
    });
    expect(softwareClient.updateSpackCatalogPackage.mock.calls[0]).toEqual([
      "catalog-official-cfd",
      expect.objectContaining({ name: "platform-cfd-updated", source: "official" }),
      undefined,
    ]);

    fireEvent.click(screen.getByTestId("software-delete-catalog-package-catalog-vendor-solver"));
    expect(await screen.findByTestId("software-delete-catalog-package-dialog")).toBeDefined();
    expect(softwareClient.deleteSpackCatalogPackage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("software-delete-catalog-package-confirm"));
    await waitFor(() => {
      expect(softwareClient.deleteSpackCatalogPackage).toHaveBeenCalled();
    });
    expect(softwareClient.deleteSpackCatalogPackage.mock.calls[0]?.[0]).toBe(
      "catalog-vendor-solver",
    );
  });

  test("only exposes vendor catalog management for the active owner organization", async () => {
    window.localStorage.setItem("kq_role", "org_admin");
    window.localStorage.setItem("kq_active_organization_id", "demo-org");

    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-spack", "software-spack-catalog-summary");
    expect(screen.getByTestId("software-edit-catalog-package-catalog-vendor-solver")).toBeDefined();
    expect(
      screen.getByTestId("software-delete-catalog-package-catalog-vendor-solver"),
    ).toBeDefined();
    expect(screen.queryByTestId("software-edit-catalog-package-catalog-official-cfd")).toBeNull();
    expect(screen.queryByTestId("software-delete-catalog-package-catalog-official-cfd")).toBeNull();

    window.localStorage.setItem("kq_active_organization_id", "other-org");
    window.dispatchEvent(new Event("kq:active-organization-change"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("software-edit-catalog-package-catalog-vendor-solver"),
      ).toBeNull();
    });
    expect(
      screen.queryByTestId("software-delete-catalog-package-catalog-vendor-solver"),
    ).toBeNull();
  });

  test("renders catalog packages on the right instead of Spack software variants", async () => {
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([]);
    softwareClient.listAppTemplates.mockResolvedValueOnce([
      {
        id: "sw-openfoam",
        name: "openfoam",
        version: "2312",
        description: null,
        spec: "openfoam@2312",
        specKind: "spack",
        tags: ["spack"],
        createdAt: "2026-06-11T00:00:00.000Z",
      },
    ]);

    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-spack", "software-spack-catalog-summary");
    expect(screen.getByTestId("software-spack-list").textContent).toContain("Package catalog");
    expect(screen.getByTestId("software-spack-catalog-list").textContent).toContain("openfoam");
    expect(screen.getByTestId("software-spack-catalog-list").textContent).toContain("platform-cfd");
    expect(screen.queryByTestId("software-spack-card-sw-openfoam")).toBeNull();
  });

  test("pages through Spack catalog packages without loading every row at once", async () => {
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([]);
    softwareClient.listSpackCatalog
      .mockResolvedValueOnce({
        source: "spack",
        sourceRepository: "spack/spack-packages",
        sourceRef: "develop",
        generatedAt: "2026-06-11",
        packageCount: 8894,
        upstreamCount: 8894,
        customCount: 0,
        totalCount: 2,
        page: 1,
        pageSize: 24,
        totalPages: 2,
        hasNext: true,
        hasPrevious: false,
        packages: [{ name: "alpha", source: "upstream", tags: [] }],
      })
      .mockResolvedValueOnce({
        source: "spack",
        sourceRepository: "spack/spack-packages",
        sourceRef: "develop",
        generatedAt: "2026-06-11",
        packageCount: 8894,
        upstreamCount: 8894,
        customCount: 0,
        totalCount: 2,
        page: 2,
        pageSize: 24,
        totalPages: 2,
        hasNext: false,
        hasPrevious: true,
        packages: [{ name: "beta", source: "upstream", tags: [] }],
      });

    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-spack", "software-spack-catalog-summary");
    expect(
      await screen.findByTestId("software-spack-catalog-package-upstream-alpha"),
    ).toBeDefined();
    expect(
      screen.getByTestId("software-spack-card-surface-upstream-alpha").getAttribute("href"),
    ).toBe("/software/spack/upstream/alpha");
    router.navigate.mockClear();
    fireEvent.click(screen.getByTestId("software-spack-catalog-next"));
    expect(router.navigate).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(softwareClient.listSpackCatalog).toHaveBeenCalledWith("", 24, "all", 2);
    });
    expect(await screen.findByTestId("software-spack-catalog-package-upstream-beta")).toBeDefined();
  });

  test("publishes a new workflow template version from the card editor", async () => {
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([
      template({ id: "hello", name: "Hello world", tags: ["demo"] }),
    ]);
    softwareClient.updateWorkflowTemplate.mockResolvedValueOnce({ id: "hello" });

    render(<SoftwarePage />, { wrapper: wrapper() });

    await screen.findByTestId("software-card-hello");
    expect(screen.getByTestId("software-card-surface-hello").getAttribute("href")).toBe(
      "/software/workflow-templates/hello",
    );
    router.navigate.mockClear();
    fireEvent.click(screen.getByTestId("software-edit-template-hello"));
    expect(router.navigate).not.toHaveBeenCalled();
    const form = await screen.findByTestId("software-template-edit-form-hello");
    expect(screen.getByText("Saving creates a new version")).toBeDefined();
    expect((within(form).getByPlaceholderText("Version") as HTMLInputElement).value).toBe("0.1.1");
    fireEvent.change(within(form).getByPlaceholderText("Template name"), {
      target: { value: "Hello updated" },
    });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(softwareClient.updateWorkflowTemplate).toHaveBeenCalled();
    });
    expect(softwareClient.updateWorkflowTemplate.mock.calls[0]).toEqual([
      "hello",
      expect.objectContaining({ name: "Hello updated", tags: ["demo"], version: "0.1.1" }),
    ]);
    await waitFor(() => {
      expect(screen.queryByTestId("software-template-edit-sheet")).toBeNull();
    });
    expect(screen.queryByTestId("software-delete-template-hello")).toBeNull();
  });

  test("keeps invalid published templates viewable but prevents using them", async () => {
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([
      template({ id: "invalid", yamlContent: "name: [" }),
    ]);

    render(<SoftwarePage />, { wrapper: wrapper() });

    await screen.findByTestId("software-card-invalid");
    const useButton = screen.getByTestId("software-use-invalid") as HTMLButtonElement;
    expect(useButton.disabled).toBe(true);
    expect(useButton.title).toBe("Invalid templates cannot be used");
    expect(screen.getByTestId("software-view-invalid")).toBeDefined();
    fireEvent.click(useButton);
    expect(softwareClient.stashPendingTemplate).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  test("treats templates with a validation bypass as unusable", async () => {
    const bypassed = `${yamlTwoNodes.replace("      id: b", "      id: a")}
advanced:
  skipStaticValidation: true`;
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([
      template({ id: "bypassed", yamlContent: bypassed }),
    ]);

    render(<SoftwarePage />, { wrapper: wrapper() });

    await screen.findByTestId("software-card-bypassed");
    expect((screen.getByTestId("software-use-bypassed") as HTMLButtonElement).disabled).toBe(true);
  });

  test("suggests the next patch only for unambiguous semantic versions", () => {
    expect(suggestNextTemplateVersion("1.2.3")).toBe("1.2.4");
    expect(suggestNextTemplateVersion("01.2.3")).toBe("");
    expect(suggestNextTemplateVersion("draft")).toBe("");
    expect(suggestNextTemplateVersion("1.2.3-rc.1")).toBe("");
  });

  test("hides platform workflow publication actions from organization administrators", async () => {
    window.localStorage.setItem("kq_role", "org_admin");
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([
      template({ id: "platform-template", name: "Platform template" }),
    ]);

    render(<SoftwarePage />, { wrapper: wrapper() });

    await screen.findByTestId("software-card-platform-template");
    expect(screen.queryByTestId("software-create-template-link")).toBeNull();
    expect(screen.queryByTestId("software-edit-template-platform-template")).toBeNull();
  });

  test("keeps the workflow template editor and draft when publishing fails", async () => {
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([
      template({ id: "hello", name: "Hello world", tags: ["demo"] }),
    ]);
    softwareClient.updateWorkflowTemplate.mockRejectedValueOnce(new Error("version conflict"));

    render(<SoftwarePage />, { wrapper: wrapper() });

    await screen.findByTestId("software-card-hello");
    fireEvent.click(screen.getByTestId("software-edit-template-hello"));
    const form = await screen.findByTestId("software-template-edit-form-hello");
    const nameInput = within(form).getByPlaceholderText("Template name");
    fireEvent.change(nameInput, { target: { value: "Unsaved replacement" } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(softwareClient.updateWorkflowTemplate).toHaveBeenCalled();
    });
    expect(await screen.findByTestId("software-template-edit-sheet")).toBeDefined();
    expect((nameInput as HTMLInputElement).value).toBe("Unsaved replacement");
  });

  test("creates a usecase package from a selected Spack catalog package and configured spec", async () => {
    softwareClient.createUsecasePackage.mockResolvedValueOnce({});

    render(<SoftwareUsecaseCreatePage />, { wrapper: wrapper() });

    await screen.findByTestId("software-usecase-form");
    fireEvent.click(screen.getByTestId("software-usecase-open-package-picker"));
    const picker = await screen.findByTestId("software-usecase-package-picker");
    expect(picker.getAttribute("role")).toBe("dialog");
    expect(picker.className).toContain("h-[min(88vh,900px)]");
    expect(picker.className).toContain("overflow-hidden");
    expect((await screen.findByTestId("software-usecase-catalog-grid")).className).toContain(
      "overflow-auto",
    );
    fireEvent.change(await screen.findByTestId("software-usecase-catalog-search"), {
      target: { value: "openfoam" },
    });
    await waitFor(() => {
      expect(softwareClient.listSpackCatalog).toHaveBeenCalledWith("openfoam", 24, "all", 1);
    });
    fireEvent.click(
      await screen.findByTestId("software-usecase-catalog-package-upstream-openfoam"),
    );
    fireEvent.change(screen.getByPlaceholderText("Usecase name"), { target: { value: "solve" } });
    fireEvent.change(screen.getByPlaceholderText("commandFile"), {
      target: { value: "simpleFoam" },
    });
    fireEvent.click(screen.getByTestId("software-usecase-open-spec-picker"));
    fireEvent.click(await screen.findByText("2312"));
    fireEvent.click(screen.getByText("+mpi"));
    fireEvent.click(screen.getByText("precision=double"));
    fireEvent.change(screen.getByTestId("software-usecase-compiler-source"), {
      target: { value: "spec: gcc@13.2.0" },
    });
    fireEvent.click(screen.getByText("Parse compilers"));
    await waitFor(() => {
      expect(softwareClient.parseSpackCompilers).toHaveBeenCalledWith("spec: gcc@13.2.0");
    });
    fireEvent.click(await screen.findByText("gcc@13.2.0"));
    fireEvent.change(screen.getByTestId("software-usecase-spec-module"), {
      target: { value: "openfoam/2312" },
    });
    fireEvent.click(screen.getByText("Apply spec"));
    fireEvent.change(screen.getByPlaceholderText("input descriptor"), {
      target: { value: "caseDir" },
    });
    fireEvent.change(screen.getByPlaceholderText("argument format"), {
      target: { value: "--case {}" },
    });
    fireEvent.submit(screen.getByTestId("software-usecase-form"));

    await waitFor(() => {
      expect(softwareClient.createUsecasePackage).toHaveBeenCalled();
    });
    expect(softwareClient.createUsecasePackage.mock.calls[0]?.[0]).toMatchObject({
      name: "solve",
      version: "0.1.0",
      spec: {
        usecase: {
          commandFile: "simpleFoam",
          inputSlots: [
            {
              kind: "Text",
              descriptor: "caseDir",
              refMaterials: [{ kind: "ArgRef", descriptor: "caseDir", sort: 0 }],
            },
          ],
        },
        software: {
          kind: "Spack",
          name: "openfoam@2312%gcc@13.2.0",
          version: "2312",
          compiler: "gcc@13.2.0",
          moduleName: "openfoam/2312",
          variantRef: "catalog:upstream:openfoam",
          argumentList: ["+mpi", "precision=double"],
        },
        arguments: [{ descriptor: "caseDir", valueFormat: "--case {}" }],
      },
    });
  });

  test("blocks usecase creation when the Spack catalog fails to load", async () => {
    softwareClient.listSpackCatalog.mockRejectedValueOnce(new Error("catalog unavailable"));

    render(<SoftwareUsecaseCreatePage />, { wrapper: wrapper() });

    const form = await screen.findByTestId("software-usecase-form");
    expect((await screen.findByTestId("software-usecase-catalog-error")).textContent).toContain(
      "software.unreachable",
    );
    expect(screen.getByTestId("software-usecase-catalog-error").textContent).not.toContain(
      "catalog unavailable",
    );
    const pickerButton = screen.getByTestId(
      "software-usecase-open-package-picker",
    ) as HTMLButtonElement;
    expect(pickerButton.disabled).toBe(true);

    fireEvent.click(pickerButton);
    expect(screen.queryByTestId("software-usecase-package-picker")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Usecase name"), { target: { value: "solve" } });
    fireEvent.change(screen.getByPlaceholderText("commandFile"), {
      target: { value: "simpleFoam" },
    });
    fireEvent.submit(form);

    expect(softwareClient.createUsecasePackage).not.toHaveBeenCalled();
  });

  test("pages the usecase package picker as a modal catalog instead of loading every package", async () => {
    softwareClient.listSpackCatalog
      .mockResolvedValueOnce({
        source: "spack",
        sourceRepository: "spack/spack-packages",
        sourceRef: "develop",
        generatedAt: "2026-06-11",
        packageCount: 8894,
        upstreamCount: 8894,
        customCount: 0,
        totalCount: 2,
        page: 1,
        pageSize: 24,
        totalPages: 2,
        hasNext: true,
        hasPrevious: false,
        packages: [{ name: "alpha", source: "upstream", tags: [] }],
      })
      .mockResolvedValueOnce({
        source: "spack",
        sourceRepository: "spack/spack-packages",
        sourceRef: "develop",
        generatedAt: "2026-06-11",
        packageCount: 8894,
        upstreamCount: 8894,
        customCount: 0,
        totalCount: 2,
        page: 2,
        pageSize: 24,
        totalPages: 2,
        hasNext: false,
        hasPrevious: true,
        packages: [{ name: "beta", source: "upstream", tags: [] }],
      });

    render(<SoftwareUsecaseCreatePage />, { wrapper: wrapper() });

    await screen.findByTestId("software-usecase-form");
    fireEvent.click(screen.getByTestId("software-usecase-open-package-picker"));
    expect(
      await screen.findByTestId("software-usecase-catalog-package-upstream-alpha"),
    ).toBeDefined();
    fireEvent.click(screen.getByTestId("software-usecase-catalog-next"));

    await waitFor(() => {
      expect(softwareClient.listSpackCatalog).toHaveBeenCalledWith("", 24, "all", 2);
    });
    expect(
      await screen.findByTestId("software-usecase-catalog-package-upstream-beta"),
    ).toBeDefined();
  });

  test("searches usecase cards through the server-side directory query", async () => {
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([]);
    softwareClient.listUsecasePackages.mockResolvedValue([
      {
        id: "uc-solve",
        name: "solve",
        version: "0.1.0",
        description: null,
        createdAt: "2026-06-11T00:00:00.000Z",
        spec: {
          usecase: { commandFile: "simpleFoam", inputSlots: [] },
          software: {
            kind: "Spack",
            name: "openfoam@2312%gcc@13.2.0",
            version: "2312",
            compiler: "gcc@13.2.0",
            moduleName: "openfoam/2312",
            variantRef: "catalog:upstream:openfoam",
            argumentList: ["+mpi"],
          },
          arguments: [],
          environments: [],
          filesomeInputs: [],
          filesomeOutputs: [],
          valueOutputs: [],
        },
      },
      {
        id: "uc-mesh",
        name: "mesh",
        version: "0.1.0",
        description: null,
        createdAt: "2026-06-11T00:00:00.000Z",
        spec: {
          usecase: { commandFile: "blockMesh", inputSlots: [] },
          software: {
            kind: "Spack",
            name: "openfoam@2312%gcc@13.2.0",
            version: "2312",
            compiler: "gcc@13.2.0",
            moduleName: "openfoam/2312",
            variantRef: "catalog:upstream:openfoam",
            argumentList: [],
          },
          arguments: [],
          environments: [],
          filesomeInputs: [],
          filesomeOutputs: [],
          valueOutputs: [],
        },
      },
    ]);

    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-usecases", "software-usecase-list");
    fireEvent.change(screen.getByTestId("software-usecase-search"), {
      target: { value: "simpleFoam" },
    });
    await waitFor(() => {
      expect(softwareClient.listUsecasePackagePage).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: "simpleFoam" }),
      );
    });
    expect(
      (await screen.findByTestId("software-usecase-card-surface-uc-solve")).getAttribute("href"),
    ).toBe("/software/usecases/uc-solve");
  });

  test("updates a usecase package and keeps the Spack variant binding", async () => {
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([]);
    softwareClient.listUsecasePackages.mockResolvedValueOnce([
      {
        id: "uc-solve",
        name: "solve",
        version: "0.1.0",
        description: null,
        createdAt: "2026-06-11T00:00:00.000Z",
        spec: {
          usecase: { commandFile: "simpleFoam", inputSlots: [] },
          software: {
            kind: "Spack",
            name: "openfoam@2312%gcc@13.2.0",
            version: "2312",
            compiler: "gcc@13.2.0",
            moduleName: "openfoam/2312",
            variantRef: "catalog:upstream:openfoam",
            argumentList: ["+mpi"],
          },
          arguments: [],
          environments: [],
          filesomeInputs: [],
          filesomeOutputs: [],
          valueOutputs: [],
        },
      },
    ]);
    softwareClient.updateUsecasePackage.mockResolvedValueOnce({});

    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-usecases", "software-usecase-list");
    fireEvent.click(screen.getByText("Edit"));
    const form = await screen.findByTestId("software-usecase-edit-form-uc-solve");
    fireEvent.change(within(form).getByPlaceholderText("commandFile"), {
      target: { value: "blockMesh" },
    });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(softwareClient.updateUsecasePackage).toHaveBeenCalled();
    });
    expect(softwareClient.updateUsecasePackage.mock.calls[0]).toEqual([
      "uc-solve",
      expect.objectContaining({
        name: "solve",
        spec: expect.objectContaining({
          usecase: expect.objectContaining({ commandFile: "blockMesh" }),
          software: expect.objectContaining({ variantRef: "catalog:upstream:openfoam" }),
        }),
      }),
    ]);
  });

  test("keeps an open usecase editor when the catalog refetch fails", async () => {
    softwareClient.listWorkflowTemplates.mockResolvedValueOnce([]);
    softwareClient.listUsecasePackages.mockResolvedValueOnce([
      {
        id: "uc-solve",
        name: "solve",
        version: "0.1.0",
        description: null,
        tags: [],
        createdAt: "2026-06-11T00:00:00.000Z",
        spec: {
          usecase: { commandFile: "simpleFoam", inputSlots: [] },
          software: {
            kind: "Spack",
            name: "openfoam@2312%gcc@13.2.0",
            version: "2312",
            compiler: "gcc@13.2.0",
            moduleName: "openfoam/2312",
            variantRef: "catalog:upstream:openfoam",
            argumentList: ["+mpi"],
          },
          arguments: [],
          environments: [],
          filesomeInputs: [],
          filesomeOutputs: [],
          valueOutputs: [],
        },
      },
    ]);
    render(<SoftwarePage />, { wrapper: wrapper() });

    await activateTab("software-tab-usecases", "software-usecase-list");
    fireEvent.click(screen.getByText("Edit"));
    expect(await screen.findByTestId("software-usecase-edit-form-uc-solve")).toBeDefined();
    softwareClient.listSpackCatalog.mockRejectedValueOnce(new Error("catalog refetch forbidden"));

    fireEvent.click(screen.getByTestId("software-refresh"));

    expect(await screen.findByTestId("software-usecase-edit-form-uc-solve")).toBeDefined();
    expect(screen.queryByTestId("software-error")).toBeNull();
    expect(softwareClient.updateUsecasePackage).not.toHaveBeenCalled();
  });
});

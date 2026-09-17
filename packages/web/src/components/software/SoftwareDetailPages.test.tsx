import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  SoftwareSpackDetailPage,
  SoftwareUsecaseDetailPage,
  SoftwareWorkflowTemplateDetailPage,
} from "./SoftwareDetailPages";

const softwareClient = vi.hoisted(() => ({
  getWorkflowTemplate: vi.fn(),
  getUsecasePackage: vi.fn(),
  listSpackCatalog: vi.fn(),
  listUsecasePackages: vi.fn(),
  listWorkflowTemplates: vi.fn(),
}));

vi.mock("../../lib/software-client", () => softwareClient);

const apiClient = vi.hoisted(() => ({
  resolveSoftwareAvailability: vi.fn(),
}));

vi.mock("../../lib/api-client", () => apiClient);

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    hash,
    params,
    to,
    ...props
  }: {
    children: ReactNode;
    hash?: string;
    params?: Record<string, string>;
    to: string;
    [key: string]: unknown;
  }) => (
    <a
      href={`${Object.entries(params ?? {}).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to,
      )}${hash ? `#${hash}` : ""}`}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  ReactFlow: ({
    children,
    nodes,
  }: {
    children?: ReactNode;
    nodes?: Array<{ data?: { label?: string } }>;
  }) => (
    <div data-testid="mock-react-flow">
      {nodes?.map((node) => (
        <span key={node.data?.label}>{node.data?.label}</span>
      ))}
      {children}
    </div>
  ),
}));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        "common.error": "Error",
        "common.loading": "Loading",
        "software.detail.basicInfo": "Basic information",
        "software.detail.createdAt": "Created at",
        "software.detail.dependencies": "Dependencies",
        "software.detail.environments": "Environment variables",
        "software.detail.fileInputs": "File inputs",
        "software.detail.fileOutputs": "File outputs",
        "software.detail.files": "Files",
        "software.detail.inputSlots": "Input slots",
        "software.detail.inputsOutputs": "Inputs and outputs",
        "software.detail.metadata": "Metadata",
        "software.detail.moduleCapabilities": "Module capabilities",
        "software.detail.none": "None",
        "software.detail.arguments": "Arguments",
        "software.detail.copySpec": "Copy spec",
        "software.detail.edges": "Edges",
        "software.detail.homepage": "Open homepage",
        "software.detail.installSpec": "Install spec",
        "software.detail.invalid": "Invalid",
        "software.detail.invalidWorkflow": "Invalid workflow",
        "software.detail.nodes": "Nodes",
        "software.detail.nodeTypes": "Node types",
        "software.detail.openBoundPackage": "Open bound package",
        "software.detail.packageIdentity": "Package identity",
        "software.detail.renderedGraph": "Rendered graph",
        "software.detail.runtime": "Runtime",
        "software.detail.valid": "Valid",
        "software.detail.validation": "Validation",
        "software.detail.validWorkflow": "Valid workflow",
        "software.detail.versions": "Versions",
        "software.detail.yamlSource": "YAML source",
        "software.manage.backToSoftware": "Back",
        "software.manage.boundSoftware": "Bound software",
        "software.manage.catalogPackageSource": "Source",
        "software.manage.commandFile": "commandFile",
        "software.manage.compiler": "Compiler",
        "software.manage.module": "Module",
        "software.manage.ownerOrg": "Owner org",
        "software.manage.packageName": "Package name",
        "software.manage.softwareVersion": "Software version",
        "software.manage.tags": "Tags",
        "software.manage.variantRef": "Variant ref",
        "software.manage.variants": "Variants",
        "software.manage.version": "Version",
      };
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

const yaml = [
  "name: hello",
  "parameters: []",
  "spec:",
  "  nodeDrafts:",
  "    - type: SoftwareUsecaseComputing",
  "      id: a",
  "      name: Mesh",
  '      usecaseVersionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301"',
  '      softwareVersionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7"',
  "      inputSlots:",
  "        - type: Text",
  "          descriptor: script",
  "          from:",
  "            expr: \"'echo hi'\"",
  "    - type: NoAction",
  "      id: b",
  "      name: Done",
  "  nodeRelations:",
  "    - fromId: a",
  "      toId: b",
  "      slotRelations: []",
  "",
].join("\n");

afterEach(() => {
  vi.resetAllMocks();
});

beforeEach(() => {
  apiClient.resolveSoftwareAvailability.mockResolvedValue({
    blocked: [],
    installableAvailable: [],
    installedAvailable: [],
  });
  softwareClient.getWorkflowTemplate.mockResolvedValue({
    id: "tpl-1",
    name: "Docker hello",
    version: "0.1.0",
    description: "workflow template",
    yamlContent: yaml,
    tags: ["demo"],
    createdAt: "2026-06-11T00:00:00.000Z",
  });
  softwareClient.getUsecasePackage.mockResolvedValue({
    id: "uc-1",
    name: "OpenFOAM solve",
    version: "0.1.0",
    description: null,
    createdAt: "2026-06-11T00:00:00.000Z",
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
        argumentList: ["+mpi"],
      },
      arguments: [{ descriptor: "caseDir", valueFormat: "--case {}" }],
      environments: [{ descriptor: "omp", key: "OMP_NUM_THREADS", valueFormat: "8" }],
      filesomeInputs: [],
      filesomeOutputs: [{ descriptor: "log", fileKind: { kind: "Normal", name: "log.txt" } }],
      valueOutputs: [],
    },
  });
  softwareClient.listSpackCatalog.mockResolvedValue({
    source: "spack",
    sourceRepository: "spack/spack-packages",
    sourceRef: "develop",
    generatedAt: "2026-06-11",
    packageCount: 1,
    upstreamCount: 1,
    customCount: 0,
    totalCount: 1,
    page: 1,
    pageSize: 100,
    totalPages: 1,
    hasNext: false,
    hasPrevious: false,
    packages: [
      {
        name: "openfoam",
        source: "upstream",
        tags: ["cfd"],
        metadata: {
          name: "openfoam",
          homepage: "https://openfoam.org",
          licenses: ["GPL-3.0-only"],
          maintainers: ["spack"],
          versions: ["2312"],
          variants: [{ name: "mpi", default: "True", description: "MPI", values: [] }],
          dependencies: ["mpi", "elpa+openmp"],
          provides: ["cfd-solver"],
          conflicts: ["platform=darwin"],
        },
      },
    ],
  });
});

describe("Software detail pages", () => {
  test("renders workflow metadata and a read-only graph", async () => {
    render(<SoftwareWorkflowTemplateDetailPage templateId="tpl-1" />, { wrapper: wrapper() });

    expect(await screen.findByText("Docker hello")).toBeDefined();
    expect(screen.getByTestId("mock-react-flow").textContent).toContain("Mesh");
    expect(screen.getByText("demo")).toBeDefined();
    expect(screen.getByText("Valid workflow")).toBeDefined();
    expect(screen.getByText("Nodes")).toBeDefined();
    expect(screen.getByText("Edges")).toBeDefined();
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe(
      "/software#workflow-templates",
    );
  });

  test("renders workflow template query errors instead of not found", async () => {
    softwareClient.getWorkflowTemplate.mockRejectedValueOnce(new Error("templates forbidden"));

    render(<SoftwareWorkflowTemplateDetailPage templateId="tpl-1" />, { wrapper: wrapper() });

    expect((await screen.findByTestId("software-detail-error")).textContent).toContain(
      "software.unreachable",
    );
    expect(screen.getByTestId("software-detail-error").textContent).not.toContain(
      "templates forbidden",
    );
    expect(screen.queryByText("software.detail.notFound")).toBeNull();
  });

  test("renders usecase slots and Spack runtime", async () => {
    render(<SoftwareUsecaseDetailPage usecaseId="uc-1" />, { wrapper: wrapper() });

    expect(await screen.findByText("OpenFOAM solve")).toBeDefined();
    expect(screen.getByText("simpleFoam")).toBeDefined();
    expect(screen.getByText("gcc@13.2.0")).toBeDefined();
    expect(screen.getByText("openfoam/2312")).toBeDefined();
    expect(screen.getAllByText("caseDir").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /Open bound package/i }).getAttribute("href")).toBe(
      "/software/spack/upstream/openfoam",
    );
    expect(screen.getAllByText("Arguments").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe(
      "/software#usecases",
    );
  });

  test("renders usecase query errors instead of not found", async () => {
    softwareClient.getUsecasePackage.mockRejectedValueOnce(new Error("usecases forbidden"));

    render(<SoftwareUsecaseDetailPage usecaseId="uc-1" />, { wrapper: wrapper() });

    expect((await screen.findByTestId("software-detail-error")).textContent).toContain(
      "software.unreachable",
    );
    expect(screen.getByTestId("software-detail-error").textContent).not.toContain(
      "usecases forbidden",
    );
    expect(screen.queryByText("software.detail.notFound")).toBeNull();
  });

  test("renders Spack metadata, versions, capabilities, and dependencies", async () => {
    render(<SoftwareSpackDetailPage name="openfoam" source="upstream" />, { wrapper: wrapper() });

    expect((await screen.findAllByText("openfoam")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("openfoam@2312").length).toBeGreaterThan(0);
    expect(screen.getByText("Copy spec")).toBeDefined();
    expect(screen.getByRole("link", { name: /Open homepage/i }).getAttribute("href")).toBe(
      "https://openfoam.org",
    );
    expect(screen.getByText("GPL-3.0-only")).toBeDefined();
    expect(screen.getByText("2312")).toBeDefined();
    expect(screen.getByText("cfd-solver")).toBeDefined();
    expect(screen.getAllByText("mpi").length).toBeGreaterThan(0);
    expect(screen.getByText("elpa+openmp").closest("a")?.getAttribute("href")).toBe(
      "/software/spack/upstream/elpa",
    );
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe("/software#spack");
  });

  test("renders Spack catalog query errors instead of not found", async () => {
    softwareClient.listSpackCatalog.mockRejectedValueOnce(new Error("catalog forbidden"));

    render(<SoftwareSpackDetailPage name="openfoam" source="upstream" />, { wrapper: wrapper() });

    expect((await screen.findByTestId("software-detail-error")).textContent).toContain(
      "software.unreachable",
    );
    expect(screen.getByTestId("software-detail-error").textContent).not.toContain(
      "catalog forbidden",
    );
    expect(screen.queryByText("software.detail.notFound")).toBeNull();
  });
});

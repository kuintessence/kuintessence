import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  __resetForTests,
  registerWorkflowYamlDiagnostics,
  WORKFLOW_SCHEMA_URL,
} from "../monaco-workflow-diagnostics";

function makeMonaco() {
  return {
    languages: {
      registerCompletionItemProvider: vi.fn(),
      registerHoverProvider: vi.fn(),
      yaml: {
        yamlDefaults: {
          setDiagnosticsOptions: vi.fn(),
        },
      },
    },
  };
}

beforeEach(() => {
  __resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerWorkflowYamlDiagnostics", () => {
  test("registers the workflow schema without keyword completion or hover providers", () => {
    const monaco = makeMonaco();
    expect(registerWorkflowYamlDiagnostics(monaco)).toBe(true);
    expect(WORKFLOW_SCHEMA_URL).toBe("/platform/api/dsl/schema/workflow");
    expect(monaco.languages.yaml.yamlDefaults.setDiagnosticsOptions).toHaveBeenCalledWith({
      validate: true,
      hover: true,
      completion: true,
      schemas: [
        {
          uri: WORKFLOW_SCHEMA_URL,
          fileMatch: ["*.kq.yaml", "*.kq.yml", "*workflow*.yaml", "*workflow*.yml"],
        },
      ],
    });
    expect(monaco.languages.registerCompletionItemProvider).not.toHaveBeenCalled();
    expect(monaco.languages.registerHoverProvider).not.toHaveBeenCalled();
  });

  test("does not register diagnostics twice", () => {
    const monaco = makeMonaco();
    registerWorkflowYamlDiagnostics(monaco);
    registerWorkflowYamlDiagnostics(monaco);
    expect(monaco.languages.yaml.yamlDefaults.setDiagnosticsOptions).toHaveBeenCalledTimes(1);
  });

  test("can register after the optional YAML extension becomes available", () => {
    expect(registerWorkflowYamlDiagnostics({ languages: {} })).toBe(false);
    const monaco = makeMonaco();
    expect(registerWorkflowYamlDiagnostics(monaco)).toBe(true);
    expect(monaco.languages.yaml.yamlDefaults.setDiagnosticsOptions).toHaveBeenCalledTimes(1);
  });

  test("reports extension errors and allows a later retry", () => {
    const monaco = makeMonaco();
    monaco.languages.yaml.yamlDefaults.setDiagnosticsOptions.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    expect(registerWorkflowYamlDiagnostics(monaco)).toBe(false);
    expect(debugSpy).toHaveBeenCalled();
    expect(registerWorkflowYamlDiagnostics(monaco)).toBe(true);
  });

  test("accepts a custom schema URL", () => {
    const monaco = makeMonaco();
    const schemaUri = "https://elsewhere.example/schema.json";
    registerWorkflowYamlDiagnostics(monaco, schemaUri);
    expect(monaco.languages.yaml.yamlDefaults.setDiagnosticsOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        schemas: [expect.objectContaining({ uri: schemaUri })],
      }),
    );
  });
});

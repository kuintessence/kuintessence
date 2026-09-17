import { platformApiUrl } from "./platform-paths";

interface MonacoYamlDiagnosticsOptions {
  schemas: Array<{ uri: string; fileMatch: string[] }>;
  validate: boolean;
  hover: boolean;
  completion: boolean;
}

interface MonacoYamlDefaults {
  setDiagnosticsOptions: (opts: MonacoYamlDiagnosticsOptions) => void;
}

export const WORKFLOW_SCHEMA_URL = platformApiUrl("/dsl/schema/workflow");

const WORKFLOW_FILE_MATCH = ["*.kq.yaml", "*.kq.yml", "*workflow*.yaml", "*workflow*.yml"];

let yamlDiagnosticsRegistered = false;

/** Test-only helper for the diagnostics registration latch. */
export function __resetForTests(): void {
  yamlDiagnosticsRegistered = false;
}

/** Register workflow schema diagnostics when the host provides the optional YAML extension. */
export function registerWorkflowYamlDiagnostics(
  monaco: { languages: object },
  schemaUri: string = WORKFLOW_SCHEMA_URL,
): boolean {
  if (yamlDiagnosticsRegistered) return true;
  try {
    const yamlNs = (monaco.languages as { yaml?: { yamlDefaults?: MonacoYamlDefaults } }).yaml;
    const defaults = yamlNs?.yamlDefaults;
    if (!defaults || typeof defaults.setDiagnosticsOptions !== "function") {
      return false;
    }
    defaults.setDiagnosticsOptions({
      validate: true,
      hover: true,
      completion: true,
      schemas: [{ uri: schemaUri, fileMatch: WORKFLOW_FILE_MATCH }],
    });
    yamlDiagnosticsRegistered = true;
    return true;
  } catch (err) {
    // Optional extension failures must not prevent the YAML editor from mounting.
    console.debug("[workflow] monaco-yaml diagnostics registration failed", err);
    return false;
  }
}

// Monaco Vite worker bootstrap.
//
// Without this, monaco-editor falls back to running its language services on the
// main thread and emits a console warning ("Could not create web worker(s)…").
// Vite's `?worker` suffix builds the editor worker as a separate chunk and
// returns a constructor that the browser can instantiate as a Web Worker.
//
// We only register `editor.worker` because the workflow editor is YAML-only and
// YAML is plain text to Monaco — there's no language-specific worker to load.
// If we ever add JSON/TS/CSS Monaco features, register their workers here too.
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { registerWorkflowYamlDiagnostics } from "./monaco-workflow-diagnostics";

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker(workerId: string, label: string): Worker;
    };
  }
}

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

// Optional monaco-yaml hosts can validate against the workflow schema.
registerWorkflowYamlDiagnostics(monaco);

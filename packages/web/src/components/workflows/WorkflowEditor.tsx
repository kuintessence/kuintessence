import * as monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import { useTheme } from "../ThemeProvider";

export interface WorkflowEditorProps {
  value: string;
  onChange: (next: string) => void;
}

/**
 * Monaco YAML editor — imperative wrapper. Uses monaco-editor directly (not the
 * @monaco-editor/react wrapper, which trips a chunk-split React-resolution bug
 * in this Vite/React 19 stack). This pattern matches the xterm.js log viewer.
 */
export function WorkflowEditor({ value, onChange }: WorkflowEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const { resolved } = useTheme();

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Create editor once. We intentionally only mount it once and sync `value`/`theme`
  // via separate effects below — recreating Monaco on every prop change is expensive.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once on purpose
  useEffect(() => {
    if (!containerRef.current) return;
    const editor = monaco.editor.create(containerRef.current, {
      value,
      language: "yaml",
      theme: resolved === "dark" ? "vs-dark" : "vs",
      fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace",
      fontSize: 12,
      tabSize: 2,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on",
      automaticLayout: true,
      renderWhitespace: "boundary",
    });
    editorRef.current = editor;
    const sub = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue());
    });
    return () => {
      sub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // Sync external value into editor (e.g. picking a template).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.getValue() !== value) {
      editor.setValue(value);
    }
  }, [value]);

  // Theme switch.
  useEffect(() => {
    monaco.editor.setTheme(resolved === "dark" ? "vs-dark" : "vs");
  }, [resolved]);

  return (
    <div
      ref={containerRef}
      data-testid="workflow-editor"
      className="h-[60vh] overflow-hidden rounded-md border border-border bg-card"
    />
  );
}

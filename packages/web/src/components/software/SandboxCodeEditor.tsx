import type { SandboxLanguage } from "@kuintessence/shared/browser";
import * as monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import { useTheme } from "../ThemeProvider";

export function SandboxCodeEditor({
  language,
  onChange,
  value,
}: {
  language: SandboxLanguage;
  onChange: (next: string) => void;
  value: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const { resolved } = useTheme();
  const initialOptionsRef = useRef({ language, resolved, value });

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!containerRef.current) return;
    const initial = initialOptionsRef.current;
    const editor = monaco.editor.create(containerRef.current, {
      value: initial.value,
      language:
        initial.language === "nodejs"
          ? "javascript"
          : initial.language === "bash"
            ? "shell"
            : "python",
      theme: initial.resolved === "dark" ? "vs-dark" : "vs",
      fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace",
      fontSize: 13,
      tabSize: initial.language === "python" ? 4 : 2,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on",
      automaticLayout: true,
      renderWhitespace: "boundary",
      padding: { top: 12, bottom: 12 },
    });
    editorRef.current = editor;
    const subscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue());
    });
    return () => {
      subscription.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const nextLanguage =
      language === "nodejs" ? "javascript" : language === "bash" ? "shell" : "python";
    monaco.editor.setModelLanguage(model, nextLanguage);
    editor.updateOptions({ tabSize: language === "python" ? 4 : 2 });
  }, [language]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  useEffect(() => {
    monaco.editor.setTheme(resolved === "dark" ? "vs-dark" : "vs");
  }, [resolved]);

  return (
    <div
      ref={containerRef}
      data-testid="sandbox-code-editor"
      className="h-[56vh] min-h-[420px] overflow-hidden rounded-md border border-border bg-card"
    />
  );
}

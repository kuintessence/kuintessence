export async function loadSandboxCodeEditor() {
  const { SandboxCodeEditor } = await import("./SandboxCodeEditor");
  return SandboxCodeEditor;
}

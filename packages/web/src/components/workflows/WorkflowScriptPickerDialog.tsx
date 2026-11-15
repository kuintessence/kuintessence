import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SandboxScriptAsset } from "../../lib/sandbox-client";
import { NativeSelect } from "../ui/native-select";
import { ResourcePickerDialog } from "../ui/resource-picker";

export function WorkflowScriptPickerDialog({
  busy,
  error,
  loading,
  onApply,
  onOpenChange,
  open,
  scripts,
}: {
  busy: boolean;
  error: boolean;
  loading: boolean;
  onApply: (script: SandboxScriptAsset) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  scripts: SandboxScriptAsset[];
}) {
  const { t } = useTranslation();
  const [language, setLanguage] = useState("all");
  return (
    <ResourcePickerDialog
      open={open}
      onOpenChange={onOpenChange}
      value={[]}
      title={t("workflow.editor.scriptPicker.title")}
      data-testid="workflow-script-picker-dialog"
      confirmTestId="workflow-script-apply"
      rowTestId={(option) => `workflow-script-option-${option.value}`}
      onDoubleClick={(option) => {
        const script = scripts.find((item) => item.id === option.value);
        if (script) onApply(script);
      }}
      closeOnConfirm={false}
      busy={busy}
      loading={loading}
      error={error ? t("workflow.editor.scriptPicker.loadFailed") : undefined}
      options={scripts.map((script) => ({
        value: script.id,
        label: script.name,
        description: `${script.version} · ${script.payload.language} · ${script.payload.entrypoint}`,
        keywords: [...Object.keys(script.payload.inputs), ...Object.keys(script.payload.outputs)],
        language: script.payload.language,
      }))}
      filterOption={(option) => language === "all" || option.language === language}
      filters={
        <NativeSelect
          aria-label={t("sandbox.catalog.language")}
          data-testid="workflow-script-language-filter"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
        >
          <option value="all">{t("sandbox.catalog.allLanguages")}</option>
          <option value="python">Python</option>
          <option value="nodejs">Node.js</option>
          <option value="bash">Bash</option>
        </NativeSelect>
      }
      onConfirm={(ids) => {
        const script = scripts.find((item) => item.id === ids[0]);
        if (script) onApply(script);
      }}
    />
  );
}

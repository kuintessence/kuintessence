import { GitBranch } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowTemplateCreate } from "../../lib/software-client";
import { Button } from "../ui/button";
import { FormField } from "../ui/form-field";
import { Input, Textarea } from "../ui/input";
import { optionalText, parseTagInput } from "./software-fields";

export function WorkflowTemplateForm({
  isPending = false,
  onSubmit,
}: {
  isPending?: boolean;
  onSubmit: (payload: WorkflowTemplateCreate) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState("");
  const [version, setVersion] = useState("0.1.0");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("demo");
  const [yamlContent, setYamlContent] = useState("");
  return (
    <form
      className="grid grid-cols-1 gap-3 border-b border-border p-3"
      data-testid="software-template-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !version.trim() || !yamlContent.trim()) return;
        onSubmit({
          name: name.trim(),
          version: version.trim(),
          description: optionalText(description),
          yamlContent,
          tags: parseTagInput(tags),
        });
      }}
    >
      <div className="grid gap-2 md:grid-cols-[1fr_140px]">
        <FormField id={`${id}-name`} label={t("software.manage.templateName")}>
          {(field) => <Input {...field} value={name} onChange={(e) => setName(e.target.value)} />}
        </FormField>
        <FormField id={`${id}-version`} label={t("software.manage.version")}>
          {(field) => (
            <Input {...field} value={version} onChange={(e) => setVersion(e.target.value)} />
          )}
        </FormField>
      </div>
      <FormField id={`${id}-description`} label={t("software.manage.description")}>
        {(field) => (
          <Input {...field} value={description} onChange={(e) => setDescription(e.target.value)} />
        )}
      </FormField>
      <FormField id={`${id}-tags`} label={t("software.manage.tags")}>
        {(field) => <Input {...field} value={tags} onChange={(e) => setTags(e.target.value)} />}
      </FormField>
      <FormField id={`${id}-yamlContent`} label={t("software.detail.yamlSource")}>
        {(field) => (
          <Textarea
            {...field}
            value={yamlContent}
            onChange={(e) => setYamlContent(e.target.value)}
            placeholder={t("software.manage.yamlPlaceholder")}
            className="min-h-28 font-mono text-xs"
          />
        )}
      </FormField>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={isPending}>
          <GitBranch />
          {t("software.manage.publish")}
        </Button>
      </div>
    </form>
  );
}

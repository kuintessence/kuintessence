import { workflowDsl } from "@kuintessence/shared/browser";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import type { NodePatch } from "./PropertiesPanel";
export type FederationNode = Extract<workflowDsl.WorkflowNode, { type: "Federation" }>;
export function updateFederationNode(raw: FederationNode, form: FormData): FederationNode {
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const number = (name: string) => {
    const value = text(name);
    return value ? Number(value) : Number.NaN;
  };
  const {
    market: _market,
    arbitration: _arbitration,
    executionExpiresAt: _expires,
    inputDelivery: _input,
    resultDelivery: _result,
    ...rest
  } = raw;
  const node = workflowDsl.WorkflowNodeSchema.parse({
    ...rest,
    agreementRevisionId: text("agreementRevisionId"),
    template: {
      kind: text("templateKind"),
      originSiteId: text("templateSiteId"),
      id: text("templateId"),
      revision: text("templateRevision"),
      digest: text("templateDigest"),
    },
    inputManifestDigest: text("inputManifestDigest"),
    environmentLockDigest: text("environmentLockDigest"),
    resources: {
      cpus: number("cpus"),
      memoryMb: number("memoryMb"),
      gpus: number("gpus"),
      wallTimeSec: number("wallTimeSec"),
    },
    maxAmount: text("maxAmount"),
    admissionWindowSec: number("admissionWindowSec"),
    ...(text("executionExpiresAt")
      ? { executionExpiresAt: new Date(text("executionExpiresAt")).toISOString() }
      : {}),
    ...(text("inputDelivery") ? { inputDelivery: text("inputDelivery") } : {}),
    ...(text("resultDelivery") ? { resultDelivery: text("resultDelivery") } : {}),
    ...(form.get("marketEnabled") === "on"
      ? {
          market: {
            policyId: text("policyId"),
            title: text("title"),
            description: String(form.get("description") ?? ""),
          },
        }
      : {}),
    ...(form.get("arbitrationEnabled") === "on"
      ? {
          arbitration: {
            policyId: text("arbitrationPolicyId"),
            policyDigest: text("arbitrationPolicyDigest"),
          },
        }
      : {}),
  });
  if (node.type !== "Federation") throw new Error("Expected a federation node");
  return node;
}
export function FederationNodeFields({
  id: nodeId,
  raw,
  onPatch,
}: {
  id: string;
  raw: FederationNode;
  onPatch: (id: string, patch: NodePatch) => void;
}) {
  return <FederationFields key={JSON.stringify(raw)} nodeId={nodeId} raw={raw} onPatch={onPatch} />;
}
function FederationFields({
  nodeId,
  raw,
  onPatch,
}: {
  nodeId: string;
  raw: FederationNode;
  onPatch: (id: string, patch: NodePatch) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [market, setMarket] = useState(!!raw.market);
  const [arbitration, setArbitration] = useState(!!raw.arbitration);
  const [invalid, setInvalid] = useState(false);
  const input = (name: string, value: string | number, type = "text", required = true) => (
    <label className="grid min-w-0 gap-1 text-xs" htmlFor={`${id}-${name}`}>
      {t(`workflow.editor.federation.${name}`)}
      <Input
        id={`${id}-${name}`}
        name={name}
        defaultValue={value}
        type={type}
        required={required}
        className="min-w-0 text-xs"
      />
    </label>
  );
  const time = raw.executionExpiresAt ? new Date(raw.executionExpiresAt) : null;
  const localTime = time
    ? new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : "";
  return (
    <form
      className="space-y-4"
      data-testid="rf-prop-federation"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const node = updateFederationNode(raw, new FormData(event.currentTarget));
          setInvalid(false);
          onPatch(nodeId, { raw: node });
        } catch {
          setInvalid(true);
        }
      }}
    >
      {input("agreementRevisionId", raw.agreementRevisionId)}
      <fieldset className="space-y-3">
        <legend className="mb-2 text-xs font-medium">
          {t("workflow.editor.federation.template")}
        </legend>
        <label className="grid gap-1 text-xs" htmlFor={`${id}-templateKind`}>
          {t("workflow.editor.federation.templateKind")}
          <NativeSelect
            id={`${id}-templateKind`}
            aria-label={t("workflow.editor.federation.templateKind")}
            name="templateKind"
            defaultValue={raw.template.kind}
          >
            <option value="workflow">{t("workflow.editor.federation.workflow")}</option>
            <option value="script">{t("workflow.editor.federation.script")}</option>
          </NativeSelect>
        </label>
        {input("templateSiteId", raw.template.originSiteId)}
        {input("templateId", raw.template.id)}
        {input("templateRevision", raw.template.revision)}
        {input("templateDigest", raw.template.digest)}
      </fieldset>
      {input("inputManifestDigest", raw.inputManifestDigest)}
      {input("environmentLockDigest", raw.environmentLockDigest)}
      <fieldset className="grid grid-cols-2 gap-3">
        <legend className="mb-2 text-xs font-medium">
          {t("workflow.editor.federation.resources")}
        </legend>
        {(["cpus", "memoryMb", "gpus", "wallTimeSec"] as const).map((name) => (
          <div className="min-w-0" key={name}>
            {input(name, raw.resources[name], "number")}
          </div>
        ))}
      </fieldset>
      {input("maxAmount", raw.maxAmount)}
      {input("admissionWindowSec", raw.admissionWindowSec, "number")}
      {input("executionExpiresAt", localTime, "datetime-local", false)}
      {(["inputDelivery", "resultDelivery"] as const).map((name) => (
        <label key={name} className="grid gap-1 text-xs" htmlFor={`${id}-${name}`}>
          {t(`workflow.editor.federation.${name}`)}
          <NativeSelect
            id={`${id}-${name}`}
            aria-label={t(`workflow.editor.federation.${name}`)}
            name={name}
            defaultValue={raw[name] ?? ""}
          >
            <option value="">{t("workflow.editor.federation.defaultDelivery")}</option>
            <option value="network">{t("workflow.editor.federation.network")}</option>
            <option value="media">{t("workflow.editor.federation.physical_media")}</option>
          </NativeSelect>
        </label>
      ))}
      <fieldset className="space-y-3">
        <legend>
          <label className="flex items-center gap-2 text-xs font-medium">
            <input
              type="checkbox"
              name="marketEnabled"
              checked={market}
              onChange={(event) => setMarket(event.target.checked)}
            />
            {t("workflow.editor.federation.market")}
          </label>
        </legend>
        {market ? (
          <>
            <p className="text-xs text-muted-foreground">
              {t("workflow.editor.federation.publicWarning")}
            </p>
            {input("policyId", raw.market?.policyId ?? "")}
            {input("title", raw.market?.title ?? "")}
            <label className="grid gap-1 text-xs" htmlFor={`${id}-description`}>
              {t("workflow.editor.federation.description")}
              <Textarea
                id={`${id}-description`}
                name="description"
                aria-label={t("workflow.editor.federation.description")}
                maxLength={4096}
                defaultValue={raw.market?.description ?? ""}
              />
            </label>
          </>
        ) : null}
      </fieldset>
      <fieldset className="space-y-3">
        <legend>
          <label className="flex items-center gap-2 text-xs font-medium">
            <input
              type="checkbox"
              name="arbitrationEnabled"
              checked={arbitration}
              onChange={(event) => setArbitration(event.target.checked)}
            />
            {t("workflow.editor.federation.arbitration")}
          </label>
        </legend>
        {arbitration ? (
          <>
            {input("arbitrationPolicyId", raw.arbitration?.policyId ?? "")}
            {input("arbitrationPolicyDigest", raw.arbitration?.policyDigest ?? "")}
          </>
        ) : null}
      </fieldset>
      {invalid ? (
        <p role="alert" className="text-xs text-status-failed">
          {t("workflow.editor.federation.invalid")}
        </p>
      ) : null}
      <Button size="sm" type="submit">
        {t("workflow.editor.federation.apply")}
      </Button>
    </form>
  );
}

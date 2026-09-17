/**
 * Right-side panel for the selected workflow node.
 *
 * The nine node types have structured bodies. The
 * common editable fields — display `name` and the optional
 * CEL `when` guard — are always exposed. `SoftwareUsecaseComputing` (the leaf
 * execution node) additionally gets a structured form for its version ids and
 * resource requirements; `Script` for its source, runtime and inline body; `Milestone`
 * for its notify url and custom message. The five control-flow node types —
 * `Switch`, `Loop`, `Reduce`, `SubWorkflow`, `Generate` — expose their flat
 * scalar/enum/ref config (and Switch's case list) here; their deeply-nested
 * sub-graph bodies (`Loop.body`, `SubWorkflow` Inline `body`) and complex
 * discriminated rules/reducers (`Generate.rule`, `Reduce.reducer`) stay
 * YAML-authored and render read-only. Any other node type still authors its
 * whole body in the YAML pane and shows it here read-only as a formatted block.
 */

import type { workflowDsl } from "@kuintessence/shared/browser";
import { Check, Copy, PanelRightClose, PanelRightOpen } from "lucide-react";
import { type ChangeEvent, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { GraphEdge, GraphNode, GraphNodeData } from "../../lib/yaml-graph-sync";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type UsecaseNode = Extract<workflowDsl.WorkflowNode, { type: "SoftwareUsecaseComputing" }>;
type Requirements = NonNullable<UsecaseNode["requirements"]>;
type ScriptNode = Extract<workflowDsl.WorkflowNode, { type: "Script" }>;
type MilestoneNode = Extract<workflowDsl.WorkflowNode, { type: "Milestone" }>;
type SwitchNode = Extract<workflowDsl.WorkflowNode, { type: "Switch" }>;
type SwitchCase = SwitchNode["cases"][number];
type LoopNode = Extract<workflowDsl.WorkflowNode, { type: "Loop" }>;
type LoopMode = LoopNode["mode"];
type OnExhausted = NonNullable<LoopNode["onExhausted"]>;
type ReduceNode = Extract<workflowDsl.WorkflowNode, { type: "Reduce" }>;
type ReduceOrdering = NonNullable<ReduceNode["ordering"]>;
type SubWorkflowNode = Extract<workflowDsl.WorkflowNode, { type: "SubWorkflow" }>;
type SubWorkflowRef = SubWorkflowNode["ref"];
type GenerateNode = Extract<workflowDsl.WorkflowNode, { type: "Generate" }>;
type GenOutputAs = GenerateNode["output"]["as"];

/** Numeric `requirements` fields, in the schema's declaration order. */
const REQUIREMENT_FIELDS = [
  "cpuCores",
  "nodeCount",
  "maxWallTime",
  "maxCpuTime",
  "stopTime",
] as const satisfies ReadonlyArray<keyof Requirements>;

type RequirementField = (typeof REQUIREMENT_FIELDS)[number];

function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: form layout uses sibling association
    <label className={className} {...props} />
  );
}

export type NodePatch = Partial<GraphNodeData>;

export interface PropertiesPanelProps {
  selected: GraphNode | null;
  selectedEdge?: GraphEdge | null;
  onPatch: (nodeId: string, patch: NodePatch) => void;
  onEdgePatch?: (edgeId: string, patch: Partial<GraphEdge>) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

interface FieldRowProps {
  label: string;
  testId?: string;
  hint?: string;
  children: ReactNode;
}

function FieldRow({ label, testId, hint, children }: FieldRowProps) {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function JsonDetails({ value }: { value: unknown }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(value, null, 2);

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      toast.success(t("workflow.editor.properties.jsonCopied"));
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error(t("workflow.editor.properties.jsonCopyFailed"));
    }
  }

  return (
    <div className="rounded-lg border border-border bg-muted/20" data-testid="rf-prop-json">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="font-medium">{t("workflow.editor.properties.rawJson")}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t("workflow.editor.properties.copyJson")}
          title={t("workflow.editor.properties.copyJson")}
          onClick={copyJson}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          <span className="sr-only">
            {copied
              ? t("workflow.editor.properties.copied")
              : t("workflow.editor.properties.copyJson")}
          </span>
        </Button>
      </div>
      <pre className="max-h-48 overflow-auto px-3 py-2 font-mono text-[11px]">{json}</pre>
    </div>
  );
}

function ManifestSummary({ raw }: { raw: ScriptNode }) {
  const { t } = useTranslation();
  const inputs = Object.entries(raw.inputs);
  const outputs = Object.entries(raw.outputs);
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <div>
        <p className="font-medium">{t("workflow.editor.properties.inputs")}</p>
        <div className="mt-1 space-y-1">
          {inputs.length === 0 ? (
            <p className="text-muted-foreground">{t("workflow.editor.properties.none")}</p>
          ) : (
            inputs.map(([descriptor, spec]) => (
              <div key={descriptor} className="flex items-center justify-between gap-3">
                <code>{descriptor}</code>
                <span className="text-muted-foreground">
                  {spec.type} ·{" "}
                  {spec.required
                    ? t("workflow.editor.properties.required")
                    : t("workflow.editor.properties.optional")}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
      <div>
        <p className="font-medium">{t("workflow.editor.properties.outputs")}</p>
        <div className="mt-1 space-y-1">
          {outputs.length === 0 ? (
            <p className="text-muted-foreground">{t("workflow.editor.properties.none")}</p>
          ) : (
            outputs.map(([descriptor, spec]) => (
              <div key={descriptor} className="flex items-center justify-between gap-3">
                <code>{descriptor}</code>
                <span className="text-right text-muted-foreground">
                  {spec.type} · {t(`workflow.editor.properties.locality.${spec.locality.type}`)} ·{" "}
                  {t(`workflow.editor.properties.durability.${spec.durability}`)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function PropertiesPanel({
  selected,
  selectedEdge = null,
  onPatch,
  onEdgePatch,
  collapsed = false,
  onToggleCollapsed,
}: PropertiesPanelProps) {
  const { t } = useTranslation();
  const title = selectedEdge
    ? t("workflow.editor.properties.edgeTitle", { defaultValue: "Edge properties" })
    : t("workflow.editor.properties.title", { defaultValue: "Properties" });

  if (collapsed) {
    return (
      <aside
        data-testid="rf-properties-collapsed"
        className="flex h-9 w-full shrink-0 items-center gap-2 border-t border-border bg-card px-2 lg:h-full lg:w-9 lg:flex-col lg:border-l lg:border-t-0 lg:py-2"
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("workflow.editor.expandProperties")}
          data-testid="rf-properties-expand"
          onClick={onToggleCollapsed}
        >
          <PanelRightOpen />
        </Button>
        <span className="text-[11px] text-muted-foreground lg:mt-1 lg:[writing-mode:vertical-rl]">
          {title}
        </span>
      </aside>
    );
  }

  const headerRow = (
    <div className="flex items-center justify-between">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      {onToggleCollapsed ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("workflow.editor.collapseProperties")}
          data-testid="rf-properties-collapse"
          onClick={onToggleCollapsed}
        >
          <PanelRightClose />
        </Button>
      ) : null}
    </div>
  );

  if (!selected && !selectedEdge) {
    return (
      <aside
        data-testid="rf-properties-empty"
        className="flex max-h-72 w-full shrink-0 flex-col items-start gap-2 overflow-y-auto border-t border-border bg-card p-4 text-xs text-muted-foreground lg:h-full lg:max-h-none lg:border-t-0"
      >
        {headerRow}
        <p>
          {t("workflow.editor.properties.empty", {
            defaultValue: "Select a node or edge to inspect its properties.",
          })}
        </p>
      </aside>
    );
  }

  return (
    <aside
      data-testid="rf-properties"
      className="flex max-h-96 w-full shrink-0 flex-col gap-3 overflow-y-auto border-t border-border bg-card p-4 lg:h-full lg:max-h-none lg:border-t-0"
    >
      {headerRow}
      {selectedEdge ? (
        <EdgePropertiesForm key={selectedEdge.id} selected={selectedEdge} onPatch={onEdgePatch} />
      ) : selected ? (
        <PropertiesForm key={selected.id} selected={selected} onPatch={onPatch} />
      ) : null}
    </aside>
  );
}

function EdgePropertiesForm({
  selected,
  onPatch,
}: {
  selected: GraphEdge;
  onPatch?: (edgeId: string, patch: Partial<GraphEdge>) => void;
}) {
  const { t } = useTranslation();
  const [when, setWhen] = useState(selected.when?.expr ?? "");

  function commitWhen() {
    const next = when.trim();
    if (next === (selected.when?.expr ?? "")) return;
    onPatch?.(selected.id, {
      when: next ? { expr: next, lang: "cel" } : undefined,
    });
  }

  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="rf-edge-properties">
      <FieldRow label={t("workflow.editor.properties.edgeSource")}>
        <ReadOnlyValue value={selected.source} mono />
      </FieldRow>
      <FieldRow label={t("workflow.editor.properties.edgeTarget")}>
        <ReadOnlyValue value={selected.target} mono />
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.when", { defaultValue: "When guard (CEL)" })}
        hint={t("workflow.editor.properties.whenHint")}
      >
        <Input value={when} onChange={(event) => setWhen(event.target.value)} onBlur={commitWhen} />
      </FieldRow>
      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <p className="font-medium">{t("workflow.editor.properties.slotMappings")}</p>
        {(selected.slotRelations?.length ?? 0) === 0 ? (
          <p className="mt-2 text-muted-foreground">
            {t("workflow.editor.properties.noSlotMappings")}
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {selected.slotRelations?.map((relation) => (
              <div
                key={`${relation.fromSlot}:${relation.toSlot}`}
                className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-2"
              >
                <code className="min-w-0 flex-1 truncate">{relation.fromSlot}</code>
                <span className="text-muted-foreground">→</span>
                <code className="min-w-0 flex-1 truncate">{relation.toSlot}</code>
              </div>
            ))}
          </div>
        )}
      </div>
      <JsonDetails value={selected} />
    </div>
  );
}

function ReadOnlyValue({ value, mono = false }: { value: string; mono?: boolean }) {
  return (
    <div
      className={`min-h-9 rounded-md border border-border bg-muted/50 px-3 py-2 text-muted-foreground shadow-none ${mono ? "font-mono text-[11px]" : "text-xs"}`}
    >
      {value}
    </div>
  );
}

interface PropertiesFormProps {
  selected: GraphNode;
  onPatch: (id: string, patch: NodePatch) => void;
}

function PropertiesForm({ selected, onPatch }: PropertiesFormProps) {
  const { t } = useTranslation();
  const { id, data } = selected;
  const raw = data.raw;

  const [name, setName] = useState(data.name);
  const [whenPred, setWhenPred] = useState(data.when?.expr ?? "");

  useEffect(() => {
    setName(data.name);
    setWhenPred(data.when?.expr ?? "");
  }, [data.name, data.when]);

  function commitName() {
    if (name === data.name) return;
    onPatch(id, { name, raw: { ...raw, name } });
  }

  function commitWhen() {
    const next = whenPred.trim();
    const current = data.when?.expr ?? "";
    if (next === current) return;
    if (next === "") {
      const { when: _omit, ...rest } = raw;
      onPatch(id, { when: undefined, raw: rest as GraphNodeData["raw"] });
      return;
    }
    const expr = { expr: next, lang: "cel" };
    onPatch(id, {
      when: expr,
      raw: { ...raw, when: expr },
    });
  }

  return (
    <div className="flex flex-col gap-3 text-xs">
      <FieldRow label={t("workflow.editor.properties.id", { defaultValue: "Node id" })}>
        <Input data-testid="rf-prop-id" value={id} readOnly className="font-mono text-[11px]" />
      </FieldRow>
      <FieldRow label={t("workflow.editor.properties.type", { defaultValue: "Node type" })}>
        <Input
          data-testid="rf-prop-type"
          value={t(`workflow.editor.nodeTypes.${data.kind}`, { defaultValue: data.kind })}
          readOnly
          tabIndex={-1}
          aria-readonly="true"
          className="cursor-default border-border bg-muted/50 text-[11px] text-muted-foreground shadow-none focus-visible:ring-0"
        />
      </FieldRow>
      <FieldRow label={t("workflow.editor.properties.name", { defaultValue: "Display name" })}>
        <Input
          data-testid="rf-prop-name"
          value={name}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          onBlur={commitName}
        />
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.when", { defaultValue: "When guard (CEL)" })}
        hint={t("workflow.editor.properties.whenHint", {
          defaultValue: "CEL expression that gates execution",
        })}
      >
        <Input
          data-testid="rf-prop-when"
          value={whenPred}
          onChange={(e) => setWhenPred(e.target.value)}
          onBlur={commitWhen}
        />
      </FieldRow>
      {raw.type === "SoftwareUsecaseComputing" ? (
        <UsecaseFields id={id} raw={raw} onPatch={onPatch} />
      ) : raw.type === "Script" ? (
        <ScriptFields id={id} raw={raw} onPatch={onPatch} />
      ) : raw.type === "Milestone" ? (
        <MilestoneFields id={id} raw={raw} onPatch={onPatch} />
      ) : raw.type === "Switch" ? (
        <SwitchFields id={id} raw={raw} onPatch={onPatch} />
      ) : raw.type === "Loop" ? (
        <LoopFields id={id} raw={raw} onPatch={onPatch} />
      ) : raw.type === "Reduce" ? (
        <ReduceFields id={id} raw={raw} onPatch={onPatch} />
      ) : raw.type === "SubWorkflow" ? (
        <SubWorkflowFields id={id} raw={raw} onPatch={onPatch} />
      ) : raw.type === "Generate" ? (
        <GenerateFields id={id} raw={raw} onPatch={onPatch} />
      ) : (
        <FieldRow
          label={t("workflow.editor.properties.body", { defaultValue: "Node body" })}
          hint={t("workflow.editor.properties.bodyHint", {
            defaultValue: "Edit the full node body in the YAML pane",
          })}
        >
          <pre
            data-testid="rf-prop-body"
            className="max-h-48 overflow-auto rounded-md border border-input bg-background px-3 py-1 font-mono text-[11px]"
          >
            {JSON.stringify(raw, null, 2)}
          </pre>
        </FieldRow>
      )}
    </div>
  );
}

interface UsecaseFieldsProps {
  id: string;
  raw: UsecaseNode;
  onPatch: (id: string, patch: NodePatch) => void;
}

/** Reduce a draft's `requirements` to displayable string values (empty when unset). */
function reqStrings(req: Requirements | null | undefined): Record<RequirementField, string> {
  const out = {} as Record<RequirementField, string>;
  for (const field of REQUIREMENT_FIELDS) {
    const value = req?.[field];
    out[field] = value === undefined || value === null ? "" : String(value);
  }
  return out;
}

/** Structured form for the `SoftwareUsecaseComputing` leaf execution node. */
function UsecaseFields({ id, raw, onPatch }: UsecaseFieldsProps) {
  const { t } = useTranslation();
  const namedReference = raw.usecaseRef !== undefined || raw.softwareRef !== undefined;
  const [usecaseVersionId, setUsecaseVersionId] = useState(raw.usecaseVersionId ?? "");
  const [softwareVersionId, setSoftwareVersionId] = useState(raw.softwareVersionId ?? "");
  const [reqs, setReqs] = useState(() => reqStrings(raw.requirements));

  useEffect(() => {
    setUsecaseVersionId(raw.usecaseVersionId ?? "");
    setSoftwareVersionId(raw.softwareVersionId ?? "");
    setReqs(reqStrings(raw.requirements));
  }, [raw.usecaseVersionId, raw.softwareVersionId, raw.requirements]);

  function commitUsecaseVersionId() {
    const next = usecaseVersionId.trim();
    if (namedReference || next === raw.usecaseVersionId) return;
    onPatch(id, { raw: { ...raw, usecaseVersionId: next } });
  }

  function commitSoftwareVersionId() {
    const next = softwareVersionId.trim();
    if (namedReference || next === raw.softwareVersionId) return;
    onPatch(id, { raw: { ...raw, softwareVersionId: next } });
  }

  function commitRequirement(field: RequirementField) {
    const text = (reqs[field] ?? "").trim();
    const parsed = text === "" ? undefined : Number(text);
    if (parsed !== undefined && !Number.isFinite(parsed)) return;

    const nextReqs: Record<string, number> = {};
    for (const key of REQUIREMENT_FIELDS) {
      const existing = raw.requirements?.[key];
      if (key === field) {
        if (parsed !== undefined) nextReqs[key] = parsed;
      } else if (existing !== undefined && existing !== null) {
        nextReqs[key] = existing;
      }
    }
    const requirements =
      Object.keys(nextReqs).length === 0 ? undefined : (nextReqs as Requirements);
    onPatch(id, { raw: { ...raw, requirements } });
  }

  const inputSlotCount = raw.inputSlots?.length ?? 0;

  return (
    <>
      <FieldRow
        label={t("workflow.editor.properties.usecaseVersionId", {
          defaultValue: "Usecase version id",
        })}
        testId="rf-prop-usecase-version"
      >
        <Input
          data-testid="rf-prop-usecase-version-id"
          value={usecaseVersionId}
          disabled={namedReference}
          className="font-mono text-[11px]"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setUsecaseVersionId(e.target.value)}
          onBlur={commitUsecaseVersionId}
        />
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.softwareVersionId", {
          defaultValue: "Software version id",
        })}
        testId="rf-prop-software-version"
      >
        <Input
          data-testid="rf-prop-software-version-id"
          value={softwareVersionId}
          disabled={namedReference}
          className="font-mono text-[11px]"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSoftwareVersionId(e.target.value)}
          onBlur={commitSoftwareVersionId}
        />
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.requirements", { defaultValue: "Requirements" })}
        hint={t("workflow.editor.properties.requirementsHint", {
          defaultValue: "Resource request overrides: leave blank to omit",
        })}
      >
        <div className="flex flex-col gap-2">
          {REQUIREMENT_FIELDS.map((field) => (
            <div key={field} className="flex items-center gap-2">
              <Label className="w-24 shrink-0 text-[11px] text-muted-foreground">{field}</Label>
              <Input
                data-testid={`rf-prop-req-${field}`}
                type="number"
                value={reqs[field]}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setReqs((prev) => ({ ...prev, [field]: e.target.value }))
                }
                onBlur={() => commitRequirement(field)}
              />
            </div>
          ))}
        </div>
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.inputSlots", { defaultValue: "Input slots" })}
        hint={t("workflow.editor.properties.inputSlotsHint", {
          defaultValue: "Slot binding is edited in the YAML pane for now",
        })}
      >
        <pre
          data-testid="rf-prop-input-slots"
          className="max-h-40 overflow-auto rounded-md border border-input bg-background px-3 py-1 font-mono text-[11px]"
        >
          {inputSlotCount === 0
            ? t("workflow.editor.properties.inputSlotsEmpty", { defaultValue: "(none)" })
            : JSON.stringify(raw.inputSlots, null, 2)}
        </pre>
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.bodyExtra", { defaultValue: "Other fields" })}
        hint={t("workflow.editor.properties.bodyExtraHint", {
          defaultValue: "Scheduling strategy and slot wiring are edited in the YAML pane",
        })}
      >
        <pre
          data-testid="rf-prop-body"
          className="max-h-48 overflow-auto rounded-md border border-input bg-background px-3 py-1 font-mono text-[11px]"
        >
          {JSON.stringify(raw, null, 2)}
        </pre>
      </FieldRow>
    </>
  );
}

interface ScriptFieldsProps {
  id: string;
  raw: ScriptNode;
  onPatch: (id: string, patch: NodePatch) => void;
}

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-background px-3 py-1 text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Structured form for the `Script` inline-script authoring node. */
function ScriptFields({ id, raw, onPatch }: ScriptFieldsProps) {
  const { t } = useTranslation();
  const source = raw.source;
  const inline = source?.type === "Inline" ? source : undefined;
  const [content, setContent] = useState(inline?.content ?? "");
  const [runtimeProfileId, setRuntimeProfileId] = useState(raw.runtimeProfileId ?? "");

  useEffect(() => {
    setContent(inline?.content ?? "");
    setRuntimeProfileId(raw.runtimeProfileId ?? "");
  }, [inline?.content, raw.runtimeProfileId]);

  function commitContent() {
    if (!inline || content === inline.content) return;
    onPatch(id, { raw: { ...raw, source: { ...inline, content } } });
  }

  function commitRuntimeProfileId() {
    const next = runtimeProfileId.trim();
    if (raw.runtimeContractRef || next === raw.runtimeProfileId) return;
    onPatch(id, { raw: { ...raw, runtimeProfileId: next } });
  }

  return (
    <>
      <FieldRow
        label={t("workflow.editor.properties.scriptSource", { defaultValue: "Script source" })}
        testId="rf-prop-script-kind-row"
      >
        <select
          data-testid="rf-prop-script-source"
          className={SELECT_CLASS}
          value={source?.type ?? "AssetRevision"}
          disabled
        >
          <option value="Inline">{t("workflow.editor.properties.sourceInline")}</option>
          <option value="AssetRevision">
            {t("workflow.editor.properties.sourceAssetRevision")}
          </option>
        </select>
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.scriptRuntime", { defaultValue: "Runtime profile" })}
        hint={t("workflow.editor.properties.scriptOriginHint", {
          defaultValue: "Platform-managed, digest-pinned runtime profile",
        })}
      >
        <Input
          data-testid="rf-prop-script-runtime"
          value={runtimeProfileId}
          disabled={raw.runtimeContractRef !== undefined}
          className="font-mono text-[11px]"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setRuntimeProfileId(e.target.value)}
          onBlur={commitRuntimeProfileId}
        />
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.scriptIdentity", {
          defaultValue: "Execution identity",
        })}
        hint={t("workflow.editor.properties.scriptIdentityHint", {
          defaultValue: "Inline scripts always use a mapped cluster account",
        })}
      >
        <Input
          data-testid="rf-prop-script-identity"
          value={raw.executionIdentity.type}
          readOnly
          className="font-mono text-[11px]"
        />
      </FieldRow>
      {inline ? (
        <>
          <FieldRow
            label={t("workflow.editor.properties.scriptLanguage", { defaultValue: "Language" })}
          >
            <Input
              data-testid="rf-prop-script-language"
              value={inline.language}
              readOnly
              className="font-mono text-[11px]"
            />
          </FieldRow>
          <FieldRow
            label={t("workflow.editor.properties.scriptContent", { defaultValue: "Script body" })}
          >
            <textarea
              data-testid="rf-prop-script-content"
              className="min-h-40 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={content}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
              onBlur={commitContent}
            />
          </FieldRow>
        </>
      ) : null}
      <FieldRow
        label={t("workflow.editor.properties.manifest")}
        hint={t("workflow.editor.properties.scriptBodyExtraHint", {
          defaultValue: "Input/output paths and slot wiring are edited in the YAML pane",
        })}
      >
        <ManifestSummary raw={raw} />
      </FieldRow>
      <JsonDetails value={raw} />
    </>
  );
}

interface MilestoneFieldsProps {
  id: string;
  raw: MilestoneNode;
  onPatch: (id: string, patch: NodePatch) => void;
}

/** Structured form for the `Milestone` notification node — two flat string fields. */
function MilestoneFields({ id, raw, onPatch }: MilestoneFieldsProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(raw.url);
  const [customMessage, setCustomMessage] = useState(raw.customMessage);

  useEffect(() => {
    setUrl(raw.url);
    setCustomMessage(raw.customMessage);
  }, [raw.url, raw.customMessage]);

  function commitUrl() {
    const next = url.trim();
    if (next === raw.url) return;
    onPatch(id, { raw: { ...raw, url: next } });
  }

  function commitMessage() {
    if (customMessage === raw.customMessage) return;
    onPatch(id, { raw: { ...raw, customMessage } });
  }

  return (
    <>
      <FieldRow
        label={t("workflow.editor.properties.milestoneUrl", { defaultValue: "Notify URL" })}
        hint={t("workflow.editor.properties.milestoneUrlHint", {
          defaultValue: "Endpoint notified when the milestone is reached",
        })}
      >
        <Input
          data-testid="rf-prop-milestone-url"
          value={url}
          className="font-mono text-[11px]"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
          onBlur={commitUrl}
        />
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.milestoneMessage", {
          defaultValue: "Custom message",
        })}
      >
        <textarea
          data-testid="rf-prop-milestone-message"
          className="min-h-24 resize-y rounded-md border border-input bg-background px-3 py-2 text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={customMessage}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setCustomMessage(e.target.value)}
          onBlur={commitMessage}
        />
      </FieldRow>
    </>
  );
}

const PRE_CLASS =
  "max-h-48 overflow-auto rounded-md border border-input bg-background px-3 py-1 font-mono text-[11px]";

/** Read-only block for nested sub-graph bodies / complex rules authored in YAML. */
function ReadOnlyBody({ value }: { value: unknown }) {
  const { t } = useTranslation();
  return (
    <FieldRow
      label={t("workflow.editor.properties.bodyExtra", { defaultValue: "Other fields" })}
      hint={t("workflow.editor.properties.controlFlowBodyHint", {
        defaultValue: "Nested bodies and complex rules are edited in the YAML pane",
      })}
    >
      <pre data-testid="rf-prop-body" className={PRE_CLASS}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </FieldRow>
  );
}

interface SwitchFieldsProps {
  id: string;
  raw: SwitchNode;
  onPatch: (id: string, patch: NodePatch) => void;
}

/** Structured form for the `Switch` node — an editable case list plus a default slug. */
function SwitchFields({ id, raw, onPatch }: SwitchFieldsProps) {
  const { t } = useTranslation();
  const [cases, setCases] = useState<SwitchCase[]>(raw.cases);
  const [defaultTo, setDefaultTo] = useState(raw.default ?? "");

  useEffect(() => {
    setCases(raw.cases);
    setDefaultTo(raw.default ?? "");
  }, [raw.cases, raw.default]);

  function commitCases(next: SwitchCase[]) {
    setCases(next);
    onPatch(id, { raw: { ...raw, cases: next } });
  }

  function addCase() {
    commitCases([...cases, { when: { expr: "", lang: "cel" }, to: "" }]);
  }

  function removeCase(index: number) {
    if (cases.length <= 1) return;
    commitCases(cases.filter((_, i) => i !== index));
  }

  function setCaseWhen(index: number, expr: string) {
    setCases((prev) => prev.map((c, i) => (i === index ? { ...c, when: { ...c.when, expr } } : c)));
  }

  function setCaseTo(index: number, to: string) {
    setCases((prev) => prev.map((c, i) => (i === index ? { ...c, to } : c)));
  }

  function commitCaseField(index: number) {
    const next = cases[index];
    const current = raw.cases[index];
    if (next === undefined) return;
    if (current !== undefined && next.when.expr === current.when.expr && next.to === current.to) {
      return;
    }
    onPatch(id, { raw: { ...raw, cases } });
  }

  function commitDefault() {
    const next = defaultTo.trim();
    const current = raw.default ?? "";
    if (next === current) return;
    if (next === "") {
      const { default: _omit, ...rest } = raw;
      onPatch(id, { raw: rest as SwitchNode });
      return;
    }
    onPatch(id, { raw: { ...raw, default: next } });
  }

  return (
    <>
      <FieldRow
        label={t("workflow.editor.properties.switchCases", { defaultValue: "Cases" })}
        hint={t("workflow.editor.properties.switchCasesHint", {
          defaultValue: "Each case routes to a node when its CEL guard holds",
        })}
      >
        <div className="flex flex-col gap-2">
          {cases.map((c, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: cases are positional, no stable id
            <div key={index} className="flex flex-col gap-1 rounded-md border border-input p-2">
              <Input
                data-testid={`rf-prop-switch-case-when-${index}`}
                value={c.when.expr}
                placeholder="when (CEL)"
                className="font-mono text-[11px]"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setCaseWhen(index, e.target.value)}
                onBlur={() => commitCaseField(index)}
              />
              <div className="flex items-center gap-2">
                <Input
                  data-testid={`rf-prop-switch-case-to-${index}`}
                  value={c.to}
                  placeholder="to (node id)"
                  className="font-mono text-[11px]"
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setCaseTo(index, e.target.value)}
                  onBlur={() => commitCaseField(index)}
                />
                {cases.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid={`rf-prop-switch-remove-case-${index}`}
                    onClick={() => removeCase(index)}
                  >
                    {t("workflow.editor.properties.remove", { defaultValue: "Remove" })}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="rf-prop-switch-add-case"
            onClick={addCase}
          >
            {t("workflow.editor.properties.switchAddCase", { defaultValue: "Add case" })}
          </Button>
        </div>
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.switchDefault", { defaultValue: "Default target" })}
        hint={t("workflow.editor.properties.switchDefaultHint", {
          defaultValue: "Node id taken when no case matches: leave blank to omit",
        })}
      >
        <Input
          data-testid="rf-prop-switch-default"
          value={defaultTo}
          className="font-mono text-[11px]"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDefaultTo(e.target.value)}
          onBlur={commitDefault}
        />
      </FieldRow>
    </>
  );
}

interface LoopFieldsProps {
  id: string;
  raw: LoopNode;
  onPatch: (id: string, patch: NodePatch) => void;
}

function intOrExprToString(value: LoopNode["maxIterations"]): string {
  return typeof value === "number" ? String(value) : value.expr;
}

/** Structured form for the `Loop` node — mode/iterations/guards; body stays read-only. */
function LoopFields({ id, raw, onPatch }: LoopFieldsProps) {
  const { t } = useTranslation();
  const [maxIterations, setMaxIterations] = useState(intOrExprToString(raw.maxIterations));
  const [over, setOver] = useState(raw.over?.expr ?? "");
  const [until, setUntil] = useState(raw.until?.expr ?? "");
  const [maxParallel, setMaxParallel] = useState(
    raw.maxParallel === undefined ? "" : String(raw.maxParallel),
  );

  useEffect(() => {
    setMaxIterations(intOrExprToString(raw.maxIterations));
    setOver(raw.over?.expr ?? "");
    setUntil(raw.until?.expr ?? "");
    setMaxParallel(raw.maxParallel === undefined ? "" : String(raw.maxParallel));
  }, [raw.maxIterations, raw.over, raw.until, raw.maxParallel]);

  function changeMode(mode: LoopMode) {
    if (mode === raw.mode) return;
    const { over: _over, until: _until, ...rest } = raw;
    const guard = (mode === "ForEach" ? over : until).trim();
    const next: LoopNode =
      mode === "ForEach"
        ? { ...rest, mode, ...(guard ? { over: { expr: guard, lang: "cel" } } : {}) }
        : { ...rest, mode, ...(guard ? { until: { expr: guard, lang: "cel" } } : {}) };
    onPatch(id, { raw: next });
  }

  function commitMaxIterations() {
    const text = maxIterations.trim();
    if (text === "") return;
    const asNumber = Number(text);
    const next: LoopNode["maxIterations"] =
      Number.isInteger(asNumber) && asNumber > 0 ? asNumber : { expr: text, lang: "cel" };
    if (intOrExprToString(raw.maxIterations) === text) return;
    onPatch(id, { raw: { ...raw, maxIterations: next } });
  }

  function commitOver() {
    if (raw.mode !== "ForEach") return;
    const next = over.trim();
    if (next === (raw.over?.expr ?? "") || next === "") return;
    onPatch(id, { raw: { ...raw, over: { expr: next, lang: "cel" } } });
  }

  function commitUntil() {
    if (raw.mode !== "While") return;
    const next = until.trim();
    if (next === (raw.until?.expr ?? "") || next === "") return;
    onPatch(id, { raw: { ...raw, until: { expr: next, lang: "cel" } } });
  }

  function changeOnExhausted(value: string) {
    if (value === "") {
      const { onExhausted: _omit, ...rest } = raw;
      onPatch(id, { raw: rest as LoopNode });
      return;
    }
    onPatch(id, { raw: { ...raw, onExhausted: value as OnExhausted } });
  }

  function commitMaxParallel() {
    const text = maxParallel.trim();
    if (text === "") {
      if (raw.maxParallel === undefined) return;
      const { maxParallel: _omit, ...rest } = raw;
      onPatch(id, { raw: rest as LoopNode });
      return;
    }
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed === raw.maxParallel) return;
    onPatch(id, { raw: { ...raw, maxParallel: parsed } });
  }

  return (
    <>
      <FieldRow label={t("workflow.editor.properties.loopMode", { defaultValue: "Mode" })}>
        <select
          data-testid="rf-prop-loop-mode"
          className={SELECT_CLASS}
          value={raw.mode}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => changeMode(e.target.value as LoopMode)}
        >
          <option value="While">While</option>
          <option value="ForEach">ForEach</option>
        </select>
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.loopMaxIterations", {
          defaultValue: "Max iterations",
        })}
        hint={t("workflow.editor.properties.loopMaxIterationsHint", {
          defaultValue: "A positive integer or a CEL expression",
        })}
      >
        <Input
          data-testid="rf-prop-loop-max-iterations"
          value={maxIterations}
          className="font-mono text-[11px]"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setMaxIterations(e.target.value)}
          onBlur={commitMaxIterations}
        />
      </FieldRow>
      {raw.mode === "ForEach" ? (
        <FieldRow label={t("workflow.editor.properties.loopOver", { defaultValue: "Over (CEL)" })}>
          <Input
            data-testid="rf-prop-loop-over"
            value={over}
            className="font-mono text-[11px]"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setOver(e.target.value)}
            onBlur={commitOver}
          />
        </FieldRow>
      ) : (
        <FieldRow
          label={t("workflow.editor.properties.loopUntil", { defaultValue: "Until (CEL)" })}
        >
          <Input
            data-testid="rf-prop-loop-until"
            value={until}
            className="font-mono text-[11px]"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setUntil(e.target.value)}
            onBlur={commitUntil}
          />
        </FieldRow>
      )}
      <FieldRow
        label={t("workflow.editor.properties.loopOnExhausted", { defaultValue: "On exhausted" })}
      >
        <select
          data-testid="rf-prop-loop-on-exhausted"
          className={SELECT_CLASS}
          value={raw.onExhausted ?? ""}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => changeOnExhausted(e.target.value)}
        >
          <option value="">(default)</option>
          <option value="Fail">Fail</option>
          <option value="SucceedWithLast">SucceedWithLast</option>
        </select>
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.loopMaxParallel", { defaultValue: "Max parallel" })}
      >
        <Input
          data-testid="rf-prop-loop-max-parallel"
          type="number"
          value={maxParallel}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setMaxParallel(e.target.value)}
          onBlur={commitMaxParallel}
        />
      </FieldRow>
      <ReadOnlyBody value={{ body: raw.body, outputs: raw.outputs, carry: raw.carry }} />
    </>
  );
}

interface ReduceFieldsProps {
  id: string;
  raw: ReduceNode;
  onPatch: (id: string, patch: NodePatch) => void;
}

/** Structured form for the `Reduce` node — source ref + ordering + output descriptor. */
function ReduceFields({ id, raw, onPatch }: ReduceFieldsProps) {
  const { t } = useTranslation();
  const [fromLoop, setFromLoop] = useState(raw.from.loop);
  const [fromOutput, setFromOutput] = useState(raw.from.output);
  const [descriptor, setDescriptor] = useState(raw.output.descriptor);

  useEffect(() => {
    setFromLoop(raw.from.loop);
    setFromOutput(raw.from.output);
    setDescriptor(raw.output.descriptor);
  }, [raw.from.loop, raw.from.output, raw.output.descriptor]);

  function commitFromLoop() {
    const next = fromLoop.trim();
    if (next === raw.from.loop) return;
    onPatch(id, { raw: { ...raw, from: { ...raw.from, loop: next } } });
  }

  function commitFromOutput() {
    const next = fromOutput.trim();
    if (next === raw.from.output) return;
    onPatch(id, { raw: { ...raw, from: { ...raw.from, output: next } } });
  }

  function changeOrdering(value: string) {
    if (value === "") {
      const { ordering: _omit, ...rest } = raw;
      onPatch(id, { raw: rest as ReduceNode });
      return;
    }
    onPatch(id, { raw: { ...raw, ordering: value as ReduceOrdering } });
  }

  function changeOutputKind(value: string) {
    onPatch(id, {
      raw: { ...raw, output: { ...raw.output, kind: value as ReduceNode["output"]["kind"] } },
    });
  }

  function commitDescriptor() {
    const next = descriptor.trim();
    if (next === raw.output.descriptor) return;
    onPatch(id, { raw: { ...raw, output: { ...raw.output, descriptor: next } } });
  }

  return (
    <>
      <FieldRow
        label={t("workflow.editor.properties.reduceFromLoop", { defaultValue: "From loop" })}
        hint={t("workflow.editor.properties.reduceFromLoopHint", {
          defaultValue: "Loop node id whose aggregated output feeds this reduce",
        })}
      >
        <Input
          data-testid="rf-prop-reduce-from-loop"
          value={fromLoop}
          className="font-mono text-[11px]"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setFromLoop(e.target.value)}
          onBlur={commitFromLoop}
        />
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.reduceFromOutput", { defaultValue: "From output" })}
      >
        <Input
          data-testid="rf-prop-reduce-from-output"
          value={fromOutput}
          className="font-mono text-[11px]"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setFromOutput(e.target.value)}
          onBlur={commitFromOutput}
        />
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.reduceOrdering", { defaultValue: "Ordering" })}
      >
        <select
          data-testid="rf-prop-reduce-ordering"
          className={SELECT_CLASS}
          value={raw.ordering ?? ""}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => changeOrdering(e.target.value)}
        >
          <option value="">(default)</option>
          <option value="ByIndex">ByIndex</option>
          <option value="Unordered">Unordered</option>
        </select>
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.reduceOutputKind", { defaultValue: "Output kind" })}
      >
        <select
          data-testid="rf-prop-reduce-output-kind"
          className={SELECT_CLASS}
          value={raw.output.kind}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => changeOutputKind(e.target.value)}
        >
          <option value="SingleFile">SingleFile</option>
          <option value="OrderedFolder">OrderedFolder</option>
        </select>
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.reduceOutputDescriptor", {
          defaultValue: "Output descriptor",
        })}
      >
        <Input
          data-testid="rf-prop-reduce-output-descriptor"
          value={descriptor}
          className="font-mono text-[11px]"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDescriptor(e.target.value)}
          onBlur={commitDescriptor}
        />
      </FieldRow>
      <ReadOnlyBody value={{ reducer: raw.reducer }} />
    </>
  );
}

interface SubWorkflowFieldsProps {
  id: string;
  raw: SubWorkflowNode;
  onPatch: (id: string, patch: NodePatch) => void;
}

const EMPTY_SPEC: workflowDsl.WorkflowSpec = { nodeDrafts: [], nodeRelations: [] };

/** Structured form for the `SubWorkflow` node — discriminated ref + depth controls. */
function SubWorkflowFields({ id, raw, onPatch }: SubWorkflowFieldsProps) {
  const { t } = useTranslation();
  const { ref } = raw;
  const [versionId, setVersionId] = useState(ref.kind === "ByVersion" ? ref.workflowVersionId : "");
  const [maxDepth, setMaxDepth] = useState(String(raw.maxDepth));

  useEffect(() => {
    setVersionId(ref.kind === "ByVersion" ? ref.workflowVersionId : "");
    setMaxDepth(String(raw.maxDepth));
  }, [ref, raw.maxDepth]);

  function changeRefKind(kind: SubWorkflowRef["kind"]) {
    if (kind === ref.kind) return;
    // ByVersion carries any id already typed; with none, `workflowVersionId` is
    // a schema-required field that cannot be type-cleanly omitted, so the emit
    // is transient-invalid (fails `UuidSchema`) until the user enters a UUID —
    // consistent with how Switch empty `to`/`default` are handled. The YAML pane
    // surfaces the schema error in the meantime.
    const next: SubWorkflowRef =
      kind === "ByVersion"
        ? { kind: "ByVersion", workflowVersionId: versionId.trim() }
        : { kind: "Inline", body: EMPTY_SPEC };
    onPatch(id, { raw: { ...raw, ref: next } });
  }

  function commitVersionId() {
    if (ref.kind !== "ByVersion") return;
    const next = versionId.trim();
    if (next === ref.workflowVersionId) return;
    onPatch(id, { raw: { ...raw, ref: { kind: "ByVersion", workflowVersionId: next } } });
  }

  function commitMaxDepth() {
    const parsed = Number(maxDepth.trim());
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed === raw.maxDepth) return;
    onPatch(id, { raw: { ...raw, maxDepth: parsed } });
  }

  function changeOnDepthExceeded(value: string) {
    if (value === "") {
      const { onDepthExceeded: _omit, ...rest } = raw;
      onPatch(id, { raw: rest as SubWorkflowNode });
      return;
    }
    onPatch(id, { raw: { ...raw, onDepthExceeded: value as OnExhausted } });
  }

  return (
    <>
      <FieldRow
        label={t("workflow.editor.properties.subworkflowRefKind", { defaultValue: "Reference" })}
        hint={t("workflow.editor.properties.subworkflowRefKindHint", {
          defaultValue: "ByVersion points at a published workflow; Inline embeds a body",
        })}
      >
        <select
          data-testid="rf-prop-subworkflow-ref-kind"
          className={SELECT_CLASS}
          value={ref.kind}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            changeRefKind(e.target.value as SubWorkflowRef["kind"])
          }
        >
          <option value="ByVersion">ByVersion</option>
          <option value="Inline">Inline</option>
        </select>
      </FieldRow>
      {ref.kind === "ByVersion" ? (
        <FieldRow
          label={t("workflow.editor.properties.subworkflowVersionId", {
            defaultValue: "Workflow version id",
          })}
        >
          <Input
            data-testid="rf-prop-subworkflow-version-id"
            value={versionId}
            className="font-mono text-[11px]"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setVersionId(e.target.value)}
            onBlur={commitVersionId}
          />
        </FieldRow>
      ) : (
        <FieldRow
          label={t("workflow.editor.properties.subworkflowInlineBody", {
            defaultValue: "Inline body",
          })}
          hint={t("workflow.editor.properties.subworkflowInlineBodyHint", {
            defaultValue: "The embedded workflow body is edited in the YAML pane",
          })}
        >
          <pre data-testid="rf-prop-subworkflow-body" className={PRE_CLASS}>
            {JSON.stringify(ref.body, null, 2)}
          </pre>
        </FieldRow>
      )}
      <FieldRow
        label={t("workflow.editor.properties.subworkflowMaxDepth", { defaultValue: "Max depth" })}
      >
        <Input
          data-testid="rf-prop-subworkflow-max-depth"
          type="number"
          value={maxDepth}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setMaxDepth(e.target.value)}
          onBlur={commitMaxDepth}
        />
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.subworkflowOnDepthExceeded", {
          defaultValue: "On depth exceeded",
        })}
      >
        <select
          data-testid="rf-prop-subworkflow-on-depth-exceeded"
          className={SELECT_CLASS}
          value={raw.onDepthExceeded ?? ""}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => changeOnDepthExceeded(e.target.value)}
        >
          <option value="">(default)</option>
          <option value="Fail">Fail</option>
          <option value="SucceedWithLast">SucceedWithLast</option>
        </select>
      </FieldRow>
      <ReadOnlyBody value={{ inputs: raw.inputs, outputs: raw.outputs }} />
    </>
  );
}

interface GenerateFieldsProps {
  id: string;
  raw: GenerateNode;
  onPatch: (id: string, patch: NodePatch) => void;
}

/** Structured form for the `Generate` node — simple output descriptor; rule stays read-only. */
function GenerateFields({ id, raw, onPatch }: GenerateFieldsProps) {
  const { t } = useTranslation();
  const [descriptor, setDescriptor] = useState(raw.output.descriptor);

  useEffect(() => {
    setDescriptor(raw.output.descriptor);
  }, [raw.output.descriptor]);

  function commitDescriptor() {
    const next = descriptor.trim();
    if (next === raw.output.descriptor) return;
    onPatch(id, { raw: { ...raw, output: { ...raw.output, descriptor: next } } });
  }

  function changeAs(value: string) {
    onPatch(id, { raw: { ...raw, output: { ...raw.output, as: value as GenOutputAs } } });
  }

  return (
    <>
      <FieldRow
        label={t("workflow.editor.properties.generateOutputDescriptor", {
          defaultValue: "Output descriptor",
        })}
      >
        <Input
          data-testid="rf-prop-generate-output-descriptor"
          value={descriptor}
          className="font-mono text-[11px]"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDescriptor(e.target.value)}
          onBlur={commitDescriptor}
        />
      </FieldRow>
      <FieldRow
        label={t("workflow.editor.properties.generateOutputAs", { defaultValue: "Output as" })}
      >
        <select
          data-testid="rf-prop-generate-output-as"
          className={SELECT_CLASS}
          value={raw.output.as}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => changeAs(e.target.value)}
        >
          <option value="List">List</option>
          <option value="BatchFiles">BatchFiles</option>
        </select>
      </FieldRow>
      <ReadOnlyBody value={{ rule: raw.rule }} />
    </>
  );
}

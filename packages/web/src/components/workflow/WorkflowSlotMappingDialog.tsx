import { ArrowRight, GripVertical, Link2, Plus, X } from "lucide-react";
import { type DragEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import type { GraphEdge, GraphNode } from "../../lib/yaml-graph-sync";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

export interface SlotOption {
  batch?: boolean;
  description?: string | null;
  descriptor: string;
  optional?: boolean;
  type: "Dataset" | "File" | "Text";
}

type SlotMapping = NonNullable<GraphEdge["slotRelations"]>[number];
const EMPTY_MAPPINGS: SlotMapping[] = [];

export function workflowOutputSlots(node: GraphNode): SlotOption[] {
  const raw = node.data.raw;
  if ("outputSlots" in raw && raw.outputSlots && raw.outputSlots.length > 0) {
    return raw.outputSlots.map((slot) => ({
      batch: slot.type === "File" ? slot.isBatch : false,
      description: slot.description,
      descriptor: slot.descriptor,
      optional: slot.optional,
      type: slot.type,
    }));
  }
  if (raw.type !== "Script") return [];
  return Object.entries(raw.outputs).map(([descriptor, output]) => ({
    batch: output.type === "FileBatch",
    descriptor,
    type: output.type === "File" || output.type === "FileBatch" ? "File" : "Text",
  }));
}

export function workflowInputSlots(node: GraphNode): SlotOption[] {
  const raw = node.data.raw;
  if ("inputSlots" in raw && raw.inputSlots && raw.inputSlots.length > 0) {
    return raw.inputSlots.map((slot) => ({
      batch: slot.type === "File" ? slot.isBatch : false,
      description: slot.description,
      descriptor: slot.descriptor,
      optional: slot.optional,
      type: slot.type,
    }));
  }
  if (raw.type !== "Script") return [];
  return Object.entries(raw.inputs).map(([descriptor, input]) => ({
    batch: input.type === "FileBatch",
    descriptor,
    type: input.type === "File" || input.type === "FileBatch" ? "File" : "Text",
  }));
}

function replaceMapping(current: SlotMapping[], next: SlotMapping): SlotMapping[] {
  return [
    ...current.filter(
      (mapping) => mapping.fromSlot !== next.fromSlot && mapping.toSlot !== next.toSlot,
    ),
    next,
  ];
}

export function WorkflowSlotMappingDialog({
  edge,
  initialMappings = EMPTY_MAPPINGS,
  onConfirm,
  onOpenChange,
  open,
  source,
  target,
}: {
  edge: GraphEdge | null;
  initialMappings?: SlotMapping[];
  onConfirm: (mappings: SlotMapping[]) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  source: GraphNode | null;
  target: GraphNode | null;
}) {
  const { t } = useTranslation();
  const sources = useMemo(() => (source ? workflowOutputSlots(source) : []), [source]);
  const targets = useMemo(() => (target ? workflowInputSlots(target) : []), [target]);
  const [mappings, setMappings] = useState<SlotMapping[]>([]);
  const [fromSlot, setFromSlot] = useState("");
  const [toSlot, setToSlot] = useState("");
  const [transferType, setTransferType] = useState<"Network" | "Disk">("Network");
  const [draggedSlot, setDraggedSlot] = useState<string | null>(null);
  const [mode, setMode] = useState<"visual" | "standard">("visual");
  const compatibleTargets = useMemo(() => {
    const sourceSlot = sources.find((slot) => slot.descriptor === fromSlot);
    return sourceSlot ? targets.filter((slot) => slot.type === sourceSlot.type) : targets;
  }, [fromSlot, sources, targets]);

  useEffect(() => {
    if (!open) return;
    const existing = edge?.slotRelations ?? initialMappings;
    const firstSource = sources[0];
    const exact = firstSource
      ? targets.find(
          (slot) => slot.type === firstSource.type && slot.descriptor === firstSource.descriptor,
        )
      : undefined;
    const compatible = firstSource
      ? targets.find((slot) => slot.type === firstSource.type)
      : targets[0];
    const firstTarget = exact ?? compatible;
    const singleCompatibleTargets = firstSource
      ? targets.filter((slot) => slot.type === firstSource.type)
      : [];
    const automatic =
      existing.length === 0 &&
      sources.length === 1 &&
      firstTarget &&
      singleCompatibleTargets.length === 1
        ? [
            {
              fromSlot: firstSource?.descriptor ?? "",
              toSlot: firstTarget.descriptor,
              transferStrategy: { type: "Network" as const },
            },
          ]
        : existing;
    setMappings(automatic);
    setFromSlot(firstSource?.descriptor ?? "");
    setToSlot(firstTarget?.descriptor ?? "");
    setTransferType("Network");
    setDraggedSlot(null);
    setMode("visual");
  }, [edge, initialMappings, open, sources, targets]);

  function addMapping(nextFrom = fromSlot, nextTo = toSlot) {
    if (!nextFrom || !nextTo) return;
    const sourceSlot = sources.find((slot) => slot.descriptor === nextFrom);
    const targetSlot = targets.find((slot) => slot.descriptor === nextTo);
    if (!sourceSlot || !targetSlot || sourceSlot.type !== targetSlot.type) return;
    setMappings((current) =>
      replaceMapping(current, {
        fromSlot: nextFrom,
        toSlot: nextTo,
        transferStrategy: { type: transferType },
      }),
    );
  }

  function beginSlotDrag(event: DragEvent<HTMLButtonElement>, descriptor: string) {
    event.dataTransfer.effectAllowed = "link";
    event.dataTransfer.setData("application/x-kq-workflow-slot", descriptor);
    setDraggedSlot(descriptor);
  }

  function completeSlotDrop(event: DragEvent<HTMLButtonElement>, descriptor: string) {
    event.preventDefault();
    const sourceDescriptor =
      event.dataTransfer.getData("application/x-kq-workflow-slot") || draggedSlot;
    if (sourceDescriptor) addMapping(sourceDescriptor, descriptor);
    setDraggedSlot(null);
  }

  const dirty = JSON.stringify(mappings) !== JSON.stringify(edge?.slotRelations ?? initialMappings);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(calc(100vw-1rem),760px)]"
        data-testid="workflow-slot-mapping-dialog"
        dirty={dirty}
        outsideDismissPolicy="never"
      >
        <DialogHeader>
          <DialogTitle>{t("workflow.editor.slotMapping.title")}</DialogTitle>
          <DialogDescription>{t("workflow.editor.slotMapping.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 p-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{source?.data.name}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{source?.id}</p>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 text-right">
              <p className="truncate text-sm font-semibold">{target?.data.name}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{target?.id}</p>
            </div>
          </div>

          <Tabs value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="visual">
                {t("workflow.editor.slotMapping.visualMode")}
              </TabsTrigger>
              <TabsTrigger value="standard">
                {t("workflow.editor.slotMapping.standardMode")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="visual">
              {sources.length === 0 || targets.length === 0 ? (
                <EmptySlots text={t("workflow.editor.slotMapping.noSlots")} />
              ) : (
                <div className="grid gap-3 rounded-lg border border-border bg-muted/10 p-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                  <SlotColumn
                    active={draggedSlot}
                    activeType={
                      sources.find((slot) => slot.descriptor === draggedSlot)?.type ?? null
                    }
                    label={t("workflow.editor.slotMapping.output")}
                    mappings={mappings}
                    onDragEnd={() => setDraggedSlot(null)}
                    onDragStart={beginSlotDrag}
                    side="source"
                    slots={sources}
                  />
                  <div className="flex min-w-20 flex-col items-center justify-center gap-2 py-8 text-brand">
                    <ArrowRight className="h-5 w-5" />
                    <span className="max-w-24 text-center text-[11px] text-muted-foreground">
                      {t("workflow.editor.slotMapping.visualHint")}
                    </span>
                  </div>
                  <SlotColumn
                    active={draggedSlot}
                    label={t("workflow.editor.slotMapping.input")}
                    mappings={mappings}
                    onDrop={completeSlotDrop}
                    side="target"
                    slots={targets}
                  />
                </div>
              )}
            </TabsContent>
            <TabsContent value="standard">
              {sources.length === 0 || targets.length === 0 ? (
                <EmptySlots text={t("workflow.editor.slotMapping.noSlots")} />
              ) : (
                <div className="grid gap-2 rounded-lg border border-border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_auto]">
                  <label className="space-y-1 text-xs text-muted-foreground">
                    {t("workflow.editor.slotMapping.output")}
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                      value={fromSlot}
                      onChange={(event) => {
                        const next = event.target.value;
                        setFromSlot(next);
                        const sourceSlot = sources.find((slot) => slot.descriptor === next);
                        const matchingTarget = targets.find(
                          (slot) =>
                            slot.type === sourceSlot?.type && (slot.descriptor === next || !toSlot),
                        );
                        if (matchingTarget) setToSlot(matchingTarget.descriptor);
                      }}
                    >
                      {sources.map((slot) => (
                        <option key={slot.descriptor} value={slot.descriptor}>
                          {slot.descriptor} · {slot.type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    {t("workflow.editor.slotMapping.input")}
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                      value={toSlot}
                      onChange={(event) => setToSlot(event.target.value)}
                    >
                      {compatibleTargets.map((slot) => (
                        <option key={slot.descriptor} value={slot.descriptor}>
                          {slot.descriptor} · {slot.type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    {t("workflow.editor.slotMapping.transfer")}
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                      value={transferType}
                      onChange={(event) =>
                        setTransferType(event.target.value as "Network" | "Disk")
                      }
                    >
                      <option value="Network">Network</option>
                      <option value="Disk">Disk</option>
                    </select>
                  </label>
                  <Button
                    type="button"
                    className="self-end"
                    onClick={() => addMapping()}
                    disabled={!fromSlot || !toSlot}
                    data-testid="workflow-slot-mapping-add"
                  >
                    <Plus />
                    {t("workflow.editor.slotMapping.add")}
                  </Button>
                </div>
              )}
            </TabsContent>
          </Tabs>

          <div className="space-y-2">
            <p className="text-sm font-medium">
              {t("workflow.editor.slotMapping.configured", { count: mappings.length })}
            </p>
            {mappings.length === 0 ? (
              <p className="rounded-md bg-muted/30 p-3 text-xs text-muted-foreground">
                {t("workflow.editor.slotMapping.dependencyOnly")}
              </p>
            ) : (
              mappings.map((mapping) => (
                <div
                  key={`${mapping.fromSlot}:${mapping.toSlot}`}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <Link2 className="h-4 w-4 shrink-0 text-brand" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {mapping.fromSlot} → {mapping.toSlot}
                  </span>
                  <Badge variant="outline">{mapping.transferStrategy.type}</Badge>
                  <button
                    type="button"
                    aria-label={t("common.remove")}
                    onClick={() =>
                      setMappings((current) =>
                        current.filter(
                          (candidate) =>
                            candidate.fromSlot !== mapping.fromSlot ||
                            candidate.toSlot !== mapping.toSlot,
                        ),
                      )
                    }
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </DialogBody>
        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => onConfirm(mappings)}
            disabled={mappings.length === 0}
            data-testid="workflow-slot-mapping-confirm"
          >
            {edge ? t("workflow.editor.slotMapping.save") : t("workflow.editor.slotMapping.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptySlots({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function SlotColumn({
  active,
  activeType,
  label,
  mappings,
  onDragEnd,
  onDragStart,
  onDrop,
  side,
  slots,
}: {
  active: string | null;
  activeType?: SlotOption["type"] | null;
  label: string;
  mappings: SlotMapping[];
  onDragEnd?: () => void;
  onDragStart?: (event: DragEvent<HTMLButtonElement>, descriptor: string) => void;
  onDrop?: (event: DragEvent<HTMLButtonElement>, descriptor: string) => void;
  side: "source" | "target";
  slots: SlotOption[];
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {slots.map((slot) => {
        const mapped = mappings.some((mapping) =>
          side === "source"
            ? mapping.fromSlot === slot.descriptor
            : mapping.toSlot === slot.descriptor,
        );
        const compatible = !active || side === "source" || slot.type === activeType;
        return (
          <button
            key={slot.descriptor}
            type="button"
            className={cn(
              "flex min-h-12 w-full items-center gap-2 rounded-md border bg-background px-3 py-2 text-left transition-all",
              mapped && "border-brand bg-brand-soft shadow-sm",
              active && side === "target" && compatible && "border-brand/60 ring-2 ring-brand/15",
            )}
            draggable={side === "source"}
            onDragEnd={onDragEnd}
            onDragOver={(event) => {
              if (side === "target" && compatible) event.preventDefault();
            }}
            onDragStart={(event) => onDragStart?.(event, slot.descriptor)}
            onDrop={(event) => {
              if (compatible) onDrop?.(event, slot.descriptor);
            }}
            data-testid={`workflow-slot-${side}-${slot.descriptor}`}
          >
            {side === "source" ? <GripVertical className="h-4 w-4 shrink-0" /> : null}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-xs font-medium">
                {slot.descriptor}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {slot.description || slot.type}
              </span>
            </span>
            <Badge variant="outline">{slot.type}</Badge>
          </button>
        );
      })}
    </div>
  );
}

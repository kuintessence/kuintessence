import dagre from "@dagrejs/dagre";
import { ArrowUpRight, RefreshCw, SlidersHorizontal } from "lucide-react";
import { type CSSProperties, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { NativeSelect } from "../ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { FunctionMapIcon } from "./icons";
import {
  type FunctionMap,
  type MapNode,
  type MapObservation,
  type MapRuntime,
  mapText,
} from "./model";
import "./function-maps.css";

const WIDTH = 208;
function layout(model: FunctionMap, height: number) {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: "LR", ranksep: 56, nodesep: 24, marginx: 12, marginy: 12 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of model.nodes) graph.setNode(node.id, { width: WIDTH, height: height });
  model.edges.forEach((edge, index) => {
    graph.setEdge(edge.source, edge.target, {}, String(index));
  });
  dagre.layout(graph);
  const ranks = [...new Set(model.nodes.map((node) => graph.node(node.id).x))].sort(
    (a, b) => a - b,
  );
  if (model.type === "process" && ranks.length > 4) {
    const groups = ranks.map((x) => model.nodes.filter((node) => graph.node(node.id).x === x));
    const nodeRanks = new Map(
      groups.flatMap((nodes, rank) => nodes.map((node) => [node.id, rank] as const)),
    );
    const rowTops: number[] = [];
    let top = 12;
    for (let row = 0; row < Math.ceil(groups.length / 3); row++) {
      rowTops.push(top);
      const rowGroups = groups.slice(row * 3, row * 3 + 3);
      const rowHeight = Math.max(...rowGroups.map((nodes) => nodes.length * (height + 24) - 24));
      rowGroups.forEach((nodes, column) => {
        nodes.forEach((node, index) => {
          Object.assign(graph.node(node.id), {
            x: 12 + WIDTH / 2 + (row % 2 ? 2 - column : column) * (WIDTH + 88),
            y: top + rowHeight / 2 + (index - (nodes.length - 1) / 2) * (height + 24),
          });
        });
      });
      top += rowHeight + 64;
    }
    model.edges.forEach((edge, index) => {
      const source = graph.node(edge.source);
      const target = graph.node(edge.target);
      const route = graph.edge({ v: edge.source, w: edge.target, name: String(index) });
      const sourceRow = Math.floor((nodeRanks.get(edge.source) ?? 0) / 3);
      const targetRow = Math.floor((nodeRanks.get(edge.target) ?? 0) / 3);
      if (sourceRow === targetRow) {
        const direction = Math.sign(target.x - source.x);
        const middle = (source.x + target.x) / 2;
        route.points = [
          { x: source.x + (direction * WIDTH) / 2, y: source.y },
          { x: middle, y: source.y },
          { x: middle, y: target.y },
          { x: target.x - (direction * WIDTH) / 2, y: target.y },
        ];
        route.x = middle;
        route.y = (source.y + target.y) / 2 - 12;
      } else {
        const sourceRail = source.x + WIDTH / 2 + 40;
        const targetRail = target.x + WIDTH / 2 + 40;
        const bus = (rowTops[Math.max(sourceRow, targetRow)] ?? 0) - 32;
        route.points = [
          { x: source.x + WIDTH / 2, y: source.y },
          { x: sourceRail, y: source.y },
          { x: sourceRail, y: bus },
          { x: targetRail, y: bus },
          { x: targetRail, y: target.y },
          { x: target.x + WIDTH / 2, y: target.y },
        ];
        route.x = targetRail;
        route.y = target.y - 12;
      }
    });
    graph.graph().width = 3 * WIDTH + 2 * 88 + 104;
    graph.graph().height = top - 52;
  }
  if (!model.edges.length && model.nodes.length) {
    const columns = Math.min(6, model.nodes.length, Math.ceil(Math.sqrt(model.nodes.length * 1.2)));
    model.nodes.forEach((node, index) => {
      Object.assign(graph.node(node.id), {
        x: 12 + WIDTH / 2 + (index % columns) * (WIDTH + 24),
        y: 12 + height / 2 + Math.floor(index / columns) * (height + 24),
      });
    });
    graph.graph().width = columns * (WIDTH + 24);
    graph.graph().height = Math.ceil(model.nodes.length / columns) * (height + 24);
  }
  if (
    model.nodes.length > 4 &&
    model.edges.length === model.nodes.length - 1 &&
    model.edges.every((edge) => edge.kind === "contains" && edge.source === model.nodes[0]?.id)
  ) {
    const columns = 3;
    const scope = model.nodes[0];
    if (scope) {
      const root = graph.node(scope.id);
      root.x = 24 + WIDTH / 2 + WIDTH + 40;
      root.y = 24 + height / 2;
      model.nodes.slice(1).forEach((node, index) => {
        const position = graph.node(node.id);
        position.x = 24 + WIDTH / 2 + (index % columns) * (WIDTH + 40);
        position.y = 24 + height / 2 + 136 + Math.floor(index / columns) * (height + 48);
        const edge = graph.edge({ v: scope.id, w: node.id, name: String(index) });
        const busY = root.y + height / 2 + 28;
        const railX = position.x - WIDTH / 2 - 16;
        edge.points =
          Math.floor(index / columns) === 0
            ? [
                { x: root.x, y: root.y + height / 2 },
                { x: root.x, y: busY },
                { x: position.x, y: busY },
                { x: position.x, y: position.y - height / 2 },
              ]
            : [
                { x: root.x, y: root.y + height / 2 },
                { x: root.x, y: busY },
                { x: railX, y: busY },
                { x: railX, y: position.y - height / 2 - 24 },
                { x: position.x, y: position.y - height / 2 - 24 },
                { x: position.x, y: position.y - height / 2 },
              ];
      });
      graph.graph().width = columns * (WIDTH + 40) + 8;
      graph.graph().height =
        48 + height + 136 + Math.floor((model.nodes.length - 2) / columns) * (height + 48);
    }
  }
  return graph;
}
export function FunctionMapView({
  model,
  language,
  runtime,
  onOpen,
}: {
  model: FunctionMap;
  language: string;
  runtime?: MapRuntime;
  onOpen?: (node: MapNode) => void;
}) {
  const { t } = useTranslation();
  const marker = useId().replace(/:/g, "");
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [flow, setFlow] = useState(false);
  const [color, setColor] = useState("muted-foreground");
  const [lineWidth, setLineWidth] = useState(1.5);
  const [duration, setDuration] = useState(2);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const closeOnSmallScreen = () => {
      if (!media.matches) {
        setSelected(null);
        setAppearanceOpen(false);
      }
    };
    media.addEventListener("change", closeOnSmallScreen);
    return () => media.removeEventListener("change", closeOnSmallScreen);
  }, []);
  const height = model.type === "runtime" ? 112 : 96;
  const graph = useMemo(() => layout(model, height), [model, height]);
  const dimensions = graph.graph();
  const node = model.nodes.find((item) => item.id === selected);
  const observations = new Map(runtime?.observations.map((item) => [item.nodeId, item]));
  const relations = node
    ? model.edges.filter((edge) => edge.source === node.id || edge.target === node.id)
    : [];
  const text = (value: Parameters<typeof mapText>[0]) => mapText(value, language);
  return (
    <section className="function-map" data-map-id={model.id}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{text(model.title)}</h2>
        <div className="flex shrink-0 items-center gap-1">
          {runtime?.refresh ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={runtime.refreshing}
              onClick={runtime.refresh}
            >
              <RefreshCw aria-hidden="true" />
              {t("common.refresh")}
            </Button>
          ) : null}
          <Popover open={appearanceOpen} onOpenChange={setAppearanceOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={t("functionMaps.appearance")}>
                <SlidersHorizontal aria-hidden="true" />
                {t("functionMaps.appearance")}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-72 space-y-4 p-4"
              aria-label={t("functionMaps.appearance")}
            >
              <label className="flex items-center justify-between gap-3 text-sm">
                {t("functionMaps.connection")}
                <NativeSelect
                  aria-label={t("functionMaps.connection")}
                  value={flow ? "flow" : "static"}
                  onChange={(event) => setFlow(event.target.value === "flow")}
                >
                  <option value="static">{t("functionMaps.static")}</option>
                  <option value="flow">{t("functionMaps.flow")}</option>
                </NativeSelect>
              </label>
              <label className="flex items-center justify-between gap-3 text-sm">
                {t("functionMaps.lineColor")}
                <NativeSelect
                  aria-label={t("functionMaps.lineColor")}
                  value={color}
                  onChange={(event) => setColor(event.target.value)}
                >
                  <option value="muted-foreground">{t("functionMaps.neutral")}</option>
                  <option value="brand">{t("functionMaps.brand")}</option>
                  <option value="foreground">{t("functionMaps.contrast")}</option>
                </NativeSelect>
              </label>
              <label className="block space-y-2 text-sm">
                <span className="flex justify-between">
                  {t("functionMaps.lineWidth")}
                  <output>{lineWidth} px</output>
                </span>
                <input
                  className="function-map-range w-full"
                  aria-label={t("functionMaps.lineWidth")}
                  type="range"
                  min="1"
                  max="3"
                  step="0.5"
                  value={lineWidth}
                  onChange={(event) => setLineWidth(Number(event.target.value))}
                />
              </label>
              <label className="block space-y-2 text-sm">
                <span className="flex justify-between">
                  {t("functionMaps.flowDuration")}
                  <output>{duration} s</output>
                </span>
                <input
                  className="function-map-range w-full"
                  aria-label={t("functionMaps.flowDuration")}
                  type="range"
                  min="1"
                  max="5"
                  step="0.5"
                  disabled={!flow}
                  value={duration}
                  onChange={(event) => setDuration(Number(event.target.value))}
                />
              </label>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {runtime && text(runtime.notice) ? (
        <p role="status" className="mb-3 text-sm">
          {text(runtime.notice)}
        </p>
      ) : null}
      {model.nodes.length === 0 ? (
        <p role="status">{t("functionMaps.noData")}</p>
      ) : (
        <section
          className="function-map-canvas"
          data-flow={flow}
          style={
            {
              "--map-line-color": `var(--${color})`,
              "--map-line-width": lineWidth,
              "--map-flow-duration": `${duration}s`,
            } as CSSProperties
          }
          aria-label={t("functionMaps.canvas")}
        >
          <svg
            width={dimensions.width}
            height={dimensions.height}
            style={{ maxWidth: dimensions.width, marginInline: "auto" }}
            viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
            aria-label={text(model.title)}
          >
            <title>{text(model.title)}</title>
            <defs>
              <marker
                id={marker}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--map-line-color)" />
              </marker>
            </defs>
            {model.edges.map((edge, index) => {
              const route = graph.edge({ v: edge.source, w: edge.target, name: String(index) });
              const points = route.points;
              const fallback = points[Math.floor(points.length / 2)];
              const middle: { x: number; y: number } | undefined = fallback
                ? { x: route.x ?? fallback.x, y: route.y ?? fallback.y }
                : undefined;
              if (!middle) return null;
              return (
                <g key={`${edge.source}:${edge.target}:${edge.kind}:${edge.label.zh}`}>
                  <path
                    d={points
                      .map(
                        (point: { x: number; y: number }, i: number) =>
                          `${i ? "L" : "M"}${point.x},${point.y}`,
                      )
                      .join(" ")}
                    className="function-map-connection"
                    fill="none"
                    strokeDasharray={
                      edge.kind === "contains" || edge.kind === "observes" ? "4 4" : undefined
                    }
                    markerEnd={`url(#${marker})`}
                  />
                  {flow ? (
                    <path
                      className="function-map-flow"
                      d={points
                        .map(
                          (point: { x: number; y: number }, i: number) =>
                            `${i ? "L" : "M"}${point.x},${point.y}`,
                        )
                        .join(" ")}
                      fill="none"
                    />
                  ) : null}
                  {edge.kind !== "contains" ? (
                    <foreignObject x={middle.x - 38} y={middle.y - 24} width="76" height="48">
                      <div
                        title={text(edge.label)}
                        className="function-map-edge line-clamp-3 text-center text-[11px] leading-tight"
                      >
                        {text(edge.label)}
                      </div>
                    </foreignObject>
                  ) : null}
                </g>
              );
            })}
            {model.nodes.map((item) => {
              const position = graph.node(item.id);
              const x = position.x - WIDTH / 2;
              const y = position.y - height / 2;
              return (
                <g key={item.id}>
                  <foreignObject x={x} y={y} width={WIDTH} height={height}>
                    <button
                      type="button"
                      className="function-map-node h-full w-full text-left"
                      aria-haspopup="dialog"
                      aria-expanded={selected === item.id}
                      onClick={(event) => {
                        trigger.current = event.currentTarget;
                        setSelected(item.id);
                      }}
                    >
                      <FunctionMapIcon name={item.icon} />
                      <span className="function-map-node-content">
                        {observations.has(item.id) ? (
                          <>
                            <span className="line-clamp-2 text-sm font-semibold leading-tight">
                              {text(item.name)}
                            </span>
                            <ObservationSummary observation={observations.get(item.id)} />
                          </>
                        ) : (
                          <>
                            <span className="block line-clamp-2 text-sm font-semibold leading-tight">
                              {text(item.name)}
                            </span>
                            {item.summary ? (
                              <span className="mt-1 line-clamp-2 text-xs leading-tight text-muted-foreground">
                                {text(item.summary)}
                              </span>
                            ) : null}
                          </>
                        )}
                      </span>
                    </button>
                  </foreignObject>
                </g>
              );
            })}
          </svg>
        </section>
      )}
      <Dialog
        open={!!node}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        {node ? (
          <DialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>{text(node.name)}</DialogTitle>
              <DialogDescription>{text(node.purpose)}</DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
                <dt className="text-muted-foreground">{t("functionMaps.objectType")}</dt>
                <dd>{t(`functionMaps.kinds.${node.kind}`)}</dd>
                {node.prerequisites ? (
                  <>
                    <dt className="text-muted-foreground">{t("functionMaps.preconditions")}</dt>
                    <dd>{text(node.prerequisites)}</dd>
                  </>
                ) : null}
                {node.input ? (
                  <>
                    <dt className="text-muted-foreground">{t("functionMaps.input")}</dt>
                    <dd>{text(node.input)}</dd>
                  </>
                ) : null}
                {node.output ? (
                  <>
                    <dt className="text-muted-foreground">{t("functionMaps.output")}</dt>
                    <dd>{text(node.output)}</dd>
                  </>
                ) : null}
                {node.section.zh ? (
                  <>
                    <dt className="text-muted-foreground">{t("functionMaps.pageSection")}</dt>
                    <dd>{text(node.section)}</dd>
                  </>
                ) : null}
              </dl>
              {observations.get(node.id) ? (
                <ObservationDetails observation={observations.get(node.id)} language={language} />
              ) : null}
              {relations.length ? (
                <ul className="space-y-2 text-sm" aria-label={t("functionMaps.related")}>
                  {relations.map((edge) => (
                    <li key={`${edge.source}:${edge.target}:${edge.kind}:${edge.label.zh}`}>
                      {text(
                        model.nodes.find((item) => item.id === edge.source)?.name ?? {
                          zh: "",
                          en: "",
                        },
                      )}
                      {" → "}
                      {text(
                        model.nodes.find((item) => item.id === edge.target)?.name ?? {
                          zh: "",
                          en: "",
                        },
                      )}
                      {" · "}
                      {text(edge.label)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </DialogBody>
            {onOpen ? (
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSelected(null);
                    onOpen(node);
                  }}
                >
                  <ArrowUpRight aria-hidden="true" />
                  {t("functionMaps.open")}
                </Button>
              </DialogFooter>
            ) : null}
          </DialogContent>
        ) : null}
      </Dialog>
    </section>
  );
}

function ObservationSummary({ observation }: { observation?: MapObservation }) {
  const { t } = useTranslation();
  return (
    <span data-runtime-summary className="mt-1 block space-y-1 text-xs leading-4">
      <span className="block text-muted-foreground">
        {t(`functionMaps.acquisition.${observation?.acquisition ?? "unknown"}`)}
      </span>
      <span
        className={
          observation?.health === "confirmed-fault"
            ? "block font-medium text-status-failed"
            : "block font-medium"
        }
      >
        {t(`functionMaps.healthShort.${observation?.health ?? "unknown"}`)}
      </span>
    </span>
  );
}
function ObservationDetails({
  observation,
  language,
}: {
  observation?: MapObservation;
  language: string;
}) {
  const { t } = useTranslation();
  if (!observation) return null;
  const time = (value: string | null) =>
    value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(language)
      : t("functionMaps.notProvided");
  return (
    <dl className="grid gap-2 break-words text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
      <dt>{t("functionMaps.acquisitionLabel")}</dt>
      <dd>{t(`functionMaps.acquisition.${observation.acquisition}`)}</dd>
      <dt>{t("functionMaps.lifecycle")}</dt>
      <dd>{observation.lifecycle ?? t("functionMaps.notProvided")}</dd>
      <dt>{t("functionMaps.progress")}</dt>
      <dd>{observation.progress ?? t("functionMaps.notProvided")}</dd>
      <dt>{t("functionMaps.health")}</dt>
      <dd>{t(`functionMaps.healthStates.${observation.health ?? "unknown"}`)}</dd>
      <dt>{t("functionMaps.observedAt")}</dt>
      <dd>{time(observation.observedAt)}</dd>
      <dt>{t("functionMaps.fetchedAt")}</dt>
      <dd>{time(observation.fetchedAt)}</dd>
      <dt>{t("functionMaps.source")}</dt>
      <dd className="break-all">{observation.source}</dd>
      <dt>{t("functionMaps.facts")}</dt>
      <dd>{mapText(observation.facts, language)}</dd>
    </dl>
  );
}

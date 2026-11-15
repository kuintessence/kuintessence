import dagre from "@dagrejs/dagre";
import { ArrowUpRight, ChevronDown, RefreshCw } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { FunctionMapIcon } from "./icons";
import {
  type FunctionMap,
  type MapNode,
  type MapObservation,
  type MapRuntime,
  mapText,
} from "./model";
import "./function-maps.css";

const WIDTH = 232;
const HEIGHT = 112;
function layout(model: FunctionMap) {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: "LR", ranksep: 80, nodesep: 40, marginx: 24, marginy: 32 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of model.nodes) graph.setNode(node.id, { width: WIDTH, height: HEIGHT });
  model.edges.forEach((edge, index) => {
    graph.setEdge(edge.source, edge.target, {}, String(index));
  });
  dagre.layout(graph);
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
      root.y = 24 + HEIGHT / 2;
      model.nodes.slice(1).forEach((node, index) => {
        const position = graph.node(node.id);
        position.x = 24 + WIDTH / 2 + (index % columns) * (WIDTH + 40);
        position.y = 24 + HEIGHT / 2 + 176 + Math.floor(index / columns) * (HEIGHT + 48);
        const edge = graph.edge({ v: scope.id, w: node.id, name: String(index) });
        const busY = root.y + HEIGHT / 2 + 28;
        const railX = position.x - WIDTH / 2 - 16;
        edge.points =
          Math.floor(index / columns) === 0
            ? [
                { x: root.x, y: root.y + HEIGHT / 2 },
                { x: root.x, y: busY },
                { x: position.x, y: busY },
                { x: position.x, y: position.y - HEIGHT / 2 },
              ]
            : [
                { x: root.x, y: root.y + HEIGHT / 2 },
                { x: root.x, y: busY },
                { x: railX, y: busY },
                { x: railX, y: position.y - HEIGHT / 2 - 24 },
                { x: position.x, y: position.y - HEIGHT / 2 - 24 },
                { x: position.x, y: position.y - HEIGHT / 2 },
              ];
      });
      graph.graph().width = columns * (WIDTH + 40) + 8;
      graph.graph().height =
        48 + HEIGHT + 176 + Math.floor((model.nodes.length - 2) / columns) * (HEIGHT + 48);
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
  onOpen: (node: MapNode) => void;
}) {
  const { t } = useTranslation();
  const marker = useId().replace(/:/g, "");
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const graph = useMemo(() => layout(model), [model]);
  const dimensions = graph.graph();
  const node = model.nodes.find((item) => item.id === selected);
  const observations = new Map(runtime?.observations.map((item) => [item.nodeId, item]));
  const relations = node
    ? model.edges.filter((edge) => edge.source === node.id || edge.target === node.id)
    : [];
  const text = (value: Parameters<typeof mapText>[0]) => mapText(value, language);
  return (
    <details className="function-map group" open data-map-id={model.id}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm focus-visible:outline-2 focus-visible:outline-ring">
        <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="font-semibold">{text(model.title)}</span>
        <span className="text-muted-foreground">{t(`functionMaps.types.${model.type}`)}</span>
      </summary>
      <p className="mb-3 max-w-prose text-sm text-muted-foreground">{text(model.summary)}</p>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {t(
            model.type === "process"
              ? "functionMaps.template"
              : model.type === "dependency"
                ? "functionMaps.designRelations"
                : "functionMaps.actualSources",
          )}
        </span>
        <div className="flex flex-wrap gap-2">
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
          <Button
            variant="ghost"
            size="sm"
            className="hidden sm:inline-flex"
            aria-pressed={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {t(expanded ? "functionMaps.compact" : "functionMaps.expand")}
          </Button>
        </div>
      </div>
      {runtime ? (
        <p role="status" className="mb-3 text-sm">
          {text(runtime.notice)}
        </p>
      ) : null}
      {model.nodes.length === 0 ? (
        <p role="status">{t("functionMaps.noData")}</p>
      ) : (
        <>
          <section
            className="function-map-canvas hidden overflow-auto overscroll-contain sm:block"
            style={{ maxHeight: expanded ? undefined : 560 }}
            aria-label={t("functionMaps.canvas")}
          >
            <svg
              width={Math.max(dimensions.width ?? 0, WIDTH + 48)}
              height={Math.max(dimensions.height ?? 0, HEIGHT + 64)}
              viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
              style={{
                width: "100%",
                minWidth: Math.ceil((dimensions.width ?? WIDTH) * 0.9),
                maxWidth: dimensions.width,
                height: "auto",
              }}
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
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" />
                </marker>
              </defs>
              {model.edges.map((edge, index) => {
                const points = graph.edge({
                  v: edge.source,
                  w: edge.target,
                  name: String(index),
                }).points;
                const middle = points[Math.floor(points.length / 2)];
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
                      fill="none"
                      stroke="var(--muted-foreground)"
                      strokeWidth="1.25"
                      strokeDasharray={
                        edge.kind === "contains" || edge.kind === "observes" ? "4 4" : undefined
                      }
                      markerEnd={`url(#${marker})`}
                    />
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
                const y = position.y - HEIGHT / 2;
                return (
                  <g key={item.id}>
                    <path
                      d={`M${x},${y} l8,-8 h${WIDTH} v${HEIGHT} l-8,8 z`}
                      fill="var(--muted)"
                      stroke="var(--border)"
                    />
                    <path d={`M${x + WIDTH},${y} l8,-8 v${HEIGHT} l-8,8 z`} fill="var(--border)" />
                    <foreignObject x={x} y={y} width={WIDTH} height={HEIGHT}>
                      <button
                        type="button"
                        className="function-map-node h-full w-full text-left"
                        aria-pressed={selected === item.id}
                        onClick={() => setSelected(item.id)}
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
                              <span className="block text-[11px] text-muted-foreground">
                                {t(
                                  model.type === "process"
                                    ? `functionMaps.symbols.${item.symbol ?? "task"}`
                                    : `functionMaps.kinds.${item.kind}`,
                                )}
                                {item.lane ? ` · ${t(`functionMaps.lanes.${item.lane}`)}` : ""}
                              </span>
                              <span className="mt-1 block text-sm font-semibold">
                                {text(item.name)}
                              </span>
                              <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                                {text(item.purpose)}
                              </span>
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
          <section className="space-y-2 sm:hidden" aria-label={t("functionMaps.mobile")}>
            {model.nodes.map((item) => (
              <button
                key={item.id}
                type="button"
                className="function-map-mobile-node block w-full border-b border-border py-3 text-left focus-visible:outline-2 focus-visible:outline-ring"
                aria-pressed={selected === item.id}
                onClick={() => setSelected(item.id)}
              >
                <FunctionMapIcon name={item.icon} />
                <span className="function-map-node-content">
                  <span className="block text-sm font-medium">{text(item.name)}</span>
                  {observations.has(item.id) ? (
                    <ObservationSummary observation={observations.get(item.id)} />
                  ) : (
                    <span className="block text-xs text-muted-foreground">
                      {text(item.purpose)}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </section>
          <p className="mt-3 text-xs text-muted-foreground">
            {t(
              model.type === "dependency"
                ? "functionMaps.dependencyLegend"
                : model.type === "runtime"
                  ? "functionMaps.runtimeLegend"
                  : "functionMaps.processLegend",
            )}
          </p>
          <details className="mt-3 text-sm" open={model.nodes.length <= 3 || undefined}>
            <summary className="cursor-pointer py-1 focus-visible:outline-2 focus-visible:outline-ring">
              {t("functionMaps.relations")}
            </summary>
            <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
              {model.edges.map((edge) => (
                <li key={`${edge.source}:${edge.target}:${edge.kind}:${edge.label.zh}`}>
                  {text(
                    model.nodes.find((item) => item.id === edge.source)?.name ?? { zh: "", en: "" },
                  )}{" "}
                  →{" "}
                  {text(
                    model.nodes.find((item) => item.id === edge.target)?.name ?? { zh: "", en: "" },
                  )}
                  ：{text(edge.label)} · {t(`functionMaps.relationsKind.${edge.kind}`)} ·{" "}
                  {t(`functionMaps.basis.${edge.basis}`)}
                </li>
              ))}
            </ul>
            {!model.edges.length ? <p>{t("functionMaps.noRelations")}</p> : null}
          </details>
        </>
      )}
      {node ? (
        <section
          className="mt-4 min-w-0 space-y-3 border-t border-border pt-4"
          aria-label={t("functionMaps.explanation")}
          aria-live="polite"
        >
          <h3 className="font-semibold">{text(node.name)}</h3>
          <p className="text-sm">{text(node.purpose)}</p>
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
          {relations.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("functionMaps.noRelations")}</p>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => onOpen(node)}>
            <ArrowUpRight aria-hidden="true" />
            {t("functionMaps.open")}
          </Button>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer py-1 focus-visible:outline-2 focus-visible:outline-ring">
              {t("functionMaps.evidence")}
            </summary>
            <ul className="mt-2 space-y-1">
              {model.sources.map((source) => (
                <li key={source} className="break-all">
                  <code>{source}</code>
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">{t("functionMaps.selectHint")}</p>
      )}
      {model.type === "process" ? (
        <dl className="mt-4 grid gap-1 text-xs text-muted-foreground">
          <dt className="font-medium">{t("functionMaps.roles")}</dt>
          <dd>{text(model.role)}</dd>
          <dt className="mt-1 font-medium">{t("functionMaps.startEnd")}</dt>
          <dd>
            {text(model.start)} → {text(model.end)}
          </dd>
        </dl>
      ) : null}
      {model.caution.zh ? (
        <p className="mt-3 max-w-prose text-xs leading-5 text-muted-foreground">
          {text(model.caution)}
        </p>
      ) : null}
    </details>
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

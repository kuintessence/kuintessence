import {
  type InterconnectCenter,
  type InterconnectSnapshot,
  isObservationStale,
  type MapView,
} from "@kuintessence/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { registerMap } from "echarts";
import ReactECharts from "echarts-for-react";
import { Minus, Plus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "../ThemeProvider";
import { Button } from "../ui/button";
import { clusterSymbol, getStatusLabels, groupNearbyCenters, STATUS_COLORS } from "./model";

type LocatedCenter = InterconnectCenter & {
  metadata: InterconnectCenter["metadata"] & { longitude: number; latitude: number };
};

interface MapAsset {
  type: "FeatureCollection";
  UTF8Encoding?: boolean;
  features: { properties: { name: string; cp?: [number, number] }; [key: string]: unknown }[];
}
interface MapClick {
  data?: { centerIds?: string[]; linkId?: string };
  name?: string;
  componentType?: string;
}
export function InterconnectMap({
  snapshot,
  view,
  onView,
  onCenters,
  onLink,
  onSave,
  saving,
}: {
  snapshot: InterconnectSnapshot;
  view: MapView;
  onView: (v: MapView) => void;
  onCenters: (ids: string[]) => void;
  onLink: (id: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const statusLabels = getStatusLabels(t);
  const chart = useRef<ReactECharts>(null);
  const { resolved } = useTheme();
  const dark = resolved === "dark";
  const [projectionRevision, setProjectionRevision] = useState(0);
  const maps = useQuery({
    queryKey: ["interconnect-maps"],
    staleTime: Infinity,
    queryFn: async () => {
      const values = await Promise.all(
        ["china", "world"].map(async (name) => {
          const response = await fetch(`${import.meta.env.BASE_URL}maps/${name}.json`);
          if (!response.ok) throw new Error(t("interconnect.mapLoadFailed"));
          const asset = (await response.json()) as MapAsset;
          registerMap(`kq-${name}`, JSON.stringify(asset));
          return asset;
        }),
      );
      const [china, world] = values;
      if (!china || !world) throw new Error(t("interconnect.mapIncomplete"));
      return { china, world };
    },
  });
  const provinces =
    maps.data?.china.features.map((f) => f.properties.name).filter((name) => name !== "南海诸岛") ??
    [];
  const mapName = useMemo(() => {
    if (!maps.data) return null;
    if (view.level !== "province") return `kq-${view.level}`;
    const feature = maps.data.china.features.find((f) => f.properties.name === view.region);
    if (!feature) return null;
    const name = `kq-province-${view.region}`;
    registerMap(name, JSON.stringify({ ...maps.data.china, features: [feature] }));
    return name;
  }, [maps.data, view.level, view.region]);
  const located = snapshot.centers.filter(
    (c): c is LocatedCenter => c.metadata.longitude !== null && c.metadata.latitude !== null,
  );
  const visible = located.filter(
    (c) =>
      view.level === "world" ||
      ((c.metadata.country === "中国" ||
        c.metadata.country === "China" ||
        c.metadata.country === "CN") &&
        (view.level !== "province" ||
          c.metadata.province.replace(
            /省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区/g,
            "",
          ) === view.region)),
  );
  // Reproject after zoom or a responsive resize; aggregation uses screen distance, not names.
  const groups = useMemo(() => {
    void projectionRevision;
    const instance = chart.current?.getEchartsInstance();
    // The chart can briefly exist without a model while its responsive canvas is initialized.
    const geo = instance && !instance.isDisposed() ? instance.getOption()?.geo : undefined;
    const ready = Array.isArray(geo) && geo.length > 0;
    const points = visible.map((center) => {
      const position = ready
        ? instance?.convertToPixel({ geoIndex: 0 }, [
            center.metadata.longitude,
            center.metadata.latitude,
          ])
        : undefined;
      return { center, x: position?.[0] ?? Number.NaN, y: position?.[1] ?? Number.NaN };
    });
    return groupNearbyCenters(points);
  }, [visible, projectionRevision]);
  const visibleSingles = new Set(groups.filter((g) => g.length === 1).map((g) => g[0].id));
  const centerById = new Map(located.map((c) => [c.id, c]));
  const option = {
    animation: false,
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      formatter: (p: { name: string }) => p.name,
    },
    geo: {
      map: mapName,
      roam: true,
      center: view.center,
      zoom: view.zoom,
      scaleLimit: { min: 0.5, max: 64 },
      label: { show: false },
      itemStyle: {
        areaColor: dark ? "#25344b" : "#e8edf4",
        borderColor: dark ? "#64748b" : "#94a3b8",
      },
      emphasis: {
        label: { show: true, color: dark ? "#e2e8f0" : "#0f172a" },
        itemStyle: { areaColor: dark ? "#334d74" : "#dbeafe" },
      },
    },
    series: [
      {
        type: "lines",
        coordinateSystem: "geo",
        z: 2,
        data: snapshot.links
          .filter((l) => visibleSingles.has(l.fromCenterId) && visibleSingles.has(l.toCenterId))
          .flatMap((l) => {
            const from = centerById.get(l.fromCenterId);
            const to = centerById.get(l.toCenterId);
            if (!from || !to) return [];
            const stale = isObservationStale(l.metadata.observedAt);
            return [
              {
                name: `${l.metadata.name} · ${statusLabels[l.metadata.status]}${stale ? ` · ${t("interconnect.stale")}` : ""}`,
                linkId: l.id,
                coords: [
                  [from.metadata.longitude, from.metadata.latitude],
                  [to.metadata.longitude, to.metadata.latitude],
                ],
                lineStyle: {
                  color: STATUS_COLORS[stale ? "unknown" : l.metadata.status],
                  width: 3,
                  opacity: 0.85,
                  curveness: 0.12,
                  type: stale ? "dashed" : "solid",
                },
              },
            ];
          }),
      },
      {
        type: "scatter",
        coordinateSystem: "geo",
        z: 3,
        data: groups.map((group) => {
          const aggregate = group.length > 1;
          const center = group[0];
          return {
            name: aggregate
              ? t("interconnect.centerCount", { total: group.length })
              : `${center.metadata.name} · ${statusLabels[center.metadata.status]}`,
            centerIds: group.map((c) => c.id),
            value: [
              group.reduce((n, c) => n + c.metadata.longitude, 0) / group.length,
              group.reduce((n, c) => n + c.metadata.latitude, 0) / group.length,
            ],
            symbol: aggregate ? clusterSymbol(group) : "circle",
            symbolSize: aggregate ? 52 : 16,
            itemStyle: {
              color: STATUS_COLORS[center.metadata.status],
              borderColor: "#fff",
              borderWidth: 2,
            },
            label: {
              show: true,
              position: aggregate ? "inside" : "right",
              formatter: aggregate ? String(group.length) : center.metadata.name,
              color: aggregate || !dark ? "#0f172a" : "#e2e8f0",
              backgroundColor: aggregate ? "transparent" : dark ? "#172033dd" : "#ffffffdd",
              padding: aggregate ? 0 : 3,
              fontSize: 12,
            },
          };
        }),
      },
    ],
  };
  const changeLevel = (level: MapView["level"], region = view.region || provinces[0] || "北京") => {
    const feature = maps.data?.china.features.find((f) => f.properties.name === region);
    onView({
      level,
      region: level === "province" ? region : "",
      center:
        level === "world"
          ? [0, 20]
          : level === "china"
            ? [104, 35]
            : (feature?.properties.cp ?? [104, 35]),
      zoom: 1,
    });
  };
  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-card"
      aria-label={t("interconnect.mapLabel")}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <h2 className="mr-auto font-semibold">{t("interconnect.mapTitle")}</h2>
        <select
          aria-label={t("interconnect.mapLevel")}
          className="rounded-md border border-border bg-background p-2 text-sm"
          value={view.level}
          onChange={(e) => changeLevel(e.target.value as MapView["level"])}
        >
          <option value="world">{t("interconnect.world")}</option>
          <option value="china">{t("interconnect.china")}</option>
          <option value="province">{t("interconnect.provinceLevel")}</option>
        </select>
        {view.level === "province" && (
          <select
            aria-label={t("interconnect.province")}
            className="rounded-md border border-border bg-background p-2 text-sm"
            value={view.region}
            onChange={(e) => changeLevel("province", e.target.value)}
          >
            {provinces.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        )}
        <Button
          variant="outline"
          size="sm"
          aria-label={t("interconnect.zoomOut")}
          onClick={() => onView({ ...view, zoom: Math.max(0.5, view.zoom / 1.5) })}
        >
          <Minus className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label={t("interconnect.zoomIn")}
          onClick={() => onView({ ...view, zoom: Math.min(64, view.zoom * 1.5) })}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button variant="outline" size="sm" disabled={saving} onClick={onSave}>
          {t("interconnect.saveView")}
        </Button>
      </div>
      {maps.error ? (
        <div role="alert" className="p-6">
          {t("interconnect.mapLoadFailed")}{" "}
          <Button onClick={() => void maps.refetch()}>{t("interconnect.retry")}</Button>
        </div>
      ) : !mapName ? (
        <p className="p-6">
          {maps.isPending ? t("interconnect.mapLoading") : t("interconnect.regionMissing")}
        </p>
      ) : (
        <ReactECharts
          ref={chart}
          option={option}
          notMerge
          style={{ height: 440 }}
          onChartReady={() => setProjectionRevision((n) => n + 1)}
          onEvents={{
            georoam: () => {
              const current = chart.current?.getEchartsInstance()?.getOption()?.geo as
                | { center: [number, number]; zoom: number }[]
                | undefined;
              if (current?.[0])
                onView({ ...view, center: current[0].center, zoom: current[0].zoom });
            },
            finished: () => {
              // Recompute grouping after the new projection has actually been painted.
              const instance = chart.current?.getEchartsInstance();
              if (!instance || instance.isDisposed()) return;
              const size = `${instance.getWidth()}:${instance.getHeight()}:${mapName}:${view.center.join(",")}:${view.zoom}`;
              if (chart.current && chart.current.ele?.dataset.mapSize !== size) {
                if (chart.current.ele) chart.current.ele.dataset.mapSize = size;
                setProjectionRevision((n) => n + 1);
              }
            },
            click: (p: MapClick) => {
              if (p.data?.linkId) onLink(p.data.linkId);
              const ids = p.data?.centerIds;
              if (ids) {
                onCenters(ids);
                if (ids.length > 1) {
                  const nodes = located.filter((c) => ids.includes(c.id));
                  if (!nodes.length) return;
                  const province = nodes[0]?.metadata.province.replace(
                    /省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区/g,
                    "",
                  );
                  const enterProvince =
                    view.level !== "province" &&
                    province &&
                    provinces.includes(province) &&
                    nodes.every(
                      (c) =>
                        c.metadata.province === nodes[0]?.metadata.province &&
                        ["中国", "China", "CN"].includes(c.metadata.country),
                    );
                  onView({
                    ...view,
                    level: enterProvince ? "province" : view.level,
                    region: enterProvince ? province : view.region,
                    zoom: enterProvince ? 1 : Math.min(64, view.zoom * 2),
                    center: [
                      nodes.reduce((n, c) => n + c.metadata.longitude, 0) / nodes.length,
                      nodes.reduce((n, c) => n + c.metadata.latitude, 0) / nodes.length,
                    ],
                  });
                }
              }
            },
          }}
        />
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
        {Object.entries(statusLabels).map(([status, label]) => (
          <span key={status} className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: STATUS_COLORS[status as keyof typeof STATUS_COLORS] }}
            />
            {label}
          </span>
        ))}
        <span>{t("interconnect.mapLegend")}</span>
        <button
          type="button"
          className="ml-auto underline"
          onClick={() =>
            onCenters(
              snapshot.centers.filter((c) => c.metadata.longitude === null).map((c) => c.id),
            )
          }
        >
          {t("interconnect.unlocated", { total: snapshot.centers.length - located.length })}
        </button>
      </div>
    </section>
  );
}

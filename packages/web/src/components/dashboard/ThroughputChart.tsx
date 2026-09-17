import ReactECharts from "echarts-for-react";
import { useMemo } from "react";
import type { ThroughputBucket } from "../../lib/dashboard-data";
import { useTheme } from "../ThemeProvider";

export interface ThroughputChartProps {
  data: ThroughputBucket[];
}

function formatHour(iso: string): string {
  const d = new Date(iso);
  const hh = `${d.getHours()}`.padStart(2, "0");
  return `${hh}:00`;
}

export function ThroughputChart({ data }: ThroughputChartProps) {
  const { resolved } = useTheme();
  const isDark = resolved === "dark";

  const option = useMemo(() => {
    const xLabels = data.map((b) => formatHour(b.hour));
    const yValues = data.map((b) => b.count);
    const accent = isDark ? "#7aa3ff" : "#3b6cf2";
    const grid = isDark ? "#2a2f3d" : "#e6e8ee";
    const textColor = isDark ? "#cdd1da" : "#4a5060";

    return {
      grid: { left: 36, right: 16, top: 16, bottom: 28 },
      tooltip: {
        trigger: "axis" as const,
        axisPointer: { type: "line" },
        formatter: (params: Array<{ value: number; axisValueLabel: string }>) => {
          const p = params[0];
          if (!p) return "";
          return `${p.axisValueLabel}<br/>${p.value} job${p.value === 1 ? "" : "s"}`;
        },
      },
      xAxis: {
        type: "category" as const,
        data: xLabels,
        axisLine: { lineStyle: { color: grid } },
        axisLabel: { color: textColor, fontSize: 11 },
      },
      yAxis: {
        type: "value" as const,
        minInterval: 1,
        splitLine: { lineStyle: { color: grid } },
        axisLabel: { color: textColor, fontSize: 11 },
      },
      series: [
        {
          name: "submissions",
          type: "line" as const,
          data: yValues,
          smooth: true,
          showSymbol: false,
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: `${accent}40` },
                { offset: 1, color: `${accent}00` },
              ],
            },
          },
          lineStyle: { color: accent, width: 2 },
        },
      ],
    };
  }, [data, isDark]);

  return (
    <ReactECharts
      data-testid="throughput-chart"
      option={option}
      style={{ height: 220, width: "100%" }}
      notMerge
      lazyUpdate
      theme={isDark ? "dark" : undefined}
    />
  );
}

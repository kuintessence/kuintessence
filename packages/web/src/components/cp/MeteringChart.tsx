import ReactECharts from "echarts-for-react";
import { useMemo } from "react";
import type { MeteringQueryRow } from "../../lib/use-metering-query";
import { useTheme } from "../ThemeProvider";

export interface MeteringChartProps {
  rows: MeteringQueryRow[];
}

const MAX_BARS = 20;

export function MeteringChart({ rows }: MeteringChartProps) {
  const { resolved } = useTheme();
  const isDark = resolved === "dark";

  const option = useMemo(() => {
    const top = rows.slice(0, MAX_BARS);
    const xLabels = top.map((r) => r.groupKey);
    const yValues = top.map((r) => Number((r.cpuCoreSeconds / 3600).toFixed(2)));
    const accent = isDark ? "#7aa3ff" : "#3b6cf2";
    const grid = isDark ? "#2a2f3d" : "#e6e8ee";
    const textColor = isDark ? "#cdd1da" : "#4a5060";

    return {
      grid: { left: 44, right: 16, top: 16, bottom: 48 },
      tooltip: { trigger: "axis" as const, axisPointer: { type: "shadow" } },
      xAxis: {
        type: "category" as const,
        data: xLabels,
        axisLine: { lineStyle: { color: grid } },
        axisLabel: { color: textColor, fontSize: 11, rotate: xLabels.length > 6 ? 30 : 0 },
      },
      yAxis: {
        type: "value" as const,
        splitLine: { lineStyle: { color: grid } },
        axisLabel: { color: textColor, fontSize: 11 },
      },
      series: [
        {
          name: "cpu-core-hours",
          type: "bar" as const,
          data: yValues,
          itemStyle: { color: accent, borderRadius: [3, 3, 0, 0] },
        },
      ],
    };
  }, [rows, isDark]);

  return (
    <ReactECharts
      data-testid="metering-chart"
      option={option}
      style={{ height: 260, width: "100%" }}
      notMerge
      lazyUpdate
      theme={isDark ? "dark" : undefined}
    />
  );
}

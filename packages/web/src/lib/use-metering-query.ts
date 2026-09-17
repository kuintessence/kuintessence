import { useQuery } from "@tanstack/react-query";
import { api } from "./api-client";

export type MeteringPeriod = "raw" | "hourly" | "daily" | "monthly";
export type MeteringGrouping = "user" | "org" | "cluster" | "app";

export interface MeteringQueryRow {
  groupKey: string;
  cpuCoreSeconds: number;
  gpuSeconds: number;
  memoryMbSeconds: number;
  storageMbSeconds: number;
  networkEgressMb: number;
  jobCount: number;
}

export interface MeteringQueryResult {
  rows: MeteringQueryRow[];
  total: number;
}

export interface MeteringParams {
  from: string;
  to: string;
  period: MeteringPeriod;
  grouping: MeteringGrouping;
  orgIds?: string[];
  limit?: number;
}

export function useMeteringQuery(params: MeteringParams, enabled = true) {
  return useQuery<MeteringQueryResult>({
    queryKey: ["metering", "query", params.orgIds?.join(",") ?? "all", params],
    enabled,
    queryFn: () => {
      const qs = new URLSearchParams({
        from: params.from,
        to: params.to,
        period: params.period,
        grouping: params.grouping,
        limit: String(params.limit ?? 200),
      });
      if (params.orgIds?.length) qs.set("orgIds", params.orgIds.join(","));
      return api.get<MeteringQueryResult>(`/metering/query?${qs.toString()}`);
    },
  });
}

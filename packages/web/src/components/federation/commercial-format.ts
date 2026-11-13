import { commercialAutomaticMeters } from "@kuintessence/shared/federation/commercial";
import type { TFunction } from "i18next";

const labels: Record<string, string> = {
  "cpu.time": "cpuTime",
  "cpu.allocated": "cpuAllocated",
  "job.elapsed": "jobElapsed",
};
export function commercialMetric(t: TFunction, metric: string, unit: string) {
  return commercialAutomaticMeters.some((m) => m.metric === metric && m.quantityUnit === unit)
    ? t(`federation.usage.meters.${labels[metric]}`)
    : metric;
}
export function commercialUnit(t: TFunction, metric: string, unit: string) {
  return commercialAutomaticMeters.some((m) => m.metric === metric && m.quantityUnit === unit)
    ? t(`federation.usage.units.${labels[metric]}`)
    : unit;
}

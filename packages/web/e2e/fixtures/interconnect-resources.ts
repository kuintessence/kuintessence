import type { InterconnectSnapshot } from "@kuintessence/shared/browser";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const updatedAt = "2026-11-17T00:00:00.000Z";
export const resources: InterconnectSnapshot = {
  organizations: [
    { id: id(1), name: "北方算力中心" },
    { id: id(2), name: "南方算力中心" },
  ],
  centers: [1, 2].map((n) => ({
    id: id(10 + n),
    orgId: id(n),
    updatedAt,
    metadata: {
      name: n === 1 ? "北京可用区" : "广州可用区",
      country: "中国",
      province: "",
      city: n === 1 ? "北京" : "广州",
      longitude: null,
      latitude: null,
      status: n === 1 ? "operational" : "offline",
    },
  })),
  clusters: [1, 2].map((n) => ({
    id: id(20 + n),
    centerId: id(10 + n),
    updatedAt,
    agentIds: [],
    agents: [],
    software: [],
    jobs24h: { succeeded: 0, failed: 0 },
    metadata: {
      name: n === 1 ? "北京计算集群" : "广州计算集群",
      status: n === 1 ? "operational" : "offline",
      computeTypes: ["CPU"],
      cpuCores: 128,
      storageBytes: null,
      storageTypes: [],
      applications: [],
    },
  })),
  links: [1, 2].map((n) => ({
    id: id(30 + n),
    fromCenterId: id(10 + n),
    toCenterId: id(10 + n),
    updatedAt,
    metadata: {
      name: n === 1 ? "北京高速网络" : "广州专线",
      networkType: n === 1 ? "high-speed" : "dedicated",
      status: "unknown",
      configuredBandwidthMbps: 10000,
      bandwidthMbps: null,
      throughputMbps: null,
      latencyMs: null,
      packetLossPercent: null,
      observedAt: null,
      source: "",
    },
  })),
  agents: [],
  defaultView: null,
  generatedAt: updatedAt,
  canManage: true,
};

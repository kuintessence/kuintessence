import type { MapIconName } from "./icons";

export interface MapText {
  zh: string;
  en: string;
}
export type MapType = "process" | "dependency" | "runtime";
export type ObjectKind = "capability" | "service" | "resource-type" | "instance" | "action";
export type RelationKind =
  | "depends-on"
  | "contains"
  | "belongs-to"
  | "uses"
  | "calls"
  | "deployed-on"
  | "observes"
  | "flow"
  | "evidence"
  | "navigation";
export interface MapNode {
  id: string;
  icon?: MapIconName;
  name: MapText;
  purpose: MapText;
  summary?: MapText;
  kind: ObjectKind;
  route: string;
  section: MapText;
  prerequisites?: MapText;
  input?: MapText;
  output?: MapText;
  lane?: "user" | "system" | "partner";
  symbol?: "task" | "condition" | "wait" | "end";
  capability?: string;
}
export interface MapEdge {
  source: string;
  target: string;
  kind: RelationKind;
  label: MapText;
  basis: "design" | "configuration" | "observation";
}
export interface FunctionMap {
  id: string;
  title: MapText;
  summary: MapText;
  type: MapType;
  host: string;
  placement: string;
  rationale: MapText;
  role: MapText;
  start: MapText;
  end: MapText;
  caution: MapText;
  nodes: MapNode[];
  edges: MapEdge[];
  sources: string[];
}
export type Acquisition =
  | "loading"
  | "ready"
  | "unknown"
  | "no-data"
  | "forbidden"
  | "error"
  | "stale";
export interface MapObservation {
  nodeId: string;
  acquisition: Acquisition;
  lifecycle?: string;
  progress?: string;
  health?: "unknown" | "confirmed-fault" | "reported-ok";
  facts: MapText;
  source: string;
  observedAt: string | null;
  fetchedAt: string | null;
}
export interface MapRuntime {
  nodes?: MapNode[];
  edges?: MapEdge[];
  observations: MapObservation[];
  notice: MapText;
  refresh?: () => void;
  refreshing?: boolean;
}
export function mapText(value: MapText, language: string): string {
  return language.startsWith("zh") ? value.zh : value.en;
}

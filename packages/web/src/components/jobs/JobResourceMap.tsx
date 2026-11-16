import type { PlacementTrace } from "@kuintessence/shared/browser";
import { useTranslation } from "react-i18next";
import { statusLabel } from "../../lib/format";
import { FunctionMapView } from "../function-maps/FunctionMapView";
import type { FunctionMap, MapNode, MapText } from "../function-maps/model";
import type { JobDetail } from "./types";

const bilingual = (zh: string, en = zh): MapText => ({ zh, en });

export function jobResourceMap(job: JobDetail, placement?: PlacementTrace): FunctionMap {
  const unknown = bilingual("未记录", "Not recorded");
  const selectedAgent =
    !placement?.preview &&
    placement?.finalDecision &&
    placement.finalDecision.agentId === job.agentId
      ? placement.finalDecision
      : undefined;
  const site =
    (!placement?.preview ? placement?.federation?.clusterName : undefined) ??
    selectedAgent?.siteName;
  const software = job.softwareRequirements
    ?.map((item) => `${item.name}${item.version ? `@${item.version}` : ""}`)
    .join(" · ");
  const inputs = job.inputStaging?.map((file) => file.stagePath).join("\n");
  const outputs = [
    ...(job.expectedOutputs?.map((file) => file.path) ?? []),
    ...Object.keys(job.collectedOutputs ?? {}),
    ...Object.values(job.federationOutputs ?? {})
      .flat()
      .map((file) => file.fileMetadataName),
  ];
  const resources = [
    job.resources?.cpus === undefined ? null : `${job.resources.cpus} CPU`,
    job.resources?.memoryMb === undefined ? null : `${job.resources.memoryMb} MiB`,
    job.resources?.gpus === undefined ? null : `${job.resources.gpus} GPU`,
    job.resources?.wallTimeSec === undefined ? null : `${job.resources.wallTimeSec} s`,
  ]
    .filter(Boolean)
    .join(" · ");
  const node = (id: string, name: MapText, purpose: MapText, icon: MapNode["icon"]): MapNode => ({
    id,
    name,
    purpose,
    summary: purpose,
    icon,
    kind: "instance",
    route: "",
    section: bilingual(""),
  });
  const nodes = [
    node(
      "job",
      bilingual(job.name),
      bilingual(statusLabel(job.status, "zh"), statusLabel(job.status, "en")),
      "run",
    ),
    node(
      "cluster",
      bilingual("算力中心 / 集群", "Compute center / cluster"),
      bilingual(
        [site ?? unknown.zh, job.agentId, job.node, selectedAgent?.schedulerType]
          .filter(Boolean)
          .join(" · "),
        [site ?? unknown.en, job.agentId, job.node, selectedAgent?.schedulerType]
          .filter(Boolean)
          .join(" · "),
      ),
      "server",
    ),
    node(
      "software",
      bilingual("软件", "Software"),
      software ? bilingual(software) : unknown,
      "package",
    ),
    node(
      "inputs",
      bilingual("输入文件", "Input files"),
      inputs ? bilingual(inputs) : bilingual("无暂存输入文件", "No staged input files"),
      "input",
    ),
    node(
      "resources",
      bilingual("申请资源", "Requested resources"),
      resources ? bilingual(resources) : unknown,
      "boxes",
    ),
    node(
      "outputs",
      bilingual("输出文件", "Output files"),
      outputs.length
        ? bilingual([...new Set(outputs)].join("\n"))
        : bilingual("无记录", "No recorded outputs"),
      "folder",
    ),
  ];
  return {
    id: `job-resources-${job.id}`,
    title: bilingual("作业资源", "Job resources"),
    type: "dependency",
    nodes,
    edges: nodes.slice(1).map((item) => ({
      source: "job",
      target: item.id,
      kind: "contains",
      label: bilingual(""),
      basis: "configuration",
    })),
    summary: bilingual(""),
    host: "/jobs",
    placement: "overview",
    rationale: bilingual(""),
    role: bilingual(""),
    start: bilingual(""),
    end: bilingual(""),
    caution: bilingual(""),
    sources: [],
  };
}

export function JobResourceMap({ job, placement }: { job: JobDetail; placement?: PlacementTrace }) {
  const { i18n } = useTranslation();
  return (
    <FunctionMapView
      model={jobResourceMap(job, placement)}
      language={i18n?.resolvedLanguage ?? i18n?.language ?? "zh"}
    />
  );
}

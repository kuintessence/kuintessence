/**
 * Templates loaded at build time from `examples/workflows/*.yaml` via Vite's `?raw`
 * imports. Adding a YAML to `examples/workflows/` and re-listing it here is enough.
 * All templates follow the canonical workflow schema (WorkflowSchema).
 */
import conditionalSwitch from "../../../../../examples/workflows/conditional-switch.yaml?raw";
import fanoutDag from "../../../../../examples/workflows/fanout-dag.yaml?raw";
import hello from "../../../../../examples/workflows/hello.yaml?raw";
import loopForeach from "../../../../../examples/workflows/loop-foreach.yaml?raw";
import noactionSmoke from "../../../../../examples/workflows/noaction-smoke.yaml?raw";
import paramSweep from "../../../../../examples/workflows/param-sweep.yaml?raw";
import scatterGather from "../../../../../examples/workflows/scatter-gather.yaml?raw";
import subworkflowInline from "../../../../../examples/workflows/subworkflow-inline.yaml?raw";
import twoNodePipeline from "../../../../../examples/workflows/two-node-pipeline.yaml?raw";

export interface WorkflowTemplate {
  slug: string;
  name: string;
  blurb: string;
  yaml: string;
}

export const TEMPLATES: ReadonlyArray<WorkflowTemplate> = [
  {
    slug: "noaction-smoke",
    name: "Smoke test",
    blurb: "Two no-action nodes that validate and complete without compute resources.",
    yaml: noactionSmoke,
  },
  {
    slug: "hello",
    name: "Hello",
    blurb: "Single-node usecase compute: binds its script slot to a constant and runs.",
    yaml: hello,
  },
  {
    slug: "two-node-pipeline",
    name: "Two-node pipeline",
    blurb: "DAG demo: node 'respond' depends on node 'greet' via a node relation.",
    yaml: twoNodePipeline,
  },
  {
    slug: "param-sweep",
    name: "Parameter sweep",
    blurb: "Parameterized run: a workflow 'threshold' param feeds the command via CEL.",
    yaml: paramSweep,
  },
  {
    slug: "fanout-dag",
    name: "Fan-out DAG",
    blurb: "Parallel fan-out: two analyses both depend on one prepare step.",
    yaml: fanoutDag,
  },
  {
    slug: "conditional-switch",
    name: "Conditional switch",
    blurb: "Conditional branch: a Switch routes on a 'mode' param to one of two nodes.",
    yaml: conditionalSwitch,
  },
  {
    slug: "loop-foreach",
    name: "Per-item loop",
    blurb: "Per-item loop: a ForEach Loop runs one usecase node per item of a CEL list.",
    yaml: loopForeach,
  },
  {
    slug: "scatter-gather",
    name: "Scatter-gather",
    blurb: "Scatter-gather: a ForEach Loop collects per-item outputs, a Reduce gathers them.",
    yaml: scatterGather,
  },
  {
    slug: "subworkflow-inline",
    name: "Inline sub-workflow",
    blurb: "Composition: a SubWorkflow node runs a nested inline workflow spec.",
    yaml: subworkflowInline,
  },
];

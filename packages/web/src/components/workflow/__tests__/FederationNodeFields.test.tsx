import { workflowDsl } from "@kuintessence/shared/browser";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import i18n from "../../../lib/i18n";
import {
  type FederationNode,
  FederationNodeFields,
  updateFederationNode,
} from "../FederationNodeFields";

const uuid = "00000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;
const node: FederationNode = {
  id: "federated_step",
  name: "Federated step",
  type: "Federation",
  agreementRevisionId: uuid,
  template: { kind: "workflow", id: uuid, originSiteId: uuid, revision: "1", digest },
  inputManifestDigest: digest,
  environmentLockDigest: digest,
  resources: { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 60 },
  maxAmount: "9007199254740993",
  admissionWindowSec: 600,
  inputDelivery: "media",
  outputs: [{ descriptor: "result", from: { nodeId: "step", descriptor: "output" }, type: "File" }],
};
function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    agreementRevisionId: uuid,
    templateKind: "workflow",
    templateSiteId: uuid,
    templateId: uuid,
    templateRevision: "1",
    templateDigest: digest,
    inputManifestDigest: digest,
    environmentLockDigest: digest,
    maxAmount: node.maxAmount,
    admissionWindowSec: "600",
    cpus: "1",
    memoryMb: "128",
    gpus: "0",
    wallTimeSec: "60",
    inputDelivery: "media",
  }))
    data.set(key, value);
  return data;
}
beforeEach(async () => {
  await i18n.changeLanguage("en");
});
test("market editing keeps private amounts and artifact bindings outside public fields", () => {
  const data = form();
  data.set("marketEnabled", "on");
  data.set("policyId", uuid);
  data.set("title", "Small alignment");
  data.set("description", "Public requirements");
  data.set("arbitrationEnabled", "on");
  data.set("arbitrationPolicyId", uuid);
  data.set("arbitrationPolicyDigest", digest);
  const result = updateFederationNode(node, data);
  expect(result.maxAmount).toBe("9007199254740993");
  expect(result.outputs).toEqual(node.outputs);
  expect(result.inputDelivery).toBe("media");
  expect(result.market).toEqual({
    policyId: uuid,
    title: "Small alignment",
    description: "Public requirements",
  });
  expect(JSON.stringify(result.market)).not.toContain("9007199254740993");
  expect(result.arbitration?.policyDigest).toBe(digest);
  expect(workflowDsl.WorkflowNodeSchema.safeParse(result).success).toBe(true);
});
test("empty resource fields and invalid market policies cannot overwrite a node", () => {
  const data = form();
  data.set("cpus", "");
  expect(() => updateFederationNode(node, data)).toThrow();
  data.set("cpus", "1");
  data.set("marketEnabled", "on");
  data.set("policyId", "bad-id");
  expect(() => updateFederationNode(node, data)).toThrow();
});
test("disabling market and arbitration removes authority without dropping file outputs", () => {
  const result = updateFederationNode(
    {
      ...node,
      market: { policyId: uuid, title: "old", description: "old" },
      arbitration: { policyId: uuid, policyDigest: digest },
    },
    form(),
  );
  expect(result.market).toBeUndefined();
  expect(result.arbitration).toBeUndefined();
  expect(result.outputs).toEqual(node.outputs);
});
test("form applies a validated patch and shows errors before overwriting", () => {
  const patch = vi.fn();
  render(<FederationNodeFields id={node.id} raw={node} onPatch={patch} />);
  fireEvent.change(screen.getByLabelText("Maximum amount (contract base unit)"), {
    target: { value: "1e5" },
  });
  fireEvent.submit(screen.getByTestId("rf-prop-federation"));
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(patch).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Maximum amount (contract base unit)"), {
    target: { value: "9007199254740993" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Input delivery" }), {
    target: { value: "network" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Result delivery" }), {
    target: { value: "media" },
  });
  fireEvent.submit(screen.getByTestId("rf-prop-federation"));
  expect(patch).toHaveBeenCalledWith(node.id, {
    raw: { ...node, inputDelivery: "network", resultDelivery: "media" },
  });
});

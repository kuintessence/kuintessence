import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { workflowDsl } from "@kuintessence/shared";
import { parse } from "yaml";
import { LocalPackageStore } from "./local-package-store";

/**
 * Anti-rot guard for the copy-paste all-in-one example under
 * docs/examples/all-in-one. Parses each shipped fixture through the SAME
 * schemas/parsers `kq tui --local` uses, and asserts the workflow's usecase
 * node resolves to a catalog entry — so a dangling reference or a drifted schema
 * fails CI rather than rotting silently.
 */

const exampleDir = fileURLToPath(new URL("../../../../docs/examples/all-in-one/", import.meta.url));
const read = (rel: string): string => readFileSync(`${exampleDir}${rel}`, "utf8");

describe("docs/examples/all-in-one fixtures", () => {
  test("packages.yaml validates via LocalPackageStore.fromYaml", () => {
    expect(() => LocalPackageStore.fromYaml(read("packages.yaml"))).not.toThrow();
  });

  test("hello.yaml validates and its usecase node resolves to a catalog entry", () => {
    const catalog = parse(read("packages.yaml")) as Record<string, unknown>;
    const wf = workflowDsl.WorkflowSchema.parse(parse(read("workflows/hello.yaml")));

    const sucNodes = wf.spec.nodeDrafts.filter(
      (n): n is Extract<typeof n, { type: "SoftwareUsecaseComputing" }> =>
        n.type === "SoftwareUsecaseComputing",
    );
    expect(sucNodes.length).toBeGreaterThan(0);
    for (const node of sucNodes) {
      const usecaseVersionId = node.usecaseVersionId;
      expect(usecaseVersionId).toBeString();
      if (!usecaseVersionId)
        throw new Error("SoftwareUsecaseComputing node must reference a usecase");
      expect(catalog).toHaveProperty(usecaseVersionId);
    }
  });
});

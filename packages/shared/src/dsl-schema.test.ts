import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { getWorkflowJsonSchema, WORKFLOW_SCHEMA_ID, WORKFLOW_SCHEMA_TITLE } from "./dsl-schema";

const UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("getWorkflowJsonSchema", () => {
  test("stamps the workflow id and title onto the generated schema", () => {
    const s = getWorkflowJsonSchema();
    expect(s.$id).toBe(WORKFLOW_SCHEMA_ID);
    expect(s.title).toBe(WORKFLOW_SCHEMA_TITLE);
    expect(typeof s.$schema).toBe("string");
  });

  test("compiles under ajv 2020 and accepts a known-good workflow", () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(getWorkflowJsonSchema());
    const ok = validate({
      name: "w",
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "a",
            name: "a",
            usecaseVersionId: UUID,
            softwareVersionId: UUID,
          },
        ],
      },
    });
    expect(ok).toBe(true);
  });
});

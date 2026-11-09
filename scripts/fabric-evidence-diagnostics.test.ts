import { expect, test } from "bun:test";
import {
  FabricEvidenceProbeFailureSchema,
  fabricEvidenceProbeFailure,
} from "./fabric-evidence-diagnostics";

test("probe diagnostics preserve recognized error categories and gRPC codes", () => {
  const error = Object.assign(new Error("private proposal"), { name: "EndorseError", code: 14 });
  expect(fabricEvidenceProbeFailure(error)).toEqual({ error: "EndorseError", code: 14 });
  expect(FabricEvidenceProbeFailureSchema.parse(fabricEvidenceProbeFailure(error))).toEqual({
    error: "EndorseError",
    code: 14,
  });
});

test("probe diagnostics never copy arbitrary names, messages, codes or private details", () => {
  for (const error of [
    Object.assign(new Error("private material"), {
      name: "private name",
      code: "private code",
      details: [{ message: "private signature" }],
    }),
    "private text",
    null,
    { name: "unknown", code: 999 },
    { name: "unknown", code: Number.NaN },
  ])
    expect(fabricEvidenceProbeFailure(error)).toEqual({ error: "Error", code: null });
  expect(
    FabricEvidenceProbeFailureSchema.safeParse({ error: "Error", code: null, message: "private" })
      .success,
  ).toBe(false);
});

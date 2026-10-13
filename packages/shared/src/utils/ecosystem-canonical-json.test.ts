import { expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { ecosystemCanonicalJson } from "./ecosystem-canonical-json";

test("ecosystem signatures retain UTF-16 key order and the cross-language Ed25519 golden vector", async () => {
  const vector = await Bun.file(
    new URL("../../../../deploy/offline-delivery/canonical-vector.json", import.meta.url),
  ).json();
  expect(ecosystemCanonicalJson(vector.value)).toBe(vector.canonical);
  expect(Buffer.from(vector.canonical).toString("hex")).toBe(vector.utf8Hex);
  expect(
    verify(
      null,
      Buffer.from(vector.canonical),
      createPublicKey({
        key: Buffer.from(vector.publicKeySpki, "base64"),
        type: "spki",
        format: "der",
      }),
      Buffer.from(vector.signature, "base64"),
    ),
  ).toBe(true);
});

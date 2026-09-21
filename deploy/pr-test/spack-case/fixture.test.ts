import { describe, expect, test } from "bun:test";
import { selectedCase } from "./fixture";

describe("fixed PR material cases", () => {
  test("retains the exact Hello release", () => {
    expect(selectedCase("hello")).toMatchObject({
      name: "hello",
      version: "2.12.1",
      spec: "hello@2.12.1",
      repository: "public/pr-hello-sources",
      recipes: "public/pr-hello-recipes",
    });
  });

  test("pins samtools and separates its release namespace", () => {
    expect(selectedCase("samtools")).toEqual({
      id: "samtools",
      name: "samtools",
      version: "1.19.2",
      spec: "samtools@1.19.2 ^htslib@1.19.1~libcurl~libdeflate ^zlib@1.3.1",
      repository: "public/pr-samtools-sources",
      recipes: "public/pr-samtools-recipes",
      retiredSpec: "samtools@0.0.0",
    });
  });

  test.each(["", "Samtools", "hello;id", "../samtools", "samtools@1.19.2", "toString"])(
    "rejects unsupported selection %s",
    (value) => {
      expect(() => selectedCase(value)).toThrow("Unsupported PR Spack acceptance case");
    },
  );
});

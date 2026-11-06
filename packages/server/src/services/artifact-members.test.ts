import { expect, test } from "bun:test";
import { artifactBatchHash, validateArtifactMembers } from "./artifact-members";

const memberA = { relativePath: "nested/b.dat", sha256: "b".repeat(64), sizeBytes: 2 };
const memberB = { relativePath: "a.dat", sha256: "a".repeat(64), sizeBytes: 1 };
const members = [memberA, memberB];
const fact = {
  ioType: "FileBatch",
  fileMembers: members,
  sizeBytes: 3,
  contentHash: artifactBatchHash(members),
};
test("batch facts preserve and validate each member, including empty batches", () => {
  expect(validateArtifactMembers(fact)?.map((item) => item.relativePath)).toEqual([
    "a.dat",
    "nested/b.dat",
  ]);
  expect(
    validateArtifactMembers({
      ...fact,
      fileMembers: [],
      sizeBytes: 0,
      contentHash: artifactBatchHash([]),
    }),
  ).toEqual([]);
  expect(() => validateArtifactMembers({ ...fact, sizeBytes: 4 })).toThrow("size/hash");
  expect(() => validateArtifactMembers({ ...fact, contentHash: "f".repeat(64) })).toThrow(
    "size/hash",
  );
  expect(() => validateArtifactMembers({ ...fact, fileMembers: null })).toThrow(
    "verified manifest",
  );
});
test("batch facts reject unsafe, duplicate, overlapping, and excessive member paths", () => {
  for (const relativePath of ["../x", "/x", "a//x", "./x", "a\\x", "a\0x", "x/../y"]) {
    expect(() =>
      validateArtifactMembers({ ...fact, fileMembers: [{ ...memberA, relativePath }] }),
    ).toThrow();
  }
  expect(() => validateArtifactMembers({ ...fact, fileMembers: [memberA, memberA] })).toThrow(
    "duplicate",
  );
  expect(() =>
    validateArtifactMembers({
      ...fact,
      fileMembers: [memberA, { ...memberB, relativePath: "nested" }],
    }),
  ).toThrow("overlapping");
  expect(() =>
    validateArtifactMembers({
      ...fact,
      fileMembers: Array.from({ length: 257 }, () => memberA),
    }),
  ).toThrow("256");
});

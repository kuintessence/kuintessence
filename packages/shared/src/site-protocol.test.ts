import { expect, test } from "bun:test";
import { siteProtocolRangeSchema } from "./site-protocol";

test.each([
  { min: 1, max: 1 },
  { min: 2, max: 3 },
])("accepts an explicit inclusive site protocol range: %j", (range) => {
  expect(siteProtocolRangeSchema.parse(range)).toEqual(range);
});

test.each([
  null,
  {},
  { min: 2, max: 1 },
  { min: 0, max: 1 },
  { min: 1, max: 2147483648 },
  { min: 1.5, max: 2 },
  { min: true, max: 2 },
  { min: "1", max: 2 },
  { min: 1, max: 2, skipRevisionCheck: true },
])("rejects malformed or ambiguous site protocol ranges: %j", (range) => {
  expect(siteProtocolRangeSchema.safeParse(range).success).toBe(false);
});

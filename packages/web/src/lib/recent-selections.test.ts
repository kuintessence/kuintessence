import { afterEach, expect, test } from "vitest";
import { readRecentSelections, rememberSelection } from "./recent-selections";

afterEach(() => localStorage.clear());
const scope = { userId: "alice", organizationId: "east", resourceType: "queues" };

test("recent choices are capped, deduplicated and isolated by identity, organization and resource", () => {
  for (let id = 0; id < 7; id++) rememberSelection(scope, String(id));
  rememberSelection(scope, "3");
  expect(readRecentSelections(scope)).toEqual(["3", "6", "5", "4", "2"]);
  expect(readRecentSelections({ ...scope, userId: "bob" })).toEqual([]);
  expect(readRecentSelections({ ...scope, organizationId: "west" })).toEqual([]);
  expect(readRecentSelections({ ...scope, resourceType: "accounts" })).toEqual([]);
});

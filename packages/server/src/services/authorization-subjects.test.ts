import { describe, expect, test } from "bun:test";
import {
  canonicalAuthorizationSubject,
  frozenAuthorizationSubjects,
} from "./authorization-subjects";

describe("canonical authorization subjects", () => {
  test("keeps user and organization identities distinct even when their IDs match", () => {
    expect(frozenAuthorizationSubjects("same-id", "same-id")).toEqual([
      "user:same-id",
      "organization:same-id",
    ]);
  });

  test("rejects unsupported and empty subjects before they can be frozen", () => {
    expect(() => canonicalAuthorizationSubject("team", "team-id")).toThrow(
      "Authorization subject kind is unsupported",
    );
    expect(() => canonicalAuthorizationSubject("user", "")).toThrow(
      "Authorization subject id must not be empty",
    );
  });
});

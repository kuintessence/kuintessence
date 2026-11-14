import { expect, test } from "vitest";
import { isFederationSettings, resolveFederationSection } from "./federation-navigation";

test("legacy entry and workflow media selection retain their destinations", () => {
  expect(resolveFederationSection("")).toBe("agreements");
  expect(resolveFederationSection("", true)).toBe("delivery");
  expect(resolveFederationSection("#market", true)).toBe("market");
  expect(resolveFederationSection("unrecognized")).toBe("agreements");
  expect(isFederationSettings("security/federation-trust")).toBe(true);
  expect(isFederationSettings("security/sso")).toBe(false);
});

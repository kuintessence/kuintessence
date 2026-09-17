import { describe, expect, test } from "vitest";
import { softwareAvailabilityReason } from "./software-availability-reason";

const translate = (key: string) => key;

describe("softwareAvailabilityReason", () => {
  test.each([
    ["asset use permission denied", "software.availabilityReason.usePermission"],
    ["blocked by provider deny list", "software.availabilityReason.providerDenyList"],
    ["principal lacks install permission", "software.availabilityReason.installPermission"],
    [
      "provider policy only allows preinstalled software",
      "software.availabilityReason.preinstalledOnly",
    ],
  ])("maps a recognized availability reason", (reason, expected) => {
    expect(softwareAvailabilityReason(reason, translate)).toBe(expected);
  });

  test("groups lifecycle and license or runtime governance reasons", () => {
    expect(
      softwareAvailabilityReason("asset lifecycle 'retired' blocks scheduling", translate),
    ).toBe("software.availabilityReason.lifecycle");
    expect(
      softwareAvailabilityReason("LICENSE_ACCEPTANCE_REQUIRED: internal detail", translate),
    ).toBe("software.availabilityReason.governance");
    expect(softwareAvailabilityReason("RUNTIME_PROFILE_BLOCKED: internal detail", translate)).toBe(
      "software.availabilityReason.governance",
    );
  });

  test("does not expose an unknown backend reason", () => {
    expect(softwareAvailabilityReason("scheduler stderr: secret diagnostic", translate)).toBe(
      "software.availabilityReason.generic",
    );
  });
});

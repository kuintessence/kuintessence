import { expect, test } from "bun:test";
import { cancelAndConfirmStopped, type KuintessenceJobLookup, type SchedulerAdapter } from "./base";

test.each([
  "confirmed",
  "running",
  "unavailable",
  "unsupported",
] as const)("%s cancellation requires positive stop evidence and preserves lookup scope", async (outcome) => {
  const scope = { jobId: "original", namespace: "tenant" };
  const adapter: SchedulerAdapter = {
    type: "test",
    version: "1",
    submit: async () => ({ schedulerJobId: "original" }),
    status: async () => ({ status: "completed" }),
    cancel: async (id, lookup) => {
      expect(id).toBe("original");
      expect(lookup).toEqual(scope);
      throw new Error("cancellation response lost");
    },
    ...(outcome === "unsupported"
      ? {}
      : {
          confirmStopped: async (id: string, lookup?: KuintessenceJobLookup) => {
            expect(id).toBe("original");
            expect(lookup).toEqual(scope);
            if (outcome === "unavailable") throw new Error("scheduler unavailable");
            return outcome === "confirmed";
          },
        }),
  };
  const result = cancelAndConfirmStopped(adapter, "original", scope);
  if (outcome === "confirmed") await expect(result).resolves.toBeUndefined();
  else await expect(result).rejects.toThrow("stop is not confirmed");
});

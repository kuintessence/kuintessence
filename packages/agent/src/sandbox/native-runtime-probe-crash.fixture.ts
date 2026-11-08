import { runNativeRuntimeProbe } from "./native-runtime-probe";

const [root, mode] = process.argv.slice(2);
if (!root || !["response-lost", "submitted"].includes(mode ?? ""))
  throw new Error("Invalid probe crash fixture");
await runNativeRuntimeProbe({
  root,
  queue: "sandbox",
  script: "true",
  adapter: () => ({
    type: "slurm",
    version: "test",
    submit: async (spec) => {
      if (mode === "response-lost") {
        console.log(JSON.stringify({ jobId: spec.jobId }));
        await Bun.sleep(60_000);
      }
      return { schedulerJobId: "123" };
    },
    status: async () => {
      console.log("submitted");
      await Bun.sleep(60_000);
      return { status: "running" };
    },
    cancel: async () => {
      throw new Error("Killed process must not run cleanup");
    },
  }),
});

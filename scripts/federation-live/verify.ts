import assert from "node:assert/strict";
import { join } from "node:path";
import { startAdapters } from "./adapters";

export async function verifyLiveExecution(
  root: string,
  controls: {
    stopOrderer(): Promise<void>;
    startOrderer(): Promise<void>;
    onCleanup(fn: () => Promise<void>): void;
  },
) {
  assert.equal(
    process.env.KQ_FEDERATION_EXECUTION_LAB,
    "1",
    "Explicit disposable local k3s opt-in required",
  );
  const cleanup = await startAdapters(root);
  controls.onCleanup(cleanup);
  const selection = process.env.KQ_FEDERATION_LAB_SCENARIO ?? "both";
  assert(["success", "outage", "both"].includes(selection));
  for (const scenario of selection === "both" ? ["success", "outage"] : [selection]) {
    const child = Bun.spawn(["python3", join(import.meta.dir, "run.py")], {
      env: { ...process.env, LAB_FABRIC_ROOT: root, LAB_SCENARIO: scenario },
      stdout: "inherit",
      stderr: "inherit",
    });
    const stop = async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
        try {
          await child.exited;
        } finally {
          clearTimeout(timer);
        }
      }
    };
    controls.onCleanup(stop);
    let stopped = false;
    const deadline = Date.now() + 1200000;
    try {
      while (child.exitCode === null) {
        assert(Date.now() < deadline, "Execution lab deadline exceeded");
        for (const action of ["stop", "start"] as const) {
          const request = Bun.file(join(root, `execution-orderer-${action}`));
          const ack = Bun.file(join(root, `execution-orderer-${action}.ack`));
          if ((await request.exists()) && !(await ack.exists())) {
            if (action === "stop") {
              await controls.stopOrderer();
              stopped = true;
            } else {
              await controls.startOrderer();
              stopped = false;
            }
            await Bun.write(ack, action);
          }
        }
        await Bun.sleep(300);
      }
      assert.equal(await child.exited, 0, `Real coordinated execution ${scenario} failed`);
    } finally {
      await stop();
      if (stopped) await controls.startOrderer();
    }
  }
}

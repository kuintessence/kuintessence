import assert from "node:assert/strict";
import { join } from "node:path";
import { startAdapters } from "./adapters";

export async function verifyLiveArbitration(
  root: string,
  controls: {
    stopOrderer(): Promise<void>;
    startOrderer(): Promise<void>;
    onCleanup(fn: () => Promise<void>): void;
  },
) {
  const adapters = await startAdapters(root);
  controls.onCleanup(adapters.cleanup);
  const child = Bun.spawn(["python3", join(import.meta.dir, "arbitration.py")], {
    env: { ...process.env, LAB_FABRIC_ROOT: root, PYTHONDONTWRITEBYTECODE: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    try {
      await child.exited;
    } finally {
      clearTimeout(timer);
    }
  };
  controls.onCleanup(stop);
  const deadline = Date.now() + 600000;
  let ordererStopped = false;
  try {
    while (child.exitCode === null) {
      assert(Date.now() < deadline, "Three Server arbitration deadline exceeded");
      const request = Bun.file(join(root, "arbitration-control.json")),
        ack = Bun.file(join(root, "arbitration-control.ack"));
      if (await request.exists()) {
        const value: { id: string; action: string } = await request.json();
        const prior = (await ack.exists()) ? await ack.json() : null;
        if (prior?.id !== value.id) {
          let restarts: unknown;
          if (value.action === "stop") {
            await controls.stopOrderer();
            ordererStopped = true;
          } else if (value.action === "start") {
            await controls.startOrderer();
            ordererStopped = false;
          } else {
            assert.equal(value.action, "restart");
            restarts = await adapters.restart();
          }
          await Bun.write(ack, JSON.stringify({ id: value.id, restarts }));
        }
      }
      await Bun.sleep(200);
    }
    assert.equal(
      await child.exited,
      0,
      "Three Server arbitration recovery failed; inspect private artifacts",
    );
  } finally {
    await stop();
    if (ordererStopped) await controls.startOrderer();
  }
}

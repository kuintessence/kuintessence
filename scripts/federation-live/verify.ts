import assert from "node:assert/strict";
import { join } from "node:path";
import { startAdapters } from "./adapters";
import { ExecutionFixtureSchema } from "./fixture";

export async function verifyLiveExecution(
  root: string,
  controls: {
    stopOrderer(): Promise<void>;
    startOrderer(): Promise<void>;
    onCleanup(fn: () => Promise<void>): void;
  },
  cases = false,
) {
  assert.equal(
    process.env.KQ_FEDERATION_EXECUTION_LAB,
    "1",
    "Explicit disposable local k3s opt-in required",
  );
  const attested = !cases && process.env.KQ_FEDERATION_LAB_MODE === "bilateral_attested";
  const selection = cases
    ? "success"
    : (process.env.KQ_FEDERATION_LAB_SCENARIO ?? (attested ? "success" : "both"));
  const nativeDispute = process.env.KQ_FEDERATION_LAB_DISPUTE === "1";
  assert(!nativeDispute || (!attested && ["success", "workflow"].includes(selection)));
  const network = await Bun.file(join(root, "network.json")).json();
  await Bun.write(
    join(root, "execution-fixture.json"),
    JSON.stringify(
      ExecutionFixtureSchema.parse({
        domainId: network.trust.domains[0].domainId,
        consideration: ["success", "workflow", "both"].includes(selection) ? "paid" : "exchange",
        sites: network.sites.filter((site: { name: string }) => ["A", "B"].includes(site.name)),
      }),
    ),
  );
  const adapters = await startAdapters(root, attested, cases);
  controls.onCleanup(adapters.cleanup);
  assert(
    attested
      ? ["success", "refund", "refund-auto"].includes(selection)
      : !["refund", "refund-auto"].includes(selection),
    "Refund acceptance requires bilateral cooperation",
  );
  assert(
    ["success", "outage", "stop", "workflow", "refund", "refund-auto", "both"].includes(selection),
  );
  for (const scenario of selection === "both" ? ["success", "outage"] : [selection]) {
    const child = Bun.spawn(["python3", join(import.meta.dir, "run.py")], {
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        LAB_FABRIC_ROOT: root,
        LAB_FIXTURE_ROOT: root,
        LAB_MODE: cases
          ? "bilateral_direct"
          : attested
            ? "bilateral_attested"
            : "ledger_coordinated",
        ...(cases ? { KQ_FEDERATION_LAB_CASES: "1", KQ_FEDERATION_LAB_DISCLOSURE: "1" } : {}),
        LAB_SCENARIO: scenario,
      },
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
          const requestId = (await request.exists()) ? await request.text() : null;
          if (requestId && (!(await ack.exists()) || (await ack.text()) !== requestId)) {
            if (action === "stop") {
              await controls.stopOrderer();
              stopped = true;
            } else {
              await controls.startOrderer();
              stopped = false;
            }
            await Bun.write(ack, requestId);
          }
        }
        const restartRequest = Bun.file(
          join(root, cases ? "execution-case-restart" : "execution-commercial-restart"),
        );
        const restartAck = Bun.file(
          join(root, cases ? "execution-case-restart.ack" : "execution-commercial-restart.ack"),
        );
        if (await restartRequest.exists()) {
          const requestId = await restartRequest.text();
          const prior = (await restartAck.exists()) ? await restartAck.json() : null;
          if (prior?.requestId !== requestId)
            await Bun.write(
              restartAck,
              JSON.stringify({ requestId, restarts: await adapters.restart() }),
            );
        }
        await Bun.sleep(300);
      }
      assert.equal(
        await child.exited,
        0,
        `Real ${cases ? "case" : attested ? "attested" : "coordinated"} execution ${scenario} failed`,
      );
      if (!cases && ["success", "workflow", "refund", "refund-auto"].includes(scenario)) {
        const checks = nativeDispute
          ? [
              { file: "settlement-proof.ts", records: ["settlement"] },
              { file: "freeze-proof.ts", records: ["freeze"] },
            ]
          : [
              {
                file: attested ? "attested-proof.ts" : "settlement-proof.ts",
                records: attested
                  ? ["attested"]
                  : ["settlement", "adjustment-1", "adjustment-2", "payment-1", "payment-2"],
              },
            ];
        for (const check of checks) {
          const build = await Bun.build({
            entrypoints: [join(import.meta.dir, check.file)],
            target: "node",
            format: "esm",
            external: [
              "@hyperledger/fabric-gateway",
              "@hyperledger/fabric-protos",
              "@grpc/grpc-js",
            ],
          });
          assert(build.success && build.outputs[0]);
          const entry = join(root, `live-${check.file}.mjs`);
          await Bun.write(entry, await build.outputs[0].text());
          for (const record of check.records) {
            const probe = Bun.spawn(["node", entry, root, record], {
              stdout: "inherit",
              stderr: "inherit",
            });
            try {
              assert.equal(await probe.exited, 0, "Real settlement private ledger proof failed");
            } finally {
              if (probe.exitCode === null) probe.kill("SIGTERM");
            }
          }
        }
      }
    } finally {
      await stop();
      if (stopped) await controls.startOrderer();
    }
  }
}

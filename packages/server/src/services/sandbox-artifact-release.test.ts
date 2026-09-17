import { describe, expect, test } from "bun:test";
import type { AgentDispatcher } from "../grpc/dispatcher";
import { SandboxArtifactReleaseService } from "./sandbox-artifact-release";

describe("SandboxArtifactReleaseService", () => {
  test("marks a replica releasable only after the matching Agent acknowledgement", async () => {
    let requestId = "";
    const dispatcher = {
      pushSandboxArtifactRelease: (_agentId: string, id: string) => {
        requestId = id;
        return true;
      },
    } as unknown as AgentDispatcher;
    const service = new SandboxArtifactReleaseService(dispatcher, 1_000);
    const released = service.release({ id: "replica-1", agentId: "agent-1", storageRef: "/x" });
    expect(
      service.resolve({
        requestId,
        releasedReplicaIds: ["replica-1"],
        failures: {},
      }),
    ).toBe(true);
    await expect(released).resolves.toBeUndefined();
  });

  test("retries later when the Agent is offline or reports a failure", async () => {
    const offline = {
      pushSandboxArtifactRelease: () => false,
    } as unknown as AgentDispatcher;
    await expect(
      new SandboxArtifactReleaseService(offline).release({
        id: "replica-1",
        agentId: "agent-1",
        storageRef: "/x",
      }),
    ).rejects.toThrow("offline");
  });
});

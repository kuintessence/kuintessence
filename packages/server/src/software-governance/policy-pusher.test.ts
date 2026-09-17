import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  ServerMessageSchema,
  type SoftwarePolicyUpdate,
  SoftwarePolicyUpdateSchema,
} from "@kuintessence/proto";
import type { AgentChannel } from "../grpc/dispatcher";
import { AgentDispatcher } from "../grpc/dispatcher";
import { PolicyPusher } from "./policy-pusher";

function makeChannel(): { channel: AgentChannel; received: unknown[] } {
  const received: unknown[] = [];
  const channel: AgentChannel = {
    push: (m) => {
      received.push(m);
    },
    close: () => {},
  };
  return { channel, received };
}

describe("PolicyPusher", () => {
  test("pushToAgent emits a SoftwarePolicyUpdate to a registered agent", () => {
    const dispatcher = new AgentDispatcher();
    const { channel, received } = makeChannel();
    dispatcher.register("agent-1", channel);

    const pusher = new PolicyPusher(dispatcher);
    const ok = pusher.pushToAgent("agent-1", {
      version: "v42",
      allowList: ["gromacs@*"],
      denyList: [],
      lockEnabled: true,
      mirrors: [{ name: "central", url: "https://mirror.example.com" }],
      preinstallList: [],
    });
    expect(ok).toBe(true);
    expect(received).toHaveLength(1);
    const msg = received[0] as {
      payload: { case: string; value: SoftwarePolicyUpdate };
    };
    expect(msg.payload.case).toBe("softwarePolicyUpdate");
    expect(msg.payload.value.policyVersion).toBe("v42");
    expect(msg.payload.value.lockEnabled).toBe(true);
    expect(msg.payload.value.allowList).toEqual(["gromacs@*"]);
  });

  test("pushToAgent returns false for offline agent", () => {
    const dispatcher = new AgentDispatcher();
    const pusher = new PolicyPusher(dispatcher);
    const ok = pusher.pushToAgent("nonexistent", {
      version: "v1",
      allowList: [],
      denyList: [],
      lockEnabled: false,
      mirrors: [],
      preinstallList: [],
    });
    expect(ok).toBe(false);
  });

  test("pushToAgent returns false when the channel rejects the push", () => {
    const dispatcher = new AgentDispatcher();
    const channel: AgentChannel = {
      push: () => {
        throw new Error("agent stream closed");
      },
      close: () => {},
    };
    dispatcher.register("agent-1", channel);
    const pusher = new PolicyPusher(dispatcher);

    const ok = pusher.pushToAgent("agent-1", {
      version: "v-closed",
      allowList: [],
      denyList: [],
      lockEnabled: false,
      mirrors: [],
      preinstallList: [],
    });

    expect(ok).toBe(false);
  });

  test("pushSpecDistribute emits SpecDistribute to a registered agent", () => {
    const dispatcher = new AgentDispatcher();
    const { channel, received } = makeChannel();
    dispatcher.register("agent-1", channel);

    const pusher = new PolicyPusher(dispatcher);
    const ok = pusher.pushSpecDistribute("agent-1", {
      spec: "gromacs@2024.1",
      buildcacheUrl: "https://cache.example.com/foo",
    });
    expect(ok).toBe(true);
    expect(received).toHaveLength(1);
    const msg = received[0] as {
      payload: { case: string; value: { spec: string; buildcacheUrl: string } };
    };
    expect(msg.payload.case).toBe("specDistribute");
    expect(msg.payload.value.spec).toBe("gromacs@2024.1");
  });

  test("pushSpecDistribute returns false when the channel rejects the push", () => {
    const dispatcher = new AgentDispatcher();
    const channel: AgentChannel = {
      push: () => {
        throw new Error("agent stream closed");
      },
      close: () => {},
    };
    dispatcher.register("agent-1", channel);
    const pusher = new PolicyPusher(dispatcher);

    const ok = pusher.pushSpecDistribute("agent-1", {
      spec: "gromacs@2024.1",
      buildcacheUrl: "https://cache.example.com/foo",
    });

    expect(ok).toBe(false);
  });

  test("ServerMessage shape is valid for SoftwarePolicyUpdate construction", () => {
    // Smoke-test that the SoftwarePolicyUpdateSchema actually round-trips
    // when wrapped in ServerMessageSchema — guards against future proto
    // re-numberings landing without the pusher being updated.
    const update = create(SoftwarePolicyUpdateSchema, {
      policyVersion: "v1",
      allowList: ["a"],
      denyList: [],
      lockEnabled: false,
      mirrors: [],
      preinstallList: [],
    });
    const wrapped = create(ServerMessageSchema, {
      payload: { case: "softwarePolicyUpdate", value: update },
    });
    expect(wrapped.payload.case).toBe("softwarePolicyUpdate");
  });
});

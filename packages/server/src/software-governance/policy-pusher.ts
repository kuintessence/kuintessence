import { create } from "@bufbuild/protobuf";
import {
  MirrorSpecSchema,
  ServerMessageSchema,
  SoftwarePolicyUpdateSchema,
  SpecDistributeSchema,
} from "@kuintessence/proto";
import { createLogger } from "@kuintessence/shared";
import type { AgentDispatcher } from "../grpc/dispatcher";

const logger = createLogger("software-policy-pusher");

export interface PolicyPushPayload {
  version: string;
  allowList: string[];
  denyList: string[];
  lockEnabled: boolean;
  mirrors: Array<{ name: string; url: string; priority?: number }>;
  preinstallList: string[];
}

export interface SpecDistributePayload {
  spec: string;
  buildcacheUrl: string;
  signKeyId?: string;
}

/**
 * bridges the Server-side policy store to the Agent connectRPC
 * stream. The actual fan-out is delegated to `AgentDispatcher`; the
 * pusher's only job is to encode the proto message correctly and pick
 * the right channel.
 *
 * Multi-agent push is a thin loop on top of `pushToAgent`; the dispatcher
 * tracks online agents so we don't waste a round-trip on offline ones.
 *
 * Idempotency: the agent enforces it (see SpackManager.applyPolicy
 * version-compare). The pusher cooperates by always emitting the policy
 * version on every push, so a re-pushed identical version is a Server→Agent
 * no-op end-to-end.
 */
export class PolicyPusher {
  constructor(private readonly dispatcher: AgentDispatcher) {}

  pushToAgent(agentId: string, payload: PolicyPushPayload): boolean {
    if (!this.dispatcher.isOnline(agentId)) return false;
    const update = create(SoftwarePolicyUpdateSchema, {
      policyVersion: payload.version,
      allowList: payload.allowList,
      denyList: payload.denyList,
      lockEnabled: payload.lockEnabled,
      mirrors: payload.mirrors.map((m) =>
        create(MirrorSpecSchema, {
          name: m.name,
          url: m.url,
          priority: m.priority ?? 0,
        }),
      ),
      preinstallList: payload.preinstallList,
    });
    return this.pushServerMessage(agentId, "softwarePolicyUpdate", update);
  }

  pushSpecDistribute(agentId: string, payload: SpecDistributePayload): boolean {
    if (!this.dispatcher.isOnline(agentId)) return false;
    const distribute = create(SpecDistributeSchema, {
      spec: payload.spec,
      buildcacheUrl: payload.buildcacheUrl,
      signKeyId: payload.signKeyId,
    });
    return this.pushServerMessage(agentId, "specDistribute", distribute);
  }

  /**
   * Internal helper: wrap a payload in a ServerMessage and push via the
   * dispatcher. Reaches into the dispatcher's per-agent channel via a
   * thin façade so we don't have to expose the channel map publicly.
   */
  private pushServerMessage(
    agentId: string,
    caseName: "softwarePolicyUpdate" | "specDistribute",
    value: unknown,
  ): boolean {
    const channel = this.dispatcher.getChannel(agentId);
    if (!channel) return false;
    const msg = create(ServerMessageSchema, {
      payload: { case: caseName, value } as never,
    });
    try {
      channel.push(msg);
    } catch (err) {
      logger.warn({ err, agentId, caseName }, "Failed to push software policy message");
      return false;
    }
    return true;
  }
}

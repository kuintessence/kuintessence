import { randomUUID } from "node:crypto";
import type { AgentDispatcher } from "../grpc/dispatcher";

interface PendingRelease {
  replicaId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SandboxArtifactReleaseService {
  private readonly pending = new Map<string, PendingRelease>();

  constructor(
    private readonly dispatcher: AgentDispatcher,
    private readonly timeoutMs = 30_000,
  ) {}

  release(replica: { id: string; agentId: string; storageRef: string }): Promise<void> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Sandbox artifact release acknowledgement timed out"));
      }, this.timeoutMs);
      this.pending.set(requestId, { replicaId: replica.id, resolve, reject, timer });
      const pushed = this.dispatcher.pushSandboxArtifactRelease(replica.agentId, requestId, [
        { replicaId: replica.id, storageRef: replica.storageRef },
      ]);
      if (!pushed) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error("Sandbox artifact Agent is offline"));
      }
    });
  }

  resolve(input: {
    requestId: string;
    releasedReplicaIds: readonly string[];
    failures: Readonly<Record<string, string>>;
  }): boolean {
    const pending = this.pending.get(input.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(input.requestId);
    const failure = input.failures[pending.replicaId];
    if (failure) {
      pending.reject(new Error(failure));
    } else if (!input.releasedReplicaIds.includes(pending.replicaId)) {
      pending.reject(new Error("Sandbox artifact release acknowledgement was incomplete"));
    } else {
      pending.resolve();
    }
    return true;
  }
}

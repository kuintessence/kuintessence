export interface TransferProgressEvent {
  copiedBytes: number;
  state: "running" | "succeeded" | "failed";
  error?: string;
  sha256?: string;
  parts?: { partNumber: number; etag: string }[];
  netdriveFileIds?: string[];
}

export type TransferProgressListener = (e: TransferProgressEvent) => void;

interface PendingEntry {
  agentId?: string;
  cancelAck?: PromiseWithResolvers<boolean>;
  listener: TransferProgressListener;
  timer: ReturnType<typeof setTimeout>;
}

export class TransferRegistry {
  private pending = new Map<string, PendingEntry>();

  register(
    requestId: string,
    listener: TransferProgressListener,
    timeoutMs: number,
    agentId?: string,
  ): void {
    const previous = this.pending.get(requestId);
    if (previous) {
      previous.cancelAck?.resolve(false);
      clearTimeout(previous.timer);
    }
    const entry: PendingEntry = {
      agentId,
      listener,
      timer: setTimeout(() => {
        if (this.pending.get(requestId) !== entry) return;
        this.pending.delete(requestId);
        entry.cancelAck?.resolve(false);
        entry.listener({
          copiedBytes: 0,
          state: "failed",
          error: `transfer ${requestId} timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs),
    };
    this.pending.set(requestId, entry);
  }

  update(requestId: string, event: TransferProgressEvent, agentId?: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || (agentId && entry.agentId && agentId !== entry.agentId)) return false;
    if (event.state !== "running") entry.cancelAck?.resolve(false);
    entry.listener(event);
    if (event.state !== "running" && this.pending.get(requestId) === entry) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
    }
    return true;
  }

  async requestCancellation(requestId: string, send: () => boolean): Promise<boolean> {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    if (entry.cancelAck) return entry.cancelAck.promise;
    const ack = Promise.withResolvers<boolean>();
    entry.cancelAck = ack;
    try {
      if (!send()) throw new Error("Transfer cancellation channel unavailable");
      return await ack.promise;
    } finally {
      if (entry.cancelAck === ack) delete entry.cancelAck;
    }
  }

  confirmCancellation(requestId: string, agentId: string) {
    const entry = this.pending.get(requestId);
    if (!entry || entry.agentId !== agentId || !entry.cancelAck) return;
    entry.cancelAck.resolve(true);
    delete entry.cancelAck;
    this.cancel(requestId);
  }

  cancel(requestId: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.cancelAck?.resolve(false);
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    return true;
  }
}

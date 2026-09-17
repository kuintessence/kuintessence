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
  listener: TransferProgressListener;
  timer: ReturnType<typeof setTimeout>;
}

export class TransferRegistry {
  private pending = new Map<string, PendingEntry>();

  register(requestId: string, listener: TransferProgressListener, timeoutMs: number): void {
    const timer = setTimeout(() => {
      const entry = this.pending.get(requestId);
      if (!entry) return;
      this.pending.delete(requestId);
      entry.listener({
        copiedBytes: 0,
        state: "failed",
        error: `transfer ${requestId} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    this.pending.set(requestId, { listener, timer });
  }

  update(requestId: string, event: TransferProgressEvent): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.listener(event);
    if (event.state !== "running") {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
    }
    return true;
  }

  cancel(requestId: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    return true;
  }
}

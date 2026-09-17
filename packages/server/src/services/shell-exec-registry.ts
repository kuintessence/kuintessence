export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error: string;
}

interface PendingEntry {
  resolve: (r: ShellExecResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ShellExecRegistry {
  private pending = new Map<string, PendingEntry>();

  await(requestId: string, timeoutMs: number): Promise<ShellExecResult> {
    return new Promise<ShellExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          reject(new Error(`shell exec ${requestId} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  resolve(requestId: string, result: ShellExecResult): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(result);
    return true;
  }

  discard(requestId: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    return true;
  }
}

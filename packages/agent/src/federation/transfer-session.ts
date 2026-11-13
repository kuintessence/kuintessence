/** Both input and result clients share this Agent's bounded transfer slot. */
export class FederationTransferSlot {
  private busy = false;
  acquire(): (() => void) | undefined {
    if (this.busy) return undefined;
    this.busy = true;
    return () => {
      this.busy = false;
    };
  }
}

interface TransferGrantRequest {
  requestId: string;
  bindingJson?: string;
  upload?: boolean;
  partNumber?: number;
  verificationJson?: string;
}
interface TransferGrantResponse {
  requestId: string;
  grantJson: string;
  leaseExpiresAtUnixMs: bigint;
}
interface TransferReport {
  generation: string;
  failed?: boolean;
  copiedJson?: string;
  verifiedJson?: string;
}

/** Transient credentials and I/O stop with the connection; Server attempts retain cleanup ownership. */
export class FederationTransferSession {
  private active?: { generation: string; controller: AbortController; done: Promise<void> };
  private readonly pending = new Map<string, (response: TransferGrantResponse) => void>();
  constructor(
    private readonly sendGrant: (request: TransferGrantRequest) => boolean,
    private readonly sendReport: (report: TransferReport) => void,
    private readonly slot: FederationTransferSlot,
  ) {}
  hasPending(id: string) {
    return this.pending.has(id);
  }
  receive(response: TransferGrantResponse) {
    this.pending.get(response.requestId)?.(response);
  }
  disconnect() {
    this.active?.controller.abort();
    return this.active?.done;
  }
  run(
    generation: string,
    availableUntil: string,
    deadline: bigint,
    work: (
      signal: AbortSignal,
      lease: (until: bigint) => void,
    ) => Promise<{ copiedJson?: string; verifiedJson?: string }>,
  ) {
    if (this.active?.generation === generation) return;
    const failed = () => this.sendReport({ generation, failed: true });
    const release = this.slot.acquire();
    if (!release) {
      failed();
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lease = (until: bigint) => {
      const expires = Number(until);
      if (
        !Number.isSafeInteger(expires) ||
        expires <= Date.now() ||
        expires > Date.now() + 120_000 ||
        expires > Date.parse(availableUntil)
      )
        throw new Error("INVALID_LEASE");
      controller.signal.throwIfAborted();
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), expires - Date.now());
    };
    try {
      lease(deadline);
    } catch {
      release();
      failed();
      return;
    }
    const done = Promise.resolve().then(async () => {
      try {
        const receipt = await work(controller.signal, lease);
        controller.signal.throwIfAborted();
        this.sendReport({ generation, ...receipt });
      } catch {
        failed();
      } finally {
        clearTimeout(timer);
        release();
        if (this.active?.controller === controller) this.active = undefined;
      }
    });
    this.active = { generation, controller, done };
  }

  async request(request: TransferGrantRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    let abort = () => {};
    try {
      const response = await new Promise<TransferGrantResponse>((resolve, reject) => {
        abort = () => reject(new Error("TRANSFER_GRANT_UNAVAILABLE"));
        this.pending.set(request.requestId, resolve);
        signal.addEventListener("abort", abort, { once: true });
        if (!this.sendGrant(request)) abort();
      });
      if (Buffer.byteLength(response.grantJson) > 16 * 1024) throw new Error("INVALID_GRANT");
      return response;
    } finally {
      this.pending.delete(request.requestId);
      signal.removeEventListener("abort", abort);
    }
  }
}

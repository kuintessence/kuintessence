import { setTimeout as delay } from "node:timers/promises";

/** A running worker cannot turn a lost renewal into a resumable, unverified build. */
export class InstallationAuthorization {
  private readonly controller = new AbortController();
  private readonly stopped = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline = 0;
  private expiresAt = 0;
  private readonly renewal: Promise<void>;
  readonly signal: AbortSignal;

  constructor(
    expiresAt: number,
    renew: (signal: AbortSignal) => Promise<number>,
    parent: AbortSignal,
    accept?: (expiresAt: number) => Promise<void>,
  ) {
    this.signal = AbortSignal.any([parent, this.controller.signal]);
    this.update(expiresAt);
    const signal = AbortSignal.any([this.signal, this.stopped.signal]);
    this.renewal = (async () => {
      try {
        while (!signal.aborted) {
          await delay(Math.max(1, Math.floor(this.remaining() / 2)), undefined, { signal });
          this.assertValid();
          const next = await renew(signal);
          signal.throwIfAborted();
          // A late response must not revive a worker whose previous authority has expired.
          this.assertValid();
          this.validate(next);
          await accept?.(next);
          signal.throwIfAborted();
          this.assertValid();
          this.update(next);
        }
      } catch (error) {
        if (!signal.aborted)
          this.controller.abort(
            new Error("Federation installation renewal failed", { cause: error }),
          );
      }
    })();
  }

  private remaining(): number {
    return Math.min(this.expiresAt - Date.now(), this.deadline - performance.now());
  }

  private validate(expiresAt: number): number {
    const remaining = expiresAt - Date.now();
    if (!Number.isSafeInteger(expiresAt) || remaining <= 0 || remaining > 30_000)
      throw new Error("Invalid federation installation grant expiry");
    return remaining;
  }

  private update(expiresAt: number): void {
    const remaining = this.validate(expiresAt);
    this.expiresAt = expiresAt;
    this.deadline = performance.now() + remaining;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.controller.abort(new Error("Federation installation authorization expired"));
    }, remaining);
  }

  assertValid(): void {
    this.signal.throwIfAborted();
    if (this.remaining() <= 0) {
      this.controller.abort(new Error("Federation installation authorization expired"));
      this.signal.throwIfAborted();
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.timer);
    this.stopped.abort();
    await this.renewal;
  }
}

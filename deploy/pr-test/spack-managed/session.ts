import assert from "node:assert/strict";
import { loginSession } from "../spack-case/api";

export function managedSession(options: {
  login?: typeof loginSession;
  now?: () => number;
} = {}): () => Promise<string> {
  const authenticate = options.login ?? loginSession;
  const now = options.now ?? Date.now;
  let current: { token: string; refreshAt: number } | undefined;
  let pending: Promise<string> | undefined;
  return async () => {
    assert.equal(process.env.KQ_PR_TEST, "1");
    if (current && now() < current.refreshAt) return current.token;
    if (pending) return pending;
    const started = now();
    pending = (async () => {
      const session = await authenticate("https://server:3443");
      assert(session.token.length > 0 && Number.isSafeInteger(session.expiresIn));
      assert(session.expiresIn > 0);
      const lifetime = session.expiresIn * 1000;
      const refreshAt = started + lifetime - Math.min(30_000, lifetime / 2);
      assert(now() < refreshAt, "Acceptance login is already near expiry");
      current = { token: session.token, refreshAt };
      return current.token;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}

export function managedHttpFailureCode(error: unknown): string | undefined {
  if (!(error instanceof assert.AssertionError)) return undefined;
  const match = /^\/[A-Za-z0-9/_-]+: HTTP ([1-5][0-9]{2})$/.exec(error.message);
  return match ? `HTTP_${match[1]}` : undefined;
}

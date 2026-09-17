import { createServer, connect as tcpConnect } from "node:net";

// NOTE: freePort has a TOCTOU race — another process may claim the port between
// close and re-bind. This is acceptable for test use; do not use in production.
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer().unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not get port")));
      }
    });
  });
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      lastErr = new Error(`status ${r.status}`);
    } catch (err) {
      lastErr = err;
    }
    await Bun.sleep(500);
  }
  throw new Error(`waitForHttp(${url}) timed out: ${lastErr}`);
}

export async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = tcpConnect({ host, port });
        sock.once("connect", () => {
          sock.destroy();
          resolve();
        });
        sock.once("error", reject);
        sock.setTimeout(2000, () => {
          sock.destroy();
          reject(new Error("tcp timeout"));
        });
      });
      return;
    } catch (err) {
      lastErr = err;
      await Bun.sleep(250);
    }
  }
  throw new Error(`waitForTcp(${host}:${port}) timed out: ${lastErr}`);
}

export async function waitForAgentOnline(
  serverBaseUrl: string,
  token: string,
  agentId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  let lastBody: string | undefined;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${serverBaseUrl}/api/agents`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await r.text();
      lastBody = text;
      if (r.ok) {
        const body = JSON.parse(text) as { agents: Array<{ agentId: string; status: string }> };
        const a = body.agents.find((x) => x.agentId === agentId);
        if (a && a.status === "online") return;
        lastErr = new Error(`agent status: ${a?.status ?? "not found"}`);
      } else {
        lastErr = new Error(`status ${r.status}`);
      }
    } catch (err) {
      lastErr = err;
      lastBody = undefined;
    }
    await Bun.sleep(500);
  }
  throw new Error(
    `agent ${agentId} did not come online in ${timeoutMs}ms — last error: ${lastErr}` +
      (lastBody !== undefined ? ` — last body: ${lastBody}` : ""),
  );
}

export async function waitForAgentSoftware(
  serverBaseUrl: string,
  token: string,
  agentId: string,
  packageName: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${serverBaseUrl}/api/software/agents/${agentId}/installed`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
    if (response?.ok) {
      const body = (await response.json()) as { data?: Array<{ name?: string }> };
      if (body.data?.some((item) => item.name === packageName)) {
        return;
      }
    }
    await Bun.sleep(500);
  }
  throw new Error(`agent ${agentId} did not report installed software ${packageName}`);
}

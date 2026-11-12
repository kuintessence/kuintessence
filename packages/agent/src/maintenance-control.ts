import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, resolve } from "node:path";

export const MAINTENANCE_LEASE_MS = 120_000;
export interface MaintenanceRequest {
  action: "drain" | "resume";
  lease: string;
}
export interface MaintenanceResponse {
  ok: boolean;
  lease: string;
  reason: string;
}
export interface MaintenanceCallbacks {
  drain: (lease: string) => Promise<boolean>;
  resume: (lease: string) => void;
}

/** A lease can only release its own gate; expiry also releases a disconnected client. */
export class MaintenanceLease {
  private current:
    | { lease: string; granted: boolean; timer: ReturnType<typeof setTimeout> }
    | undefined;
  constructor(
    private readonly callbacks: MaintenanceCallbacks,
    private readonly leaseMs = MAINTENANCE_LEASE_MS,
  ) {}

  async request(input: unknown): Promise<MaintenanceResponse> {
    if (
      !input ||
      typeof input !== "object" ||
      !("action" in input) ||
      !("lease" in input) ||
      Object.keys(input).length !== 2 ||
      !["drain", "resume"].includes(String(input.action)) ||
      typeof input.lease !== "string" ||
      !/^[a-f0-9]{32}$/.test(input.lease)
    )
      return { ok: false, lease: "", reason: "MAINTENANCE_INVALID" };
    const lease = input.lease;
    if (input.action === "resume") {
      if (this.current?.lease !== lease)
        return { ok: false, lease, reason: "MAINTENANCE_LEASE_MISMATCH" };
      this.release(lease);
      return { ok: true, lease, reason: "MAINTENANCE_RESUMED" };
    }
    if (this.current)
      return {
        ok: this.current.lease === lease && this.current.granted,
        lease,
        reason:
          this.current.lease === lease && this.current.granted
            ? "MAINTENANCE_DRAINED"
            : "MAINTENANCE_BUSY",
      };
    const current = {
      lease,
      granted: false,
      timer: setTimeout(() => this.release(lease), this.leaseMs),
    };
    current.timer.unref();
    this.current = current;
    try {
      const granted = await this.callbacks.drain(lease);
      if (this.current !== current) return { ok: false, lease, reason: "MAINTENANCE_EXPIRED" };
      if (!granted) {
        this.release(lease);
        return { ok: false, lease, reason: "MAINTENANCE_BUSY" };
      }
      current.granted = true;
      return { ok: true, lease, reason: "MAINTENANCE_DRAINED" };
    } catch {
      this.release(lease);
      return { ok: false, lease, reason: "MAINTENANCE_UNAVAILABLE" };
    }
  }

  private release(lease: string): void {
    if (this.current?.lease !== lease) return;
    clearTimeout(this.current.timer);
    this.current = undefined;
    this.callbacks.resume(lease);
  }

  close(): void {
    if (this.current) this.release(this.current.lease);
  }
}

async function staleSocket(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("MAINTENANCE_SOCKET_UNAVAILABLE"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(true);
      else reject(new Error("MAINTENANCE_SOCKET_UNAVAILABLE"));
    });
  });
}

export async function startMaintenanceControl(
  path: string,
  callbacks: MaintenanceCallbacks,
): Promise<{ close: () => Promise<void> }> {
  path = resolve(path);
  const parent = dirname(path);
  const info = await lstat(parent);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(parent)) !== parent
  )
    throw new Error("MAINTENANCE_SOCKET_PARENT_PRIVATE_REQUIRED");
  try {
    const existing = await lstat(path);
    if (
      !existing.isSocket() ||
      existing.uid !== process.getuid?.() ||
      (existing.mode & 0o077) !== 0 ||
      !(await staleSocket(path))
    )
      throw new Error("MAINTENANCE_SOCKET_IN_USE");
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const lease = new MaintenanceLease(callbacks);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    let processing = false;
    socket.on("data", (chunk) => {
      if (processing) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 1024) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      processing = true;
      let input: unknown;
      try {
        input = JSON.parse(buffer.slice(0, end));
      } catch {
        input = undefined;
      }
      void lease
        .request(input)
        .then((response) => {
          if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
        })
        .catch(() => socket.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try {
    await chmod(path, 0o600);
  } catch (error) {
    server.close();
    await unlink(path);
    throw error;
  }
  const bound = await lstat(path);
  return {
    close: async () => {
      lease.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      const current = await lstat(path).catch(() => undefined);
      if (current?.ino === bound.ino && current.dev === bound.dev) await unlink(path);
    },
  };
}

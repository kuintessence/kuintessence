import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parsePositiveInt,
  parseServePort,
  readRegistrationToken,
  writeAgentRegistrationFiles,
} from "./agent";

describe("registration token file", () => {
  it("requires exactly one token source", async () => {
    await expect(readRegistrationToken({})).rejects.toThrow("exactly one");
    await expect(readRegistrationToken({ token: "x", tokenFile: "unused" })).rejects.toThrow(
      "exactly one",
    );
    await expect(readRegistrationToken({ token: " " })).rejects.toThrow("empty");
    expect(await readRegistrationToken({ token: "existing-token" })).toBe("existing-token");
  });

  it("reads a private file and rejects public, linked, empty or oversized files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-enroll-"));
    const path = join(dir, "token");
    try {
      await writeFile(path, "one-time-token\n", { mode: 0o600 });
      expect(await readRegistrationToken({ tokenFile: path })).toBe("one-time-token");
      await chmod(path, 0o644);
      await expect(readRegistrationToken({ tokenFile: path })).rejects.toThrow("private");
      await chmod(path, 0o600);
      await symlink(path, join(dir, "link"));
      await expect(readRegistrationToken({ tokenFile: join(dir, "link") })).rejects.toThrow();
      await writeFile(path, "");
      await expect(readRegistrationToken({ tokenFile: path })).rejects.toThrow("empty");
      await writeFile(path, "x".repeat(16385));
      await expect(readRegistrationToken({ tokenFile: path })).rejects.toThrow("16 KiB");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseServePort", () => {
  it("accepts a valid port", () => {
    expect(parseServePort("8787")).toBe(8787);
  });

  it("rejects out-of-range ports", () => {
    expect(() => parseServePort("0")).toThrow();
    expect(() => parseServePort("70000")).toThrow();
  });

  it("rejects non-integer values", () => {
    expect(() => parseServePort("abc")).toThrow();
    expect(() => parseServePort("80.5")).toThrow();
  });
});

describe("parsePositiveInt", () => {
  it("accepts positive integers", () => {
    expect(parsePositiveInt("60", "--ttl-sec")).toBe(60);
  });

  it("rejects non-positive values", () => {
    expect(() => parsePositiveInt("0", "--ttl-sec")).toThrow();
    expect(() => parsePositiveInt("-1", "--ttl-sec")).toThrow();
  });
});

describe("writeAgentRegistrationFiles", () => {
  it("writes a systemd-friendly env file and cert bundle outside CLI config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-agent-register-"));
    try {
      await writeAgentRegistrationFiles({
        outputDir: dir,
        serverHttpUrl: "https://server.example.com",
        serverGrpcUrl: "https://server.example.com/grpc",
        agentId: "agent-cli-test",
        siteName: "cli-site",
        schedulerType: "kubernetes",
        schedulerVersion: "1.36",
        certPem: "cert-pem",
        keyPem: "key-pem",
        caCertPem: "ca-pem",
      });

      const env = await readFile(join(dir, "agent.env"), "utf8");
      expect(env.trim().split("\n")).toHaveLength(9);
      expect(env).toContain('SERVER_GRPC_URL="https://server.example.com/grpc"');
      expect(env).toContain('SERVER_HTTP_URL="https://server.example.com"');
      expect(env).toContain('AGENT_ID="agent-cli-test"');
      expect(env).toContain('AGENT_SCHEDULER_TYPE="kubernetes"');
      expect(env).toContain('AGENT_SCHEDULER_VERSION="1.36"');
      expect(env).toContain('AGENT_MTLS_REQUIRED="true"');
      expect(await readFile(join(dir, "certs", "client.crt"), "utf8")).toBe("cert-pem");
      expect(await readFile(join(dir, "certs", "client.key"), "utf8")).toBe("key-pem");
      expect(await readFile(join(dir, "certs", "ca.crt"), "utf8")).toBe("ca-pem");

      expect((await stat(join(dir, "agent.env"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, "certs"))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("kq agent serve error routing", () => {
  it("reports an arg-validation error directly, not as a missing-scheduler failure", async () => {
    const cli = resolve(import.meta.dir, "../index.ts");
    const proc = Bun.spawn(["bun", "run", cli, "agent", "serve", "--port", "0"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;

    expect(exit).toBe(1);
    expect(out).toContain('Invalid --port "0"');
    // `agent serve` is always-local (no --local flag); a bad flag must not be
    // dressed up as a missing-scheduler problem referencing that flag.
    expect(out).not.toContain("Ensure a scheduler CLI");
    expect(out).not.toContain("--local");
  }, 30_000);
});

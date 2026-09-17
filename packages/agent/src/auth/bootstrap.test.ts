import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EnrollmentClient, ensureCertBundle } from "./bootstrap";

describe("Agent bootstrap", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kq-agent-bs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("first start with no cert: calls enrollment client, persists bundle, returns it", async () => {
    let receivedCsr = "";
    let receivedAgentId = "";
    let receivedToken = "";
    const client: EnrollmentClient = async ({ agentId, csrPem, enrollmentToken }) => {
      receivedAgentId = agentId;
      receivedCsr = csrPem;
      receivedToken = enrollmentToken;
      return {
        certPem: "ISSUED-CERT",
        caCertPem: "SERVER-CA",
      };
    };

    const result = await ensureCertBundle({
      dir,
      agentId: "agent-bs-1",
      enrollmentToken: "tok123",
      client,
    });

    expect(receivedAgentId).toBe("agent-bs-1");
    expect(receivedCsr).toContain("BEGIN CERTIFICATE REQUEST");
    expect(receivedToken).toBe("tok123");
    expect(result.certPem).toBe("ISSUED-CERT");
    expect(result.caCertPem).toBe("SERVER-CA");
    expect(result.keyPem).toMatch(/BEGIN/);
  });

  test("second start: loads from disk and does NOT call enrollment client", async () => {
    // Pre-populate
    writeFileSync(join(dir, "client.crt"), "C");
    writeFileSync(join(dir, "client.key"), "K");
    writeFileSync(join(dir, "ca.crt"), "CA");

    let called = false;
    const client: EnrollmentClient = async () => {
      called = true;
      return { certPem: "", caCertPem: "" };
    };

    const result = await ensureCertBundle({
      dir,
      agentId: "agent-bs-2",
      enrollmentToken: "ignored",
      client,
    });

    expect(called).toBe(false);
    expect(result).toEqual({ certPem: "C", keyPem: "K", caCertPem: "CA" });
  });

  test("propagates enrollment error and does NOT half-persist", async () => {
    const client: EnrollmentClient = async () => {
      throw new Error("Server returned 403");
    };
    await expect(
      ensureCertBundle({
        dir,
        agentId: "agent-bs-3",
        enrollmentToken: "tok",
        client,
      }),
    ).rejects.toThrow(/Server returned 403/);

    // Nothing persisted
    const fs = await import("node:fs");
    expect(fs.existsSync(join(dir, "client.crt"))).toBe(false);
    expect(fs.existsSync(join(dir, "client.key"))).toBe(false);
    expect(fs.existsSync(join(dir, "ca.crt"))).toBe(false);
  });

  test("rejects when enrollment is required but token is empty", async () => {
    const client: EnrollmentClient = async () => ({ certPem: "x", caCertPem: "y" });
    await expect(
      ensureCertBundle({
        dir,
        agentId: "a",
        enrollmentToken: "",
        client,
      }),
    ).rejects.toThrow(/enroll/i);
  });
});

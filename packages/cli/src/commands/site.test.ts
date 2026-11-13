import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { doctorFixturesSchema, runSiteDoctor } from "./site";

const originalFetch = globalThis.fetch;
const mode = process.env.KQ_TRANSPORT_MODE;
const directories: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (mode === undefined) delete process.env.KQ_TRANSPORT_MODE;
  else process.env.KQ_TRANSPORT_MODE = mode;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  delete process.env.KQ_TRANSPORT_MODE;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init),
    { preconnect: originalFetch.preconnect },
  );
}

test("missing identity and fixtures remain not-tested and never print URLs", async () => {
  fakeFetch(() => Response.json({ revision: "abc" }));
  const report = await runSiteDoctor({ url: "https://platform.invalid/secret-path" });
  expect(report.complete).toBe(false);
  expect(report.checks[0]?.status).toBe("passed");
  expect(report.checks.slice(1).every((check) => check.status === "not-tested")).toBe(true);
  expect(JSON.stringify(report)).not.toContain("platform.invalid");
});

test("file token only reads registration metadata; material bytes must match fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kq-doctor-"));
  directories.push(directory);
  const tokenFile = join(directory, "token");
  const fixtures = join(directory, "fixtures.json");
  await writeFile(tokenFile, "secret-token\n");
  await writeFile(
    fixtures,
    JSON.stringify({
      version: 1,
      material: {
        url: "https://platform.invalid/material?signed=secret",
        size: 3,
        sha256: digest("abc"),
      },
    }),
  );
  const calls: string[] = [];
  fakeFetch((url, init) => {
    calls.push(url);
    if (url.endsWith("metadata")) {
      expect(JSON.parse(String(init?.body)).token).toBe("secret-token");
      return Response.json({ agentId: "agent-a" });
    }
    if (url.includes("/material")) return new Response("bad");
    return Response.json({ revision: "abc" });
  });
  const report = await runSiteDoctor({ url: "https://platform.invalid", tokenFile, fixtures });
  expect(report.checks.find((check) => check.channel === "registration-identity")?.status).toBe(
    "passed",
  );
  expect(report.checks.find((check) => check.channel === "material-get")?.status).toBe("failed");
  expect(calls.some((url) => url.endsWith("complete"))).toBe(false);
  expect(JSON.stringify(report)).not.toContain("secret");
});

test("redirect and server errors fail HTTPS without leaking diagnostics", async () => {
  fakeFetch(
    () => new Response(null, { status: 302, headers: { location: "https://secret.invalid" } }),
  );
  const report = await runSiteDoctor({ url: "https://platform.invalid" });
  expect(report.checks[0]?.status).toBe("failed");
  expect(JSON.stringify(report)).not.toContain("secret.invalid");
});

test("fixture boundary rejects plaintext, credentials and oversized probes", () => {
  for (const url of [
    "http://platform.invalid",
    "https://user:password@platform.invalid",
    "https://platform.invalid/#secret",
  ]) {
    expect(
      doctorFixturesSchema.safeParse({
        version: 1,
        objectGet: { url, sha256: digest("a"), size: 1 },
      }).success,
    ).toBe(false);
  }
  expect(
    doctorFixturesSchema.safeParse({
      version: 1,
      objectGet: { url: "https://platform.invalid", sha256: digest("a"), size: 9 * 1024 * 1024 },
    }).success,
  ).toBe(false);
});

test("registered proof obtains fixtures automatically and resolves API paths under platform prefix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kq-doctor-cert-"));
  directories.push(directory);
  const certDir = join(directory, "certs");
  await mkdir(certDir);
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 1000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  await writeFile(join(certDir, "client.crt"), forge.pki.certificateToPem(cert));
  await writeFile(join(certDir, "client.key"), forge.pki.privateKeyToPem(keys.privateKey));
  await writeFile(join(directory, "agent.env"), 'AGENT_ID="agent-a"\n');
  const calls: string[] = [];
  fakeFetch((url, init) => {
    calls.push(url);
    if (url.endsWith("/agent/site-diagnostics")) {
      const proof = JSON.parse(String(init?.body));
      expect(proof.agentId).toBe("agent-a");
      expect(proof.signature.length).toBeGreaterThan(0);
      expect(String(init?.body)).not.toContain("PRIVATE KEY");
      return Response.json({
        version: 1,
        identity: { agentId: "agent-a" },
        cleanupUrl: "agent/site-diagnostics/session?ticket=secret",
        fixtures: {
          version: 1,
          material: {
            url: "agent/site-diagnostics/material?ticket=secret",
            size: 3,
            sha256: digest("abc"),
          },
        },
      });
    }
    if (url.includes("/material?")) return new Response("abc");
    if (url.includes("/session?")) {
      expect(init?.method).toBe("DELETE");
      return Response.json({ ok: true });
    }
    return Response.json({ revision: "abc" });
  });
  const report = await runSiteDoctor({ url: "https://platform.invalid/platform", certDir });
  expect(report.checks.find((check) => check.channel === "registration-identity")?.status).toBe(
    "passed",
  );
  expect(report.checks.find((check) => check.channel === "material-get")?.detail).toBe(
    "probe-only-not-spack-closure",
  );
  expect(calls).toContain(
    "https://platform.invalid/platform/api/agent/site-diagnostics/material?ticket=secret",
  );
  expect(calls).toContain(
    "https://platform.invalid/platform/api/agent/site-diagnostics/session?ticket=secret",
  );
  expect(JSON.stringify(report)).not.toContain("secret");
});

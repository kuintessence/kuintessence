import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCa } from "../auth/ca";
import { issueAgentCert } from "../auth/cert-issuer";
import { createAgentPkiRoutes } from "./agent-pki";

test("OpenSSL verifies the advertised CRL and nonce-bound OCSP statuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kq-pki-"));
  const openssl = (args: string[]) =>
    execFileSync("openssl", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    const ca = { ...(await ensureCa(dir)), distributionOrigin: "https://kq.example" };
    openssl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=agent",
      "-out",
      "agent.csr",
      "-keyout",
      "agent.key",
    ]);
    const csrPem = await readFile(join(dir, "agent.csr"), "utf8");
    const certs: { certPem: string; revokedAt: Date | null }[] = [];
    for (const name of ["good", "revoked", "unknown"]) {
      const { certPem } = issueAgentCert({ ca, csrPem, agentId: "agent" });
      await writeFile(join(dir, name + ".pem"), certPem);
      if (name !== "unknown")
        certs.push({ certPem, revokedAt: name === "revoked" ? new Date() : null });
    }
    expect(openssl(["x509", "-in", "good.pem", "-noout", "-ocsp_uri"]).trim()).toBe(
      "https://kq.example/api/agent-pki/ocsp",
    );
    const app = createAgentPkiRoutes(ca, async () => certs);
    const crl = await app.request("/crl");
    expect(crl.status).toBe(200);
    await writeFile(join(dir, "revocations.der"), new Uint8Array(await crl.arrayBuffer()));
    const format = openssl([
      "crl",
      "-in",
      "revocations.der",
      "-inform",
      "DER",
      "-outform",
      "PEM",
      "-CAfile",
      "ca.crt",
      "-verify",
    ]);
    await writeFile(join(dir, "crl.pem"), format);
    expect(
      openssl(["verify", "-CAfile", "ca.crt", "-crl_check", "-CRLfile", "crl.pem", "good.pem"]),
    ).toContain("OK");
    expect(() =>
      openssl(["verify", "-CAfile", "ca.crt", "-crl_check", "-CRLfile", "crl.pem", "revoked.pem"]),
    ).toThrow(/certificate revoked/);
    for (const name of ["good", "revoked", "unknown"]) {
      openssl(["ocsp", "-issuer", "ca.crt", "-cert", name + ".pem", "-reqout", "req.der"]);
      const body = await readFile(join(dir, "req.der"));
      const result =
        name === "unknown"
          ? await app.request("/ocsp/" + encodeURIComponent(body.toString("base64")))
          : await app.request("/ocsp", {
              method: "POST",
              headers: { "Content-Type": "application/ocsp-request" },
              body,
            });
      expect(result.status).toBe(200);
      await writeFile(join(dir, "response.der"), new Uint8Array(await result.arrayBuffer()));
      openssl(["ocsp", "-reqin", "req.der", "-respin", "response.der", "-CAfile", "ca.crt"]);
      expect(
        openssl([
          "ocsp",
          "-no_nonce",
          "-respin",
          "response.der",
          "-issuer",
          "ca.crt",
          "-cert",
          name + ".pem",
          "-CAfile",
          "ca.crt",
        ]),
      ).toContain(name + ".pem: " + name);
    }
    expect((await app.request("/ocsp", { method: "POST", body: "invalid" })).status).toBe(415);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

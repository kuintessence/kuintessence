import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { probeDuplex } from "./site";

test("doctor verifies mTLS two-way challenges through forwarding and CONNECT", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kq-doctor-duplex-"));
  const certDir = join(directory, "certs");
  await mkdir(certDir);
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 1000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: "commonName", value: "site.invalid" }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", digitalSignature: true, keyCertSign: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true, clientAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: "site.invalid" }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  const key = forge.pki.privateKeyToPem(keys.privateKey);
  await Promise.all([
    writeFile(join(certDir, "client.crt"), pem),
    writeFile(join(certDir, "client.key"), key),
    writeFile(join(certDir, "ca.crt"), pem),
  ]);
  let echoes = 0;
  const server = createSecureServer({
    cert: pem,
    key,
    ca: pem,
    requestCert: true,
    rejectUnauthorized: true,
  });
  server.on("request", (request, response) => {
    expect(request.url).toBe("/site-diagnostics/stream");
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write("");
    request.setEncoding("utf8");
    let pending = "";
    request.on("data", (chunk: string) => {
      pending += chunk;
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n");
        const message = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        echoes++;
        response.write(`${JSON.stringify({ ...message, agentId: "agent-a" })}\n`);
      }
    });
    request.on("end", () => response.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test bind");
  const proxy = createServer();
  proxy.on("connect", (_request, socket, head) => {
    const upstream = connect(address.port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("test bind");
  const previous = { ...process.env };
  try {
    process.env.KQ_ALLOWED_ORIGINS = "https://site.invalid";
    process.env.KQ_FORWARD_MAP = JSON.stringify({
      "https://site.invalid": { host: "127.0.0.1", port: address.port },
    });
    process.env.KQ_HTTP_PROXY_URL = `http://127.0.0.1:${proxyAddress.port}`;
    process.env.KQ_TLS_CA_FILE = join(certDir, "ca.crt");
    for (const mode of ["ssh-forward", "http-proxy"]) {
      process.env.KQ_TRANSPORT_MODE = mode;
      await probeDuplex("https://site.invalid", certDir);
    }
    expect(echoes).toBe(4);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("KQ_")) delete process.env[key];
    Object.assign(process.env, previous);
    server.close();
    proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

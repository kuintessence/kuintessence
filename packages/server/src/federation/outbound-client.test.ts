import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFederationSender, type FederationSend } from "./outbound-client";

let root: string;
let server: ReturnType<typeof Bun.spawn>;
let endpoint: string;
let tls: { cert: string; key: string; ca: string };
let send: FederationSend;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kq-outbound-tls-"));
  const openssl = (...args: string[]) =>
    execFileSync("openssl", args, { cwd: root, stdio: "pipe" });
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "1",
    "-subj",
    "/CN=Outbound test CA",
  );
  for (const name of ["server", "source"]) {
    openssl(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      `/CN=${name}`,
    );
    await writeFile(
      join(root, `${name}.ext`),
      name === "server"
        ? "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n"
        : "extendedKeyUsage=clientAuth\n",
    );
    openssl(
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      `${name}.pem`,
      "-days",
      "1",
      "-extfile",
      `${name}.ext`,
    );
  }
  // Real Node TLS peer checks the authenticated client certificate, not a request header.
  const source = `
    import { createServer } from 'node:https';
    import { readFileSync, writeFileSync } from 'node:fs';
    const server = createServer({ key:readFileSync('server.key'), cert:readFileSync('server.pem'), ca:readFileSync('ca.pem'), requestCert:true, rejectUnauthorized:true }, async (req,res) => {
      if (!req.socket.authorized || req.socket.getPeerCertificate().subject.CN !== 'source' || req.method !== 'POST' || !['/federation/v1/delegations','/federation/v1/status','/federation/v1/usage','/federation/v1/agreement-approvals','/federation/v1/commercial-approvals','/federation/v1/commercial-closing','/federation/v1/market-requests','/federation/v1/reservation-proposals','/federation/v1/cancellations','/federation/v1/results','/federation/v1/result-downloads','/federation/v1/result-receipts','/federation/v1/materials','/federation/v1/input-downloads'].includes(req.url) || req.headers['content-type'] !== 'application/jose') { res.writeHead(403).end(); return; }
      let body=''; for await (const chunk of req) body+=chunk;
      if (body==='redirect') { res.writeHead(307,{location:'/unexpected'}).end(); return; }
      if (body==='slow') return;
      if (body==='broken') { res.writeHead(200,{'content-type':'application/jose','content-length':'100'}); res.write('short'); setTimeout(()=>res.destroy(),20); return; }
      res.writeHead(200,{'content-type':'application/jose'}).end(body==='large' ? 'x'.repeat(524289) : 'signed-receipt');
    });
    server.listen(0,'127.0.0.1',()=>writeFileSync('port',String(server.address().port)));
  `;
  server = Bun.spawn(["node", "--input-type=module", "-e", source], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    if (await Bun.file(join(root, "port")).exists()) break;
    await Bun.sleep(10);
  }
  endpoint = `https://localhost:${await readFile(join(root, "port"), "utf8")}`;
  tls = {
    cert: await readFile(join(root, "source.pem"), "utf8"),
    key: await readFile(join(root, "source.key"), "utf8"),
    ca: await readFile(join(root, "ca.pem"), "utf8"),
  };
  send = createFederationSender(tls);
}, 15000);

afterAll(async () => {
  server?.kill();
  if (server) await server.exited;
  if (root) await rm(root, { recursive: true, force: true });
});

test("outbound HTTPS sends the client identity and accepts a bounded JOSE response", async () => {
  expect(await send(endpoint, "request-jws")).toBe("signed-receipt");
  expect(await send(endpoint, "result-jws", "/federation/v1/results")).toBe("signed-receipt");
  expect(await send(endpoint, "receipt-jws", "/federation/v1/result-receipts")).toBe(
    "signed-receipt",
  );
  expect(await send(endpoint, "download-jws", "/federation/v1/result-downloads")).toBe(
    "signed-receipt",
  );
  expect(await send(endpoint, "material-jws", "/federation/v1/materials")).toBe("signed-receipt");
  expect(await send(endpoint, "input-jws", "/federation/v1/input-downloads")).toBe(
    "signed-receipt",
  );
  expect(await send(endpoint, "usage-jws", "/federation/v1/usage")).toBe("signed-receipt");
  expect(await send(endpoint, "market-request-jws", "/federation/v1/market-requests")).toBe(
    "signed-receipt",
  );
  expect(await send(endpoint, "proposal-jws", "/federation/v1/reservation-proposals")).toBe(
    "signed-receipt",
  );
  expect(await send(endpoint, "agreement-jws", "/federation/v1/agreement-approvals")).toBe(
    "signed-receipt",
  );
  expect(await send(endpoint, "approval-jws", "/federation/v1/commercial-approvals")).toBe(
    "signed-receipt",
  );
  expect(await send(endpoint, "closing-jws", "/federation/v1/commercial-closing")).toBe(
    "signed-receipt",
  );
  expect(await send(endpoint, "status-jws", "/federation/v1/status")).toBe("signed-receipt");
  expect(await send(endpoint, "cancel-jws", "/federation/v1/cancellations")).toBe("signed-receipt");
});

test("outbound transport refuses redirects and oversized or truncated responses", async () => {
  await expect(send(endpoint, "redirect")).rejects.toThrow("INVALID_RECEIPT_RESPONSE");
  await expect(send(endpoint, "large")).rejects.toThrow("INVALID_RECEIPT_RESPONSE");
  await expect(send(endpoint, "broken")).rejects.toThrow("DELIVERY_UNAVAILABLE");
});

test("outbound transport enforces hostname and CA validation", async () => {
  await expect(send(endpoint.replace("localhost", "127.0.0.1"), "request")).rejects.toThrow(
    "DELIVERY_UNAVAILABLE",
  );
  await expect(
    createFederationSender({ ...tls, ca: tls.cert })(endpoint, "request"),
  ).rejects.toThrow("DELIVERY_UNAVAILABLE");
});

test("an unresponsive TLS peer cannot hold a source delivery indefinitely", async () => {
  await expect(
    createFederationSender({ ...tls, timeoutMs: 200 })(endpoint, "slow"),
  ).rejects.toThrow("DELIVERY_UNAVAILABLE");
});

test("outbound origins cannot contain credentials, redirects, a query or alternate path", () => {
  for (const origin of [
    "http://localhost",
    "https://user:password@localhost",
    `${endpoint}/other`,
    `${endpoint}?next=elsewhere`,
  ])
    expect(() => send(origin, "request")).toThrow();
});

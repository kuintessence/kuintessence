import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFederationGateway } from "./gateway";

const dir = await mkdtemp(join(tmpdir(), "kq-federation-tls-"));
function openssl(...args: string[]) {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}
try {
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
    "/CN=Test CA",
  );
  for (const name of ["server", "client"]) {
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
      join(dir, `${name}.ext`),
      name === "server"
        ? "basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n"
        : "basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n",
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
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "rogue.key",
    "-out",
    "rogue.pem",
    "-days",
    "1",
    "-subj",
    "/CN=Untrusted",
  );
  const pem = async (name: string) => readFile(join(dir, name), "utf8");
  const ca = await pem("ca.pem");
  const cert = await pem("client.pem");
  const key = await pem("client.key");
  let calls = 0;
  const socketPath = join(dir, "backend.sock");
  const backend = createServer(async (req, res) => {
    calls++;
    assert.ok(
      [
        "/federation/v1/delegations",
        "/federation/v1/status",
        "/federation/v1/agreement-approvals",
        "/federation/v1/commercial-approvals",
        "/federation/v1/commercial-closing",
        "/federation/v1/disputes",
        "/federation/v1/case-revocations",
        "/federation/v1/dispute-freezes",
        "/federation/v1/market-requests",
        "/federation/v1/reservation-proposals",
        "/federation/v1/usage",
        "/federation/v1/terminals",
        "/federation/v1/terminal-signatures",
        "/federation/v1/cancellations",
        "/federation/v1/results",
        "/federation/v1/result-downloads",
        "/federation/v1/result-receipts",
        "/federation/v1/materials",
        "/federation/v1/input-downloads",
        "/federation/v1/media-keys",
        "/federation/v1/dataset-use",
        "/federation/v1/disclosure-authorizations",
        "/federation/v1/disclosure-downloads",
        "/federation/v1/media-receipts",
      ].includes(req.url ?? ""),
    );
    assert.equal(
      req.headers["x-kq-federation-cert"],
      new X509Certificate(cert).fingerprint256.replaceAll(":", "").toLowerCase(),
    );
    for (const header of ["authorization", "cookie", "x-forwarded-for", "x-site-id"])
      assert.equal(req.headers[header], undefined);
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    assert.equal(body, "signed.request.bytes");
    res.writeHead(200, { "content-type": "application/jose" }).end("signed.receipt.bytes");
  });
  backend.listen(socketPath);
  await once(backend, "listening");
  const gateway = createFederationGateway({
    ca,
    cert: await pem("server.pem"),
    key: await pem("server.key"),
    socketPath,
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  assert.ok(address && typeof address !== "string");
  const call = (
    identity: { cert?: string; key?: string },
    path = "/federation/v1/delegations",
    body = "signed.request.bytes",
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          servername: "localhost",
          ca,
          ...identity,
          method: "POST",
          path,
          agent: false,
          timeout: 3000,
          headers: {
            "content-type": "application/jose",
            "x-kq-federation-cert": "forged",
            authorization: "Bearer fake",
            cookie: "session=fake",
            "x-forwarded-for": "127.0.0.1",
            "x-site-id": "forged",
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk.toString();
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("Request timeout")));
      req.end(body);
    });
  try {
    assert.deepEqual(await call({ cert, key }), { status: 200, body: "signed.receipt.bytes" });
    assert.equal((await call({ cert, key }, "/federation/v1/status")).status, 200);
    assert.equal((await call({ cert, key }, "/federation/v1/agreement-approvals")).status, 200);
    assert.equal(
      (await call({ cert, key }, "/federation/v1/agreement-approvals?peer=forged")).status,
      404,
    );
    assert.equal((await call({ cert, key }, "/federation/v1/commercial-approvals")).status, 200);
    assert.equal((await call({ cert, key }, "/federation/v1/commercial-closing")).status, 200);
    for (const path of [
      "/federation/v1/disputes",
      "/federation/v1/dispute-freezes",
      "/federation/v1/case-revocations",
    ]) {
      assert.deepEqual(await call({ cert, key }, path), {
        status: 200,
        body: "signed.receipt.bytes",
      });
      assert.equal((await call({ cert, key }, `${path}?peer=forged`)).status, 404);
      await assert.rejects(call({}, path));
    }
    assert.equal((await call({ cert, key }, "/federation/v1/market-requests")).status, 200);
    assert.equal(
      (await call({ cert, key }, "/federation/v1/market-requests?peer=forged")).status,
      404,
    );
    assert.equal((await call({ cert, key }, "/federation/v1/reservation-proposals")).status, 200);
    assert.equal(
      (await call({ cert, key }, "/federation/v1/reservation-proposals?identity=forged")).status,
      404,
    );
    assert.equal((await call({ cert, key }, "/federation/v1/usage")).status, 200);
    assert.equal((await call({ cert, key }, "/federation/v1/terminals")).status, 200);
    assert.equal((await call({ cert, key }, "/federation/v1/terminal-signatures")).status, 200);
    assert.equal((await call({ cert, key }, "/federation/v1/usage?peer=forged")).status, 404);
    assert.equal((await call({ cert, key }, "/federation/v1/status?peer=forged")).status, 404);
    assert.equal((await call({ cert, key }, "/federation/v1/media-keys")).status, 200);
    assert.equal((await call({ cert, key }, "/federation/v1/media-keys?peer=forged")).status, 404);
    await assert.rejects(call({}, "/federation/v1/media-keys"));
    assert.equal(
      (await call({ cert, key }, "/federation/v1/disclosure-authorizations")).status,
      200,
    );
    assert.equal(
      (await call({ cert, key }, "/federation/v1/disclosure-authorizations?peer=forged")).status,
      404,
    );
    assert.equal((await call({ cert, key }, "/federation/v1/disclosure-downloads")).status, 200);
    assert.equal(
      (await call({ cert, key }, "/federation/v1/disclosure-downloads?peer=forged")).status,
      404,
    );
    await assert.rejects(call({}, "/federation/v1/disclosure-downloads"));
    await assert.rejects(call({}, "/federation/v1/disclosure-authorizations"));
    assert.equal((await call({ cert, key }, "/federation/v1/dataset-use")).status, 200);
    assert.equal((await call({ cert, key }, "/federation/v1/dataset-use?peer=forged")).status, 404);
    await assert.rejects(call({}, "/federation/v1/dataset-use"));
    assert.equal((await call({ cert, key }, "/federation/v1/media-receipts")).status, 200);
    assert.equal(
      (await call({ cert, key }, "/federation/v1/media-receipts?peer=forged")).status,
      404,
    );
    await assert.rejects(call({}, "/federation/v1/media-receipts"));
    await assert.rejects(call({}));
    await assert.rejects(call({ cert: await pem("rogue.pem"), key: await pem("rogue.key") }));
    assert.equal((await call({ cert, key }, "/api/admin/federation/sites")).status, 404);
    assert.equal((await call({ cert, key }, "/federation/v1/delegations?site=forged")).status, 404);
    assert.equal(
      (await call({ cert, key }, "/federation/v1/delegations", "x".repeat(524289))).status,
      413,
    );
    assert.equal((await call({ cert, key }, "/federation/v1/cancellations")).status, 200);
    assert.equal((await call({ cert, key }, "/federation/v1/results")).status, 200);
    assert.equal((await call({ cert, key }, "/federation/v1/results?peer=forged")).status, 404);
    assert.equal((await call({ cert, key }, "/federation/v1/result-downloads")).status, 200);
    assert.equal(
      (await call({ cert, key }, "/federation/v1/result-downloads?peer=forged")).status,
      404,
    );
    assert.equal((await call({ cert, key }, "/federation/v1/result-receipts")).status, 200);
    assert.equal((await call({ cert, key }, "/federation/v1/materials")).status, 200);
    assert.equal((await call({ cert, key }, "/federation/v1/materials?digest=forged")).status, 404);
    assert.equal(
      (await call({ cert, key }, "/federation/v1/result-receipts?peer=forged")).status,
      404,
    );
    assert.equal((await call({ cert, key }, "/federation/v1/input-downloads")).status, 200);
    assert.equal(
      (await call({ cert, key }, "/federation/v1/input-downloads?identity=forged")).status,
      404,
    );
    assert.equal(calls, 24);
    await new Promise<void>((resolve, reject) =>
      backend.close((error) => (error ? reject(error) : resolve())),
    );
    assert.equal((await call({ cert, key })).status, 502);
    process.stdout.write(
      JSON.stringify({
        assertions:
          "mTLS, header stripping, private route isolation, body limit, unavailable upstream",
      }),
    );
  } finally {
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    backend.closeAllConnections();
    backend.close();
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

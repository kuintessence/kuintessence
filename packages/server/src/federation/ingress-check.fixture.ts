import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:https";
import { createFederationGateway } from "./gateway";

let input = "";
for await (const chunk of process.stdin) input += chunk.toString();
const config: {
  socketPath: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
  requestJws: string;
} = JSON.parse(input);
const gateway = createFederationGateway({
  socketPath: config.socketPath,
  ca: config.clientCert,
  cert: config.serverCert,
  key: config.serverKey,
});
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
try {
  const address = gateway.address();
  assert.ok(address && typeof address !== "string");
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: address.port,
        servername: "localhost",
        ca: config.serverCert,
        cert: config.clientCert,
        key: config.clientKey,
        path: "/federation/v1/delegations",
        method: "POST",
        agent: false,
        timeout: 5000,
        headers: { "content-type": "application/jose", "x-kq-federation-cert": "forged" },
      },
      (res) => {
        let body = "";
        res.on("data", (part) => {
          body += part.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Timeout")));
    req.end(config.requestJws);
  });
  process.stdout.write(JSON.stringify(response));
} finally {
  gateway.closeAllConnections();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
}

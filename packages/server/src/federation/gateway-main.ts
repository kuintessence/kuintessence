import { readFile } from "node:fs/promises";
import { createFederationGateway } from "./gateway";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const port = Number(required("FEDERATION_TLS_PORT"));
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid FEDERATION_TLS_PORT");
const server = createFederationGateway({
  ca: await readFile(required("FEDERATION_TLS_CA_FILE"), "utf8"),
  cert: await readFile(required("FEDERATION_TLS_CERT_FILE"), "utf8"),
  key: await readFile(required("FEDERATION_TLS_KEY_FILE"), "utf8"),
  socketPath: required("FEDERATION_SOCKET_PATH"),
});
server.listen(port, process.env.FEDERATION_TLS_HOST ?? "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close());

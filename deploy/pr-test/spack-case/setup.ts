import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { ensureCa } from "../../../packages/server/src/auth/ca";

// This process runs only in an ephemeral operator container, never in the Agent.
assert.equal(process.env.KQ_PR_TEST, "1");
const execute = promisify(execFile);
await ensureCa("/case-server/ca");
await copyFile("/case-server/ca/ca.crt", "/case-ca/ca.crt");
await writeFile(
  "/case-server/extensions.cnf",
  "subjectAltName=DNS:server\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n",
);
await execute("openssl", [
  "req",
  "-new",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-subj",
  "/CN=server",
  "-keyout",
  "/case-server/server.key",
  "-out",
  "/case-server/server.csr",
]);
await execute("openssl", [
  "x509",
  "-req",
  "-in",
  "/case-server/server.csr",
  "-CA",
  "/case-server/ca/ca.crt",
  "-CAkey",
  "/case-server/ca/ca.key",
  "-CAcreateserial",
  "-days",
  "2",
  "-extfile",
  "/case-server/extensions.cnf",
  "-out",
  "/case-server/server.crt",
]);
await writeFile("/case-control/bindings.json", "{}\n");
console.log("Spack case: ephemeral CA and TLS server certificate prepared");

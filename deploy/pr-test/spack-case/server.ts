import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SpackMaterialBindingSchema } from "@kuintessence/shared";
import { z } from "zod";

assert.equal(process.env.KQ_PR_TEST, "1");
const bindings = z
  .record(z.string(), SpackMaterialBindingSchema)
  .parse(JSON.parse(await readFile("/case-control/bindings.json", "utf8")));
process.env.SPACK_MATERIAL_RELEASES = JSON.stringify(bindings);

// Keep production routes and direct-mTLS stream unchanged. Only the disposable
// HTTP listener gets a second TLS endpoint for the Agent's real material client.
const { default: application } = await import("../../../packages/server/src/index");
Bun.serve(application);
Bun.serve({
  ...application,
  port: 3443,
  tls: {
    cert: Bun.file("/case-server/server.crt"),
    key: Bun.file("/case-server/server.key"),
  },
});

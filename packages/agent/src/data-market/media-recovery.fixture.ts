import type { FederationMediaImportGrant } from "@kuintessence/shared/federation";
import { MediaAge } from "@kuintessence/shared/federation/media-age";
import { AgentDataRoots } from "./local-data-security";
import { exportFederationMedia } from "./media-export";
import { importFederationMedia } from "./media-import";

// Private test keys arrive through stdin, never argv, environment or a persisted fixture.
type Options = { agentId: string; mediaDirectory: string };
const input: {
  stage: "partial" | "complete";
  roots: ConstructorParameters<typeof AgentDataRoots>[0];
} & (
  | {
      mode: "export";
      options: Options & { task: Parameters<typeof exportFederationMedia>[0]["task"] };
    }
  | {
      mode: "import";
      options: Options & { task: Parameters<typeof importFederationMedia>[0]["task"] };
      privateKey: import("node:crypto").webcrypto.JsonWebKey;
      grant: FederationMediaImportGrant;
    }
) = await Bun.stdin.json();
const roots = new AgentDataRoots(input.roots);
await roots.initialize();
const age = new MediaAge(process.env.KQ_MEDIA_AGE_TEST_BIN ?? "");
async function hold() {
  process.stdout.write(`${input.stage}\n`);
  await new Promise(() => setInterval(() => {}, 1000));
}
const signal = AbortSignal.timeout(30_000);
if (input.mode === "export") {
  await exportFederationMedia({
    ...input.options,
    roots,
    signal,
    authorize: async () => {},
    age: {
      async *encrypt(...args) {
        yield* age.encrypt(...args);
        if (input.stage === "partial") await hold();
      },
    },
  });
} else {
  await importFederationMedia({
    ...input.options,
    roots,
    signal,
    privateKey: await crypto.subtle.importKey(
      "jwk",
      input.privateKey,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    ),
    recipientKey: input.grant.query.recipientKey,
    authorize: async () => input.grant,
    age: {
      async *decrypt(...args) {
        yield* age.decrypt(...args);
        if (input.stage === "partial") await hold();
      },
    },
  });
}
await hold();

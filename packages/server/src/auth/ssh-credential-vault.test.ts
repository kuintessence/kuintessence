import { describe, expect, test } from "bun:test";
import { decryptSecret } from "./secret-cipher";
import {
  decryptSshRow,
  type EncryptedSshRow,
  encryptSshSecrets,
  makeVaultResolver,
  SSH_CRED_DOMAIN,
} from "./ssh-credential-vault";

const KEY = "vault-wrapping-key-at-least-32-chars-long";

describe("ssh-credential-vault", () => {
  test("password material round-trips through encrypt + decryptSshRow", async () => {
    const enc = await encryptSshSecrets({ password: "hunter2" }, KEY);
    expect(enc).not.toBe("");
    const row: EncryptedSshRow = {
      host: "login01",
      port: 22,
      username: "alice",
      secretEncrypted: enc,
    };
    const creds = await decryptSshRow(row, KEY);
    expect(creds).toEqual({
      host: "login01",
      port: 22,
      username: "alice",
      password: "hunter2",
    });
  });

  test("private key + passphrase round-trip", async () => {
    const enc = await encryptSshSecrets({ privateKey: "-----KEY-----", passphrase: "pp" }, KEY);
    const creds = await decryptSshRow(
      { host: "h", port: 2222, username: "u", secretEncrypted: enc },
      KEY,
    );
    expect(creds.privateKey).toBe("-----KEY-----");
    expect(creds.passphrase).toBe("pp");
    expect(creds.password).toBeUndefined();
  });

  test("empty material encrypts to '' and yields coordinates with no auth", async () => {
    const enc = await encryptSshSecrets({}, KEY);
    expect(enc).toBe("");
    const creds = await decryptSshRow(
      { host: "h", port: 22, username: "u", secretEncrypted: "" },
      KEY,
    );
    expect(creds).toEqual({ host: "h", port: 22, username: "u" });
  });

  test("the encrypted blob is not readable under the SSO domain (isolation)", async () => {
    const enc = await encryptSshSecrets({ password: "x" }, KEY);
    let failed = false;
    try {
      // Default domain == SSO; must not decrypt an SSH-domain envelope.
      await decryptSecret(enc, KEY);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    // Sanity: it does decrypt under the SSH domain.
    expect(await decryptSecret(enc, KEY, SSH_CRED_DOMAIN)).toContain("password");
  });

  test("vault resolver returns null when no row exists (route closes 4404)", async () => {
    const resolve = makeVaultResolver(async () => null, KEY);
    expect(await resolve("agent-x")).toBeNull();
  });

  test("vault resolver decrypts the stored row for an agent", async () => {
    const enc = await encryptSshSecrets({ password: "pw" }, KEY);
    const rows: Record<string, EncryptedSshRow> = {
      "agent-1": { host: "node1", port: 22, username: "bob", secretEncrypted: enc },
    };
    const resolve = makeVaultResolver(async (id) => rows[id] ?? null, KEY);
    const creds = await resolve("agent-1");
    expect(creds?.host).toBe("node1");
    expect(creds?.password).toBe("pw");
    expect(await resolve("agent-unknown")).toBeNull();
  });
});

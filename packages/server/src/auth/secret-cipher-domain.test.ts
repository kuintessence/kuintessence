import { describe, expect, test } from "bun:test";
import { DEFAULT_SECRET_DOMAIN, decryptSecret, encryptSecret } from "./secret-cipher";

const KEY = "test-wrapping-key-at-least-32-chars-long";
const SSH_DOMAIN = "kq-ssh-cred-v1";

describe("secret-cipher domain separation", () => {
  test("round-trips with a custom domain label", async () => {
    const ct = await encryptSecret("ssh-password", KEY, SSH_DOMAIN);
    const pt = await decryptSecret(ct, KEY, SSH_DOMAIN);
    expect(pt).toBe("ssh-password");
  });

  test("a ciphertext from one domain cannot be read under another", async () => {
    const ct = await encryptSecret("ssh-password", KEY, SSH_DOMAIN);
    let crossDomainFailed = false;
    try {
      await decryptSecret(ct, KEY, DEFAULT_SECRET_DOMAIN);
    } catch {
      crossDomainFailed = true;
    }
    expect(crossDomainFailed).toBe(true);
  });

  test("the default domain matches an explicit SSO label (back-compat)", async () => {
    const ct = await encryptSecret("sso-secret", KEY);
    expect(await decryptSecret(ct, KEY, DEFAULT_SECRET_DOMAIN)).toBe("sso-secret");
  });
});

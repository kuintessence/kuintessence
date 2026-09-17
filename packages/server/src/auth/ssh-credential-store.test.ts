import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import {
  listSshCredentialsByAgentIds,
  makePgSshRowLoader,
  saveSshCredential,
} from "./ssh-credential-store";
import { decryptSshRow } from "./ssh-credential-vault";

const KEY = "store-wrapping-key-at-least-32-chars-long";

/** Fake db whose select chain returns a fixed row set, ignoring the condition. */
function selectDb(rows: unknown[]): PgDb {
  return {
    select: () => ({
      from: () => ({
        where: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }),
      }),
    }),
  } as unknown as PgDb;
}

describe("ssh-credential-store", () => {
  test("makePgSshRowLoader maps a row to EncryptedSshRow", async () => {
    const db = selectDb([
      { agentId: "a1", host: "node1", port: 2222, username: "bob", secretEncrypted: "enc" },
    ]);
    const row = await makePgSshRowLoader(db)("a1");
    expect(row).toEqual({ host: "node1", port: 2222, username: "bob", secretEncrypted: "enc" });
  });

  test("makePgSshRowLoader returns null when no row exists", async () => {
    expect(await makePgSshRowLoader(selectDb([]))("missing")).toBeNull();
  });

  test("listSshCredentialsByAgentIds maps only the SQL-filtered rows", async () => {
    const rows = await listSshCredentialsByAgentIds(
      selectDb([
        {
          agentId: "a1",
          host: "node1",
          port: 22,
          username: "bob",
          secretEncrypted: "enc",
          hostKeySha256: "pin",
          updatedAt: new Date("2026-07-13T00:00:00Z"),
          updatedBy: "user-1",
        },
      ]),
      ["a1"],
    );

    expect(rows).toEqual([
      {
        agentId: "a1",
        host: "node1",
        port: 22,
        username: "bob",
        hasSecret: true,
        hostKeySha256: "pin",
        updatedAt: "2026-07-13T00:00:00.000Z",
        updatedBy: "user-1",
      },
    ]);
  });

  test("listSshCredentialsByAgentIds skips SQL for an empty authorization set", async () => {
    let selects = 0;
    const db = {
      select: () => {
        selects += 1;
        throw new Error("select should not run");
      },
    } as unknown as PgDb;

    expect(await listSshCredentialsByAgentIds(db, [])).toEqual([]);
    expect(selects).toBe(0);
  });

  test("saveSshCredential encrypts the secret material before persisting", async () => {
    let captured: Record<string, unknown> | undefined;
    const db = {
      insert: () => ({
        values: (row: Record<string, unknown>) => ({
          onConflictDoUpdate: async () => {
            captured = row;
          },
        }),
      }),
    } as unknown as PgDb;

    await saveSshCredential(db, KEY, {
      agentId: "a1",
      host: "node1",
      port: 22,
      username: "bob",
      secret: { password: "hunter2" },
      updatedBy: "admin@x",
    });

    expect(captured).toBeDefined();
    const enc = captured?.secretEncrypted as string;
    expect(enc).not.toBe("");
    expect(enc).not.toContain("hunter2"); // encrypted, not plaintext
    // Round-trips back through the vault decrypt path.
    const creds = await decryptSshRow(
      { host: "node1", port: 22, username: "bob", secretEncrypted: enc },
      KEY,
    );
    expect(creds.password).toBe("hunter2");
  });
});

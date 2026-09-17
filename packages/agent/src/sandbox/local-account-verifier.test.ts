import { describe, expect, test } from "bun:test";
import type { Spawner } from "../adapters/base";
import { LocalSandboxAccountVerifier } from "./local-account-verifier";

describe("LocalSandboxAccountVerifier", () => {
  test("requires Unix username, uid and gid to match local getent facts", async () => {
    const spawner: Spawner = {
      run: async () => ({
        exitCode: 0,
        stdout: "scientist:x:1001:1002:Scientist:/home/scientist:/bin/bash\n",
        stderr: "",
      }),
    };
    const verifier = new LocalSandboxAccountVerifier(spawner);
    const identity = {
      mode: "MappedAccount" as const,
      backend: "Unix" as const,
      accountId: "00000000-0000-0000-0000-000000000001",
      username: "scientist",
      uid: 1001,
      gid: 1002,
      schedulerAccount: null,
      allowedQueues: [],
    };
    expect(await verifier.verify(identity)).toBe(true);
    expect(await verifier.verify({ ...identity, uid: 1003 })).toBe(false);
    expect(await verifier.verify({ ...identity, uid: 0 })).toBe(false);
  });

  test("requires the Kubernetes ServiceAccount to exist in the mapped namespace", async () => {
    const calls: string[][] = [];
    const verifier = new LocalSandboxAccountVerifier({
      run: async (command) => {
        calls.push(command);
        return { exitCode: 0, stdout: "serviceaccount/user-a\n", stderr: "" };
      },
    });
    expect(
      await verifier.verify({
        mode: "MappedAccount",
        backend: "Kubernetes",
        accountId: "00000000-0000-0000-0000-000000000001",
        namespace: "kq-user-a",
        serviceAccount: "user-a",
        quotaPolicy: null,
      }),
    ).toBe(true);
    expect(calls[0]).toContain("kq-user-a");
  });
});

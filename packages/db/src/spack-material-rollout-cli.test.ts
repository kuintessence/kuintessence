import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpackMaterialRolloutCommand } from "./pg/spack-material-rollout-input";
import { readRolloutCommand } from "./spack-material-rollout-cli";

describe("offline Spack rollout command", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kq-rollout-command-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("reads and validates a local command without connecting to a database", async () => {
    const path = join(directory, "inspect.json");
    await writeFile(path, JSON.stringify({ action: "inspect" }));
    expect(await readRolloutCommand(path)).toEqual({ action: "inspect" });
  });

  test("rejects nonregular, relative, symbolic and oversized command inputs", async () => {
    const path = join(directory, "command.json");
    const alias = join(directory, "alias.json");
    await writeFile(path, JSON.stringify({ action: "inspect" }));
    await symlink(path, alias);
    for (const invalid of [directory, "relative.json", alias]) {
      await expect(readRolloutCommand(invalid)).rejects.toThrow();
    }
    await writeFile(path, " ".repeat(2 * 1024 ** 2 + 1));
    await expect(readRolloutCommand(path)).rejects.toThrow();
  });

  test("rejects invalid JSON, malformed UTF-8 and unrecognized fields", async () => {
    const path = join(directory, "command.json");
    for (const bytes of [
      Buffer.from("{"),
      Buffer.from([0xff]),
      Buffer.from('{"action":"inspect","databaseUrl":"not-accepted"}'),
    ]) {
      await writeFile(path, bytes);
      await expect(readRolloutCommand(path)).rejects.toThrow();
    }
  });

  test("requires explicit typed activation evidence and exact command keys", () => {
    const command = {
      action: "activate",
      operatorId: "12345678-abcd-4123-8123-123456789abc",
      expectedRevision: 2,
      epoch: "12345678-abcd-4123-8123-123456789def",
      inventoryDigest: `sha256:${"a".repeat(64)}`,
      evidence: {
        legacyProcessesStoppedAndDrained: true,
        legacyAccessRevoked: true,
        legacyInventoryComplete: true,
      },
    } as const;
    expect(parseSpackMaterialRolloutCommand(command)).toEqual(command);
    for (const evidence of [
      undefined,
      {},
      { ...command.evidence, legacyAccessRevoked: false },
      { ...command.evidence, legacyInventoryComplete: "true" },
      { ...command.evidence, extra: true },
      Object.defineProperty({ ...command.evidence }, "legacyAccessRevoked", {
        enumerable: false,
        value: false,
      }),
    ]) {
      expect(() => parseSpackMaterialRolloutCommand({ ...command, evidence })).toThrow();
    }
    for (const expectedRevision of [-1, 0.5, 2_147_483_647, "2", NaN]) {
      expect(() => parseSpackMaterialRolloutCommand({ ...command, expectedRevision })).toThrow();
    }
    for (const input of [null, [], "pause", { ...command, force: true }]) {
      expect(() => parseSpackMaterialRolloutCommand(input)).toThrow();
    }
  });

  test("requires bounded retirement reason, selection and configuration-removal evidence", () => {
    const command = {
      action: "retire",
      operatorId: "12345678-abcd-4123-8123-123456789abc",
      expectedRevision: 2,
      epoch: "12345678-abcd-4123-8123-123456789def",
      inventoryDigest: `sha256:${"a".repeat(64)}`,
      bindings: [
        {
          "hello@2.12.1": {
            repositoryId: "a".repeat(64),
            manifestDigest: `sha256:${"b".repeat(64)}`,
          },
        },
      ],
      reason: "Retired deployment configuration",
      evidence: {
        legacyProcessesStoppedAndDrained: true,
        legacyAccessRevoked: true,
        legacyInventoryComplete: true,
        bindingConfigurationsRemoved: true,
      },
    } as const;
    expect(parseSpackMaterialRolloutCommand(command)).toEqual(command);
    for (const reason of ["", " ", " padded", "line\nbreak", "\x7f", "x".repeat(1001), 1]) {
      expect(() => parseSpackMaterialRolloutCommand({ ...command, reason })).toThrow();
    }
    for (const bindings of [[], {}, Array.from({ length: 65 }, () => ({}))]) {
      expect(() => parseSpackMaterialRolloutCommand({ ...command, bindings })).toThrow();
    }
    for (const evidence of [
      { ...command.evidence, bindingConfigurationsRemoved: false },
      { ...command.evidence, bindingConfigurationsRemoved: "true" },
      { ...command.evidence, legacyAccessRevoked: false },
      { ...command.evidence, force: true },
      Object.defineProperty({ ...command.evidence }, "bindingConfigurationsRemoved", {
        enumerable: false,
        value: false,
      }),
    ]) {
      expect(() => parseSpackMaterialRolloutCommand({ ...command, evidence })).toThrow();
    }
    expect(() => parseSpackMaterialRolloutCommand({ ...command, force: true })).toThrow();
    expect(() => parseSpackMaterialRolloutCommand({ ...command, action: "restore" })).toThrow();
  });
});

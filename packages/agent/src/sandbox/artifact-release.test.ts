import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseSandboxArtifacts } from "./artifact-release";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("releaseSandboxArtifacts", () => {
  test("deletes only paths below the managed root and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-release-"));
    roots.push(root);
    const output = join(root, "job-1/outputs/result.json");
    await mkdir(join(root, "job-1/outputs"), { recursive: true });
    await writeFile(output, "{}");
    const first = await releaseSandboxArtifacts(root, [
      { replicaId: "replica-1", storageRef: output },
    ]);
    expect(first).toEqual({ releasedReplicaIds: ["replica-1"], failures: {} });
    const second = await releaseSandboxArtifacts(root, [
      { replicaId: "replica-1", storageRef: output },
    ]);
    expect(second.releasedReplicaIds).toEqual(["replica-1"]);
  });

  test("rejects traversal and a symlinked parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-release-safe-"));
    const outside = await mkdtemp(join(tmpdir(), "kq-sandbox-release-outside-"));
    roots.push(root, outside);
    await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(outside, join(root, "linked"));
    const result = await releaseSandboxArtifacts(root, [
      { replicaId: "outside", storageRef: join(outside, "keep.txt") },
      { replicaId: "linked", storageRef: join(root, "linked/keep.txt") },
    ]);
    expect(Object.keys(result.failures)).toEqual(["outside", "linked"]);
  });
});

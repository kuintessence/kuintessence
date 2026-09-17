import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { SandboxSignedManifest, SandboxUnsignedManifest } from "@kuintessence/shared";
import type { VerifiedSandboxManifest } from "./manifest-verifier";
import { removeSandboxRun, SandboxStager, validateSandboxOutputs } from "./stager";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function batchHash(entries: Array<{ relativePath: string; sha256: string; sizeBytes: number }>) {
  const value = createHash("sha256");
  for (const entry of entries.toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    value.update(`${entry.relativePath}\0${entry.sizeBytes}\0${entry.sha256}\n`);
  }
  return value.digest("hex");
}

function verified(inputHash: string, jobId: string): VerifiedSandboxManifest {
  const uid = process.getuid?.() || 1;
  const gid = process.getgid?.() || 1;
  const unsigned: SandboxUnsignedManifest = {
    jobId,
    script: {
      language: "python",
      entrypoint: "main.py",
      contentBase64: Buffer.from("print('ok')\n").toString("base64"),
      sha256: hash("print('ok')\n"),
      bundleSha256: "1".repeat(64),
    },
    runtime: {
      profileId: "00000000-0000-0000-0000-000000000222",
      kind: "SIF",
      digest: `sha256:${"2".repeat(64)}`,
    },
    executionMode: "RootImpersonation",
    identity: {
      mode: "MappedAccount",
      accountId: "00000000-0000-0000-0000-000000000333",
      backend: "Unix",
      username: "scientist",
      uid,
      gid,
      schedulerAccount: null,
      allowedQueues: [],
    },
    mounts: [
      {
        descriptor: "input",
        ioType: "File",
        mode: "ReadOnly",
        relativePath: "inputs/data.txt",
        containerPath: "/kq/inputs/input",
        expectedSha256: inputHash,
        batchEntries: [],
        sizeLimitBytes: 1_000,
        required: true,
      },
      {
        descriptor: "result",
        ioType: "JSON",
        mode: "WriteOnly",
        relativePath: "outputs/result.json",
        containerPath: "/kq/outputs/result",
        expectedSha256: null,
        batchEntries: [],
        sizeLimitBytes: 1_000,
        required: true,
      },
    ],
    limits: { pids: 16, outputBytes: 2_000, logBytes: 1_000 },
    networkDisabled: true,
  };
  const manifest: SandboxSignedManifest = {
    ...unsigned,
    envelope: {
      keyId: "test",
      nonce: "nonce-1234567890123456",
      issuedAtUnixMs: 1,
      expiresAtUnixMs: 2,
      manifestSha256: "3".repeat(64),
      signatureBase64: "c2ln",
    },
  };
  return {
    manifest,
    unsigned,
    scriptContent: Buffer.from("print('ok')\n"),
    runtimePath: "/managed/python.sif",
  };
}

describe("SandboxStager", () => {
  test("removes the complete private work root after restricted execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-cleanup-"));
    roots.push(root);
    const jobId = "00000000-0000-0000-0000-000000000100";
    await mkdir(join(root, jobId, "inputs"), { recursive: true });
    await writeFile(join(root, jobId, "inputs", "restricted.dat"), "protected");
    await writeFile(join(root, jobId, "script.py"), "print('ok')");

    await removeSandboxRun(root, jobId);

    await expect(readFile(join(root, jobId, "inputs", "restricted.dat"))).rejects.toThrow();
    await expect(removeSandboxRun(root, jobId)).resolves.toBeUndefined();
  });

  test("downloads every external input only after matching its signed stage path", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-source-"));
    roots.push(root);
    const jobId = "00000000-0000-0000-0000-000000000110";
    const input = "downloaded-source\n";
    const downloads: Array<{ sourceUrl: string; targetPath: string; maxBytes: number }> = [];
    const stager = new SandboxStager({
      root,
      ownerUid: process.getuid?.() ?? 0,
      downloadInput: async (request) => {
        downloads.push(request);
        await writeFile(request.targetPath, input);
      },
    });
    const prepared = await stager.prepare(verified(hash(input), jobId), [
      { stagePath: "inputs/data.txt", sourceUrl: "https://storage.example/input" },
    ]);
    expect(downloads).toEqual([
      {
        sourceUrl: "https://storage.example/input",
        targetPath: join(await realpath(root), jobId, "inputs/data.txt"),
        maxBytes: 1_000,
      },
    ]);
    expect(prepared.sandbox.mounts[0]?.expectedSha256).toBe(hash(input));
  });

  test("rejects missing, extra, and traversal input sources before downloading", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-source-reject-"));
    roots.push(root);
    const jobId = "00000000-0000-0000-0000-000000000109";
    let downloads = 0;
    const stager = new SandboxStager({
      root,
      ownerUid: process.getuid?.() ?? 0,
      downloadInput: async () => {
        downloads += 1;
      },
    });
    const fixture = verified(hash("source"), jobId);
    await expect(stager.prepare(fixture, [])).rejects.toThrow("do not match");
    await expect(
      stager.prepare(fixture, [
        { stagePath: "inputs/data.txt", sourceUrl: "https://storage.example/input" },
        { stagePath: "inputs/extra.txt", sourceUrl: "https://storage.example/extra" },
      ]),
    ).rejects.toThrow("do not match");
    await expect(
      stager.prepare(fixture, [
        { stagePath: "../data.txt", sourceUrl: "https://storage.example/input" },
      ]),
    ).rejects.toThrow("path or URL is invalid");
    expect(downloads).toBe(0);
  });

  test("rejects an expired Data Market lease before sandbox download", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-expired-lease-"));
    roots.push(root);
    const jobId = "00000000-0000-0000-0000-000000000119";
    const stager = new SandboxStager({
      root,
      downloadInput: async () => {
        throw new Error("download must not begin");
      },
    });
    await expect(
      stager.prepare(verified(hash("source"), jobId), [
        {
          stagePath: "inputs/data.txt",
          sourceUrl: "https://storage.example/input",
          deliveryLeaseId: "11111111-1111-4111-8111-111111111111",
          deliveryLeaseExpiresAtUnixMs: 1n,
        },
      ]),
    ).rejects.toThrow("lease is invalid or expired");
  });

  test("freezes script/context/input and validates typed outputs under the managed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-stage-"));
    roots.push(root);
    const jobId = "00000000-0000-0000-0000-000000000111";
    const input = "source-data\n";
    await mkdir(join(root, jobId, "inputs"), { recursive: true });
    await writeFile(join(root, jobId, "inputs/data.txt"), input);
    const prepared = await new SandboxStager({ root, ownerUid: process.getuid?.() ?? 0 }).prepare(
      verified(hash(input), jobId),
    );
    expect(prepared.workingDir).toBe(join(await realpath(root), jobId));
    expect(await readFile(prepared.sandbox.scriptHostPath, "utf8")).toBe("print('ok')\n");
    expect(JSON.parse(await readFile(prepared.sandbox.contextHostPath, "utf8")).jobId).toBe(jobId);
    const output = prepared.sandbox.mounts.find((mount) => mount.descriptor === "result");
    if (!output) throw new Error("expected output mount");
    await writeFile(output.hostPath, JSON.stringify({ ok: true }));
    const facts = await validateSandboxOutputs(prepared.sandbox);
    expect(facts[0]?.descriptor).toBe("result");
    expect(facts[0]?.sizeBytes).toBeGreaterThan(0);
  });

  test("rejects a SelfAccount manifest before it creates a work root when the process identity differs", async () => {
    const root = join(tmpdir(), `kq-sandbox-self-account-reject-${Date.now()}`);
    const fixture = verified(hash("source-data\n"), "00000000-0000-0000-0000-000000000113");
    fixture.unsigned.executionMode = "SelfAccount";

    await expect(
      new SandboxStager({
        root,
        processIdentity: { username: "kqagent", uid: 2001, gid: 2001 },
      }).prepare(fixture),
    ).rejects.toThrow("does not match the current Agent process account");
    await expect(lstat(root)).rejects.toThrow();
  });

  test("SelfAccount preserves the Agent account and ignores a root staging owner override", async () => {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined || uid === 0 || gid === 0) return;
    const account = userInfo();
    if (account.uid !== uid || account.gid !== gid) throw new Error("unexpected process account");
    const processIdentity = { username: account.username, uid, gid };
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-self-account-"));
    roots.push(root);
    await chown(root, uid, gid);
    const jobId = "00000000-0000-0000-0000-000000000114";
    const input = "self-account-input\n";
    await mkdir(join(root, jobId, "inputs"), { recursive: true });
    await writeFile(join(root, jobId, "inputs/data.txt"), input);
    const fixture = verified(hash(input), jobId);
    fixture.unsigned.executionMode = "SelfAccount";
    fixture.unsigned.runtimeAttestationId = "a".repeat(64);
    if (fixture.unsigned.identity.backend !== "Unix") throw new Error("expected Unix fixture");
    fixture.unsigned.identity = {
      ...fixture.unsigned.identity,
      username: processIdentity.username,
      uid: processIdentity.uid,
      gid: processIdentity.gid,
    };
    fixture.runtimeAttestationId = fixture.unsigned.runtimeAttestationId;
    fixture.apptainerPath = "/usr/bin/apptainer";
    fixture.seccompProfilePath = "/etc/kuintessence/seccomp.json";
    fixture.attestedNodes = ["slurm-2"];

    const prepared = await new SandboxStager({
      root,
      ownerUid: 0,
      processIdentity,
    }).prepare(fixture);

    const scriptFacts = await lstat(prepared.sandbox.scriptHostPath);
    const output = prepared.sandbox.mounts.find((mount) => mount.descriptor === "result");
    if (!output) throw new Error("expected output mount");
    const outputFacts = await lstat(output.hostPath);
    expect({ uid: scriptFacts.uid, gid: scriptFacts.gid }).toEqual({ uid, gid });
    expect({ uid: outputFacts.uid, gid: outputFacts.gid }).toEqual({ uid, gid });
    expect(prepared.sandbox.selfAccount).toEqual(processIdentity);
  });

  test("verifies prefetched Kubernetes File inputs before PVC staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-k8s-stage-"));
    roots.push(root);
    const jobId = "00000000-0000-0000-0000-000000000112";
    const input = "kubernetes-source\n";
    await mkdir(join(root, jobId, "inputs"), { recursive: true });
    await writeFile(join(root, jobId, "inputs/data.txt"), input);
    const fixture = verified(hash(input), jobId);
    fixture.unsigned.identity = {
      mode: "MappedAccount",
      backend: "Kubernetes",
      accountId: "00000000-0000-0000-0000-000000000001",
      namespace: "kq-user",
      serviceAccount: "user",
    };
    fixture.unsigned.runtime.kind = "OCI";
    fixture.runtimePath = `registry.example/runtime@sha256:${"a".repeat(64)}`;
    const prepared = await new SandboxStager({
      root,
      kubernetesArtifactPvc: "artifacts",
    }).prepare(fixture);
    expect(prepared.workingDir).toBe("/kq");
    expect(prepared.sandbox.mounts[0]?.hostPath).toBe(
      join(await realpath(root), jobId, "inputs/data.txt"),
    );
    expect(prepared.sandbox.kubernetesArtifactPvc).toBe("artifacts");
  });

  test("rejects a symlinked input even when its target hash matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-symlink-"));
    roots.push(root);
    const jobId = "00000000-0000-0000-0000-000000000444";
    const outside = join(root, "outside.txt");
    await writeFile(outside, "source-data\n");
    await mkdir(join(root, jobId, "inputs"), { recursive: true });
    await symlink(outside, join(root, jobId, "inputs/data.txt"));
    await expect(
      new SandboxStager({ root, ownerUid: process.getuid?.() ?? 0 }).prepare(
        verified(hash("source-data\n"), jobId),
      ),
    ).rejects.toThrow("symbolic link");
  });

  test("materializes signed inline JSON and leaves an optional output absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-inline-"));
    roots.push(root);
    const fixture = verified(hash("unused"), "00000000-0000-0000-0000-000000000555");
    const inline = Buffer.from(JSON.stringify({ sample: 3 }), "utf8");
    fixture.unsigned.mounts = [
      {
        descriptor: "config",
        ioType: "JSON",
        mode: "ReadOnly",
        relativePath: "inputs/config.json",
        containerPath: "/kq/inputs/config",
        expectedSha256: hash(inline),
        inlineContentBase64: inline.toString("base64"),
        batchEntries: [],
        sizeLimitBytes: inline.byteLength,
        required: true,
      },
      {
        descriptor: "optional",
        ioType: "Text",
        mode: "WriteOnly",
        relativePath: "outputs/optional.txt",
        containerPath: "/kq/outputs/optional",
        expectedSha256: null,
        batchEntries: [],
        sizeLimitBytes: 100,
        required: false,
      },
    ];
    const prepared = await new SandboxStager({ root, ownerUid: process.getuid?.() ?? 0 }).prepare(
      fixture,
    );
    const config = prepared.sandbox.mounts.find((mount) => mount.descriptor === "config");
    expect(config && (await readFile(config.hostPath, "utf8"))).toBe('{"sample":3}');
    expect(await validateSandboxOutputs(prepared.sandbox)).toEqual([]);
  });

  test("validates every signed FileBatch entry and its aggregate hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-batch-"));
    roots.push(root);
    const jobId = "00000000-0000-0000-0000-000000000666";
    const first = Buffer.from("alpha");
    const second = Buffer.from("beta");
    const entries = [
      { relativePath: "0000-a.txt", sha256: hash(first), sizeBytes: first.byteLength },
      { relativePath: "0001-b.txt", sha256: hash(second), sizeBytes: second.byteLength },
    ];
    await mkdir(join(root, jobId, "inputs/batch"), { recursive: true });
    await writeFile(join(root, jobId, "inputs/batch/0000-a.txt"), first);
    await writeFile(join(root, jobId, "inputs/batch/0001-b.txt"), second);
    const fixture = verified(hash("unused"), jobId);
    fixture.unsigned.mounts = [
      {
        descriptor: "batch",
        ioType: "FileBatch",
        mode: "ReadOnly",
        relativePath: "inputs/batch",
        containerPath: "/kq/inputs/batch",
        expectedSha256: batchHash(entries),
        batchEntries: entries,
        sizeLimitBytes: first.byteLength + second.byteLength,
        required: true,
      },
    ];
    await expect(
      new SandboxStager({ root, ownerUid: process.getuid?.() ?? 0 }).prepare(fixture),
    ).resolves.toBeDefined();
    await chmod(join(root, jobId, "inputs/batch"), 0o750);

    const invalidRoot = await mkdtemp(join(tmpdir(), "kq-sandbox-batch-invalid-"));
    roots.push(invalidRoot);
    const invalidJobId = "00000000-0000-0000-0000-000000000667";
    await mkdir(join(invalidRoot, invalidJobId, "inputs/batch"), { recursive: true });
    await writeFile(join(invalidRoot, invalidJobId, "inputs/batch/0000-a.txt"), first);
    await writeFile(join(invalidRoot, invalidJobId, "inputs/batch/0001-b.txt"), second);
    const invalidFixture = verified(hash("unused"), invalidJobId);
    invalidFixture.unsigned.mounts = structuredClone(fixture.unsigned.mounts);
    invalidFixture.unsigned.mounts[0]?.batchEntries?.push({
      relativePath: "unexpected.txt",
      sha256: hash("unexpected"),
      sizeBytes: 10,
    });
    await expect(
      new SandboxStager({ root: invalidRoot, ownerUid: process.getuid?.() ?? 0 }).prepare(
        invalidFixture,
      ),
    ).rejects.toThrow("entries mismatch");
    await chmod(join(invalidRoot, invalidJobId, "inputs/batch"), 0o750);
  });

  test("materializes a signed empty FileBatch without requiring a download URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sandbox-empty-batch-"));
    roots.push(root);
    const jobId = "00000000-0000-0000-0000-000000000668";
    const fixture = verified(hash("unused"), jobId);
    fixture.unsigned.mounts = [
      {
        descriptor: "batch",
        ioType: "FileBatch",
        mode: "ReadOnly",
        relativePath: "inputs/batch",
        containerPath: "/kq/inputs/batch",
        expectedSha256: batchHash([]),
        batchEntries: [],
        sizeLimitBytes: 1,
        required: true,
      },
    ];
    const prepared = await new SandboxStager({
      root,
      ownerUid: process.getuid?.() ?? 0,
      downloadInput: async () => {
        throw new Error("empty FileBatch must not download");
      },
    }).prepare(fixture, []);
    expect(prepared.sandbox.mounts[0]?.hostPath).toBe(
      join(await realpath(root), jobId, "inputs/batch"),
    );
  });
});

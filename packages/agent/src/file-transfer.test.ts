import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCloudToClusterArgv,
  buildHostCloudToClusterArgv,
  containerTransferSourceArgv,
  hasPathTraversal,
  normalizeClusterToCloudSourceError,
} from "./file-transfer";

describe("hasPathTraversal", () => {
  test("accepts run-dir-relative paths (no traversal)", () => {
    expect(hasPathTraversal("/run/123/mesh.tar.gz")).toBe(false);
    expect(hasPathTraversal("/run/123/inputs/data.csv")).toBe(false);
    expect(hasPathTraversal("mesh.tar.gz")).toBe(false);
    // A filename merely containing ".." (not as a segment) is fine.
    expect(hasPathTraversal("/run/123/a..b.txt")).toBe(false);
  });

  test("rejects '..' segments (escape the run dir)", () => {
    expect(hasPathTraversal("/run/123/../../etc/cron.d/x")).toBe(true);
    expect(hasPathTraversal("../x")).toBe(true);
    expect(hasPathTraversal("/run/123/a/../../../etc/passwd")).toBe(true);
  });
});

describe("normalizeClusterToCloudSourceError", () => {
  test("maps missing source file variants to a stable error code", () => {
    expect(
      normalizeClusterToCloudSourceError(
        new Error("ENOENT: no such file or directory, statx '/scratch/me/inputs/README.md'"),
      ),
    ).toBe("CLUSTER_SOURCE_FILE_UNAVAILABLE");
    expect(
      normalizeClusterToCloudSourceError(
        "cat: /scratch/me/inputs/README.md: No such file or directory",
      ),
    ).toBe("CLUSTER_SOURCE_FILE_UNAVAILABLE");
  });

  test("preserves unrelated transfer failures", () => {
    expect(normalizeClusterToCloudSourceError(new Error("part URL request timed out"))).toBe(
      "part URL request timed out",
    );
  });
});

describe("buildCloudToClusterArgv", () => {
  // SECURITY regression: targetPath derives from a workflow's unvalidated
  // stagePath and runs under `docker exec -u root sh -c`. It must be passed as a
  // positional arg, never interpolated into the script — otherwise a workflow
  // author achieves root RCE on the cluster node.
  test("passes url and targetPath as positional args, never interpolated", () => {
    const url = "http://localhost:9000/bucket/obj?X-Amz-Signature=abc&x=1";
    const malicious = '/run/x"; touch /tmp/pwned; "y.txt';
    const argv = buildCloudToClusterArgv("cid", url, malicious, 3, 2);

    const cIdx = argv.indexOf("-c");
    const script = argv[cIdx + 1] ?? "";
    // The script references positional params only.
    expect(script).toContain('"$1"');
    expect(script).toContain('"$2"');
    // The dangerous values do NOT appear inside the script string.
    expect(script).not.toContain(malicious);
    expect(script).not.toContain(url);
    // url + targetPath are the leading positional args after the "_" $0 placeholder.
    expect(argv.slice(cIdx + 2, cIdx + 5)).toEqual(["_", url, malicious]);
  });

  test("targets the given container as root", () => {
    const argv = buildCloudToClusterArgv("my-container", "http://u", "/p", 3, 2);
    expect(argv.slice(0, 5)).toEqual(["docker", "exec", "-u", "root", "my-container"]);
  });

  test("appends maxRetries + backoffSec as the last two positional args", () => {
    const argv = buildCloudToClusterArgv("cid", "http://x/url", "out/path", 5, 3);
    expect(argv.slice(-3, -1)).toEqual(["5", "3"]);
  });

  test("passes optional curl connect-to mapping as data", () => {
    const connectTo = "localhost:19000:host.docker.internal:19000";
    const argv = buildCloudToClusterArgv("cid", "http://x/url", "out/path", 5, 3, connectTo);
    const cIdx = argv.indexOf("-c");
    const script = argv[cIdx + 1] ?? "";

    expect(script).toContain('--connect-to "$connect"');
    expect(script).not.toContain(connectTo);
    expect(argv.at(-1)).toBe(connectTo);
  });

  test("script is a bounded retry-resume loop using curl -C -", () => {
    const argv = buildCloudToClusterArgv("cid", "http://x/url", "out/path", 5, 3);
    const cIdx = argv.indexOf("-c");
    const script = argv[cIdx + 1] ?? "";
    expect(script).toContain("-C -");
    expect(script).toContain("while ! curl");
    expect(script).toContain('[ "$n" -lt "$attempts" ]');
    expect(script).toContain('sleep "$delay"');
    // maxRetries + backoffSec are referenced positionally ($3/$4), so the loop
    // body carries no decimal literal of the supplied values.
    expect(script).not.toContain("ge 5");
    expect(script).not.toContain("sleep 3");
  });

  test("does not relax the staging directory or its parent permissions", () => {
    const argv = buildCloudToClusterArgv("cid", "http://x/url", "/run/job/inputs/a.txt", 5, 3);
    const cIdx = argv.indexOf("-c");
    const script = argv[cIdx + 1] ?? "";

    expect(script).toContain('mkdir -m 700 -- "$component"');
    expect(script).not.toContain("chmod 1777");
    expect(script).not.toContain("parent=");
  });
});

describe("buildHostCloudToClusterArgv", () => {
  test("uses the same positional-argument script without docker exec", () => {
    const argv = buildHostCloudToClusterArgv(
      "http://localhost:19000/o",
      "/scratch/me/inputs/o",
      3,
      2,
      "localhost:19000:host.docker.internal:19000",
    );

    expect(argv.slice(0, 3)).toEqual(["sh", "-c", expect.any(String)]);
    expect(argv.slice(3)).toEqual([
      "_",
      "http://localhost:19000/o",
      "/scratch/me/inputs/o",
      "3",
      "2",
      "localhost:19000:host.docker.internal:19000",
    ]);
  });

  test("preserves an existing private job root", async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-transfer-root-"));
    const mockBin = join(root, "bin");
    const targetPath = join(root, "inputs", "input.txt");
    try {
      await chmod(root, 0o700);
      await mkdir(mockBin, { mode: 0o700 });
      const curl = join(mockBin, "curl");
      await writeFile(
        curl,
        '#!/bin/sh\nset -eu\nout=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then out=$2; shift 2; else shift; fi\ndone\nprintf payload > "$out"\n',
        { mode: 0o700 },
      );
      const argv = buildHostCloudToClusterArgv("http://unused", targetPath, 1, 0);
      const proc = Bun.spawn(argv, {
        env: { ...process.env, PATH: `${mockBin}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect(await readFile(targetPath, "utf8")).toBe("payload");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("container downloads require matching bytes and a publish acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-transfer-confirm-"));
  try {
    const input = join(root, "input"),
      target = join(root, "output");
    await writeFile(input, "payload");
    await writeFile(target, "keep");
    const digest = new Bun.CryptoHasher("sha256").update("payload").digest("hex");
    for (const [hash, approval, ok] of [
      [digest, "", false],
      ["0".repeat(64), "publish\n", false],
      [digest, "publish\n", true],
    ] as const) {
      const argv = buildCloudToClusterArgv(
        "node",
        `file://${input}`,
        target,
        1,
        0,
        "",
        { sha256: hash, size: 7 },
        true,
      );
      const proc = Bun.spawn(argv.slice(argv.indexOf("sh")), {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (approval) proc.stdin.write(approval);
      await proc.stdin.end();
      expect((await proc.exited) === 0).toBe(ok);
      expect(await readFile(target, "utf8")).toBe(ok ? "payload" : "keep");
    }
    const reserved = join(root, ".kq-replicas");
    await mkdir(reserved);
    await writeFile(join(reserved, "private"), "private");
    await symlink(reserved, join(root, "alias"));
    const argv = containerTransferSourceArgv("node", join(root, "alias/private"));
    const reader = Bun.spawn(argv.slice(argv.indexOf("sh")), { stdout: "pipe", stderr: "pipe" });
    expect(await reader.exited).not.toBe(0);
    expect(await new Response(reader.stdout).text()).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

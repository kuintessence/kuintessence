import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function preflight(fixture: string, verified = false) {
  const dir = await mkdtemp(join(tmpdir(), "kq-rustfs-migration-"));
  try {
    await writeFile(
      join(dir, "docker"),
      `#!/usr/bin/env sh
set -eu
case "$FIXTURE:$*" in
  unavailable:*) exit 1 ;;
  container:ps*) echo legacy-container ;;
  volume:*com.docker.compose.volume=scheduler-minio-data*) echo legacy-volume ;;
esac
`,
      { mode: 0o755 },
    );
    const proc = Bun.spawn(["bash", "deploy/rustfs/check-migration.sh", "test-project"], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        FIXTURE: fixture,
        KQ_RUSTFS_MIGRATION_VERIFIED: verified ? "true" : "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { code, stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("RustFS migration preflight", () => {
  test("permits a fresh Compose project", async () => {
    expect((await preflight("fresh")).code).toBe(0);
  });

  test.each(["container", "volume"])("rejects unverified legacy %s", async (kind) => {
    const result = await preflight(kind);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("refusing to switch to RustFS");
  });

  test("fails closed if Docker inspection fails", async () => {
    expect((await preflight("unavailable")).code).not.toBe(0);
  });

  test("permits an explicitly verified migration", async () => {
    expect((await preflight("volume", true)).code).toBe(0);
  });

  test("guards startup before restart can remove old containers", async () => {
    const script = await Bun.file("scripts/compose.ts").text();
    expect(script.indexOf("await checkStorageMigration(profile, opts)")).toBeLessThan(
      script.indexOf("const commands = commandFor(profile"),
    );
    const scheduler = await Bun.file("deploy/schedulers/preflight.sh").text();
    expect(scheduler).toContain("bash deploy/rustfs/check-migration.sh");
  });

  test("Helm checks live legacy resources in addition to legacy values", async () => {
    const template = await Bun.file(
      "deploy/helm/kq-platform/templates/rustfs-statefulset.yaml",
    ).text();
    expect(template).toContain('lookup "apps/v1" "StatefulSet"');
    expect(template).toContain('lookup "v1" "PersistentVolumeClaim"');
    expect(template).toContain("not .Values.rustfs.migrationVerified");
    expect(template).toContain("version references, and retention");
  });
});

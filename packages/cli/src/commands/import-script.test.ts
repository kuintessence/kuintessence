import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitScript } from "./import-script";

for (const format of ["sha1", "sha256"]) {
  test(`reads only the committed regular UTF-8 Git blob (${format})`, async () => {
    const repo = await mkdtemp(join(tmpdir(), "kq-git-test-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    try {
      git("init", "-q", "--template=", `--object-format=${format}`);
      const content = "\uFEFF# 示例\r\n";
      await writeFile(join(repo, "a[1].py"), content);
      await symlink("a[1].py", join(repo, "link"));
      await writeFile(join(repo, "big"), Buffer.alloc(1_000_001));
      await writeFile(join(repo, "binary"), Buffer.from([0xff]));
      git("add", ".");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "-qm",
        "fixture",
      );
      const commit = git("rev-parse", "HEAD");
      await writeFile(join(repo, "a[1].py"), "edited");
      expect(await readGitScript(repo, commit, "a[1].py")).toEqual({
        content,
        gitSource: { commit, path: "a[1].py", blob: git("rev-parse", "HEAD:a[1].py") },
      });
      for (const path of ["link", "big", "binary", "../a[1].py", "missing"])
        await expect(readGitScript(repo, commit, path)).rejects.toThrow();
      await expect(readGitScript(repo, "HEAD", "a[1].py")).rejects.toThrow();
      await expect(
        readGitScript("https://user:password@example.test/git", commit, "a[1].py"),
      ).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
}

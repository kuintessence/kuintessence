import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { SandboxGitLocationSchema, SandboxScriptDefinitionSchema } from "@kuintessence/shared";
import type { Command } from "commander";
import { z } from "zod";
import { ApiClient } from "../lib/api-client";
import { loadCliConfig } from "../lib/config";

const exec = promisify(execFile);

export async function readGitScript(repository: string, commit: string, path: string) {
  const remote = /^[a-z][a-z\d+.-]*:\/\//i.test(repository);
  const source = SandboxGitLocationSchema.parse({
    ...(remote ? { repository } : {}),
    commit,
    path,
  });
  const temporary = remote ? await mkdtemp(join(tmpdir(), "kq-script-")) : undefined;
  const directory = temporary ?? resolve(repository);
  // Git's ambient repository overrides must not redirect the import into another worktree.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "https",
  };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_SHALLOW_FILE",
  ]) {
    delete env[key];
  }
  const git = async (...args: string[]) =>
    (
      await exec("git", ["--no-replace-objects", "--literal-pathspecs", "-C", directory, ...args], {
        encoding: "buffer",
        maxBuffer: 1_000_000,
        timeout: 120_000,
        env,
      })
    ).stdout;
  try {
    if (temporary) {
      await git(
        "init",
        "--bare",
        "--template=",
        `--object-format=${commit.length === 40 ? "sha1" : "sha256"}`,
      );
      await git(
        "-c",
        "fetch.fsckObjects=true",
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--depth=1",
        "--",
        repository,
        commit,
      );
    }
    if ((await git("cat-file", "-t", commit)).toString().trim() !== "commit")
      throw new Error("Expected an immutable Git commit");
    const entry = (await git("ls-tree", "--full-tree", "-z", commit, "--", path)).toString();
    const match = /^(?:100644|100755) blob ([a-f0-9]+)\t/.exec(entry);
    if (!match?.[1] || entry.slice(match[0].length) !== `${path}\0`)
      throw new Error("Expected a regular file in the selected Git commit");
    const blob = match[1];
    if (Number((await git("cat-file", "-s", blob)).toString()) > 1_000_000)
      throw new Error("Git script exceeds 1,000,000 bytes");
    const bytes = await git("cat-file", "blob", blob);
    if (bytes.includes(0)) throw new Error("Expected a UTF-8 text script");
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { content, gitSource: { ...source, blob } };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

export function registerScriptImport(sw: Command): void {
  sw.command("import-script <repository> <commit> <path>")
    .description("Import a pinned Git file into the Sandbox script catalog")
    .requiredOption("--definition <file>", "Script metadata and I/O contract (JSON)")
    .option("--asset <uuid>", "Append a revision to an existing script")
    .action(
      async (
        repository: string,
        commit: string,
        path: string,
        options: { definition: string; asset?: string },
      ) => {
        const definition = SandboxScriptDefinitionSchema.parse(
          JSON.parse(await readFile(options.definition, "utf8")),
        );
        const asset = options.asset === undefined ? undefined : z.uuid().parse(options.asset);
        const script = await readGitScript(repository, commit, path);
        const api = ApiClient.fromConfig(loadCliConfig());
        const endpoint = asset ? `/sandbox/scripts/${asset}/revisions` : "/sandbox/scripts";
        type Revision = { assetId: string; revision: number; contentSha256: string };
        const { data } = await api.post<{ data: Revision | { revision: Revision } }>(endpoint, {
          ...definition,
          ...script,
        });
        const revision = "assetId" in data ? data : data.revision;
        console.log(
          JSON.stringify({
            assetId: revision.assetId,
            revision: revision.revision,
            sha256: revision.contentSha256,
          }),
        );
      },
    );
}

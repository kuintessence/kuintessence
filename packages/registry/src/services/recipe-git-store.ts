import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  RecipeCommitSchema,
  type RecipeRepository,
  RecipeRepositoryIdSchema,
  RecipeRepositoryNameSchema,
  type RecipeSnapshot,
  RecipeSnapshotSchema,
} from "@kuintessence/shared";
import { z } from "zod";
import { inspectRecipeTree } from "./recipe-diagnostics";
import {
  checkRecipeObjects,
  createRecipeTextReader,
  DEFAULT_RECIPE_LIMITS,
  parseRecipeTree,
  RecipeStoreError,
  type RecipeStoreLimits,
  runRecipeGit,
  writeRecipeBundle,
} from "./recipe-git";
import { preflightRecipeBundle } from "./recipe-pack-preflight";

const IdentitySchema = z.strictObject({
  id: RecipeRepositoryIdSchema,
  repository: RecipeRepositoryNameSchema,
});
const ZERO_COMMIT = "0".repeat(40);
const ACTIVE_REF = "refs/kq/active";
const AUDIT_REF = "refs/kq/audit/head";

export class RecipeGitStore {
  readonly limits: RecipeStoreLimits;
  private writeTail = Promise.resolve();
  private pendingImports = 0;
  private pendingExports = 0;

  constructor(
    readonly root: string,
    limits: Partial<RecipeStoreLimits> = {},
  ) {
    if (!isAbsolute(root)) throw new Error("SPACK_RECIPE_STORE_DIR must be absolute");
    this.limits = { ...DEFAULT_RECIPE_LIMITS, ...limits };
  }

  static repositoryId(repository: string): string {
    return createHash("sha256").update(RecipeRepositoryNameSchema.parse(repository)).digest("hex");
  }

  async list(): Promise<RecipeRepository[]> {
    const entries = await readdir(join(this.root, "repositories")).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    const result: RecipeRepository[] = [];
    for (const entry of entries.sort()) {
      if (!/^[a-f0-9]{64}\.git$/.test(entry)) continue;
      result.push(await this.get(entry.slice(0, -4)));
    }
    return result.sort((a, b) => a.repository.localeCompare(b.repository));
  }

  async get(id: string): Promise<RecipeRepository> {
    const directory = this.repositoryPath(id);
    const identity = await this.readIdentity(id);
    const entries = await readdir(join(this.root, "manifests", id)).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    const snapshots: RecipeSnapshot[] = [];
    for (const entry of entries.sort()) {
      if (!/^[a-f0-9]{40}\.json$/.test(entry)) continue;
      const snapshot = RecipeSnapshotSchema.parse(
        JSON.parse(await readFile(join(this.root, "manifests", id, entry), "utf8")),
      );
      if (`${snapshot.commit}.json` !== entry)
        throw new RecipeStoreError(500, "Corrupt snapshot identity");
      snapshots.push(snapshot);
    }
    return {
      ...identity,
      activeCommit: await this.readRef(directory, ACTIVE_REF),
      snapshots: snapshots.sort((a, b) => b.importedAt.localeCompare(a.importedAt)),
    };
  }

  async importBundle(
    repository: string,
    input: Uint8Array | ReadableStream<Uint8Array>,
    actor: string,
  ): Promise<RecipeRepository> {
    const parsed = RecipeRepositoryNameSchema.safeParse(repository);
    if (!parsed.success) throw new RecipeStoreError(400, "Invalid recipe repository namespace");
    if (this.pendingImports >= 4) throw new RecipeStoreError(429, "Too many recipe imports");
    this.pendingImports += 1;
    let staging: string | undefined;
    try {
      await this.prepare();
      staging = await mkdtemp(join(this.root, "staging", "import-"));
      const bundlePath = join(staging, "input.bundle");
      const digest = await writeRecipeBundle(bundlePath, input, this.limits.maxBundleBytes);
      const importDirectory = staging;
      return await this.serialize(async () => {
        await preflightRecipeBundle(bundlePath, this.limits);
        const source = join(importDirectory, "source.git");
        await this.git(importDirectory, ["init", "--bare", "--template=", source]);
        await this.git(source, ["bundle", "verify", bundlePath]);
        const heads = await this.git(source, ["bundle", "list-heads", bundlePath, "HEAD"]);
        if (!/^[a-f0-9]{40} HEAD\n$/.test(heads.stdout.toString())) {
          throw new RecipeStoreError(422, "Bundle must contain a SHA-1 HEAD reference");
        }
        await this.git(source, [
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          bundlePath,
          "HEAD:refs/heads/import",
        ]);
        await this.git(source, ["fsck", "--full", "--strict", "--no-reflogs"]);
        const commit = RecipeCommitSchema.parse(
          (await this.git(source, ["rev-parse", "refs/heads/import^{commit}"])).stdout
            .toString()
            .trim(),
        );
        checkRecipeObjects(
          (
            await this.git(source, [
              "cat-file",
              "--batch-all-objects",
              "--batch-check=%(objectsize)",
            ])
          ).stdout,
          this.limits,
        );
        const files = parseRecipeTree(
          (await this.git(source, ["ls-tree", "-r", "-z", "-l", "--full-tree", commit])).stdout,
          this.limits,
        );
        const report = await inspectRecipeTree(
          files,
          createRecipeTextReader(source, files, this.limits),
        );
        const id = RecipeGitStore.repositoryId(repository);
        const destination = this.repositoryPath(id);
        await this.ensureRepository(id, repository, importDirectory);
        const snapshotRef = `refs/kq/snapshots/${commit}`;
        const previousSnapshot = await this.readRef(destination, snapshotRef);
        const manifest = join(this.root, "manifests", id, `${commit}.json`);
        await mkdir(join(this.root, "manifests", id), { recursive: true, mode: 0o700 });
        try {
          await this.git(destination, [
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            source,
            `${commit}:${snapshotRef}`,
          ]);
          // A repeated import preserves its original provenance even when packaging differs.
          try {
            if (!(await stat(manifest)).isFile()) {
              throw new RecipeStoreError(500, "Snapshot manifest is not a regular file");
            }
          } catch (error) {
            if (!isMissing(error)) throw error;
            const snapshot: RecipeSnapshot = {
              commit,
              importedAt: new Date().toISOString(),
              importedBy: actor,
              bundleSha256: digest,
              fileCount: files.length,
              totalBytes: files.reduce((sum, file) => sum + file.size, 0),
              ...report,
              validation: "static-only",
            };
            await this.writeJsonAtomically(manifest, snapshot);
          }
        } catch (error) {
          if (previousSnapshot === null) {
            await this.git(destination, ["update-ref", "-d", snapshotRef, commit]);
          }
          throw error;
        }
        return this.get(id);
      });
    } finally {
      this.pendingImports -= 1;
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }

  async activate(
    id: string,
    commit: string,
    expectedActiveCommit: string | null,
    actor: string,
  ): Promise<RecipeRepository> {
    this.validateCommit(commit);
    if (expectedActiveCommit !== null) this.validateCommit(expectedActiveCommit);
    return this.serialize(async () => {
      const repository = await this.get(id);
      const snapshot = repository.snapshots.find((item) => item.commit === commit);
      if (!snapshot) throw new RecipeStoreError(404, "Recipe snapshot not found");
      if (snapshot.diagnostics.some((item) => item.severity === "error")) {
        throw new RecipeStoreError(422, "Recipe snapshot contains blocking structural diagnostics");
      }
      if (repository.activeCommit !== expectedActiveCommit) {
        throw new RecipeStoreError(409, "Active recipe changed; reload before retrying");
      }
      const audit = await this.createAuditEvent(
        id,
        "activate",
        expectedActiveCommit,
        commit,
        actor,
      );
      const result = await this.git(
        this.repositoryPath(id),
        ["update-ref", "--stdin", "--create-reflog", "-m", this.auditMessage("activate", actor)],
        true,
        [
          "start",
          `update ${ACTIVE_REF} ${commit} ${expectedActiveCommit ?? ZERO_COMMIT}`,
          `update ${AUDIT_REF} ${audit.commit} ${audit.previous ?? ZERO_COMMIT}`,
          "prepare",
          "commit",
          "",
        ].join("\n"),
      );
      if (result.code !== 0)
        throw new RecipeStoreError(409, "Active recipe changed; reload before retrying");
      return this.get(id);
    });
  }

  async deactivate(
    id: string,
    expectedActiveCommit: string,
    actor: string,
  ): Promise<RecipeRepository> {
    this.validateCommit(expectedActiveCommit);
    return this.serialize(async () => {
      const repository = await this.get(id);
      if (repository.activeCommit !== expectedActiveCommit) {
        throw new RecipeStoreError(409, "Active recipe changed; reload before retrying");
      }
      const audit = await this.createAuditEvent(
        id,
        "deactivate",
        expectedActiveCommit,
        null,
        actor,
      );
      const result = await this.git(
        this.repositoryPath(id),
        ["update-ref", "--stdin", "--create-reflog", "-m", this.auditMessage("deactivate", actor)],
        true,
        [
          "start",
          `delete ${ACTIVE_REF} ${expectedActiveCommit}`,
          `update ${AUDIT_REF} ${audit.commit} ${audit.previous ?? ZERO_COMMIT}`,
          "prepare",
          "commit",
          "",
        ].join("\n"),
      );
      if (result.code !== 0)
        throw new RecipeStoreError(409, "Active recipe changed; reload before retrying");
      return this.get(id);
    });
  }

  async archive(
    id: string,
    commit: string,
  ): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
    this.validateCommit(commit);
    if (this.pendingExports >= 4) throw new RecipeStoreError(429, "Too many recipe exports");
    this.pendingExports += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.pendingExports -= 1;
    };
    let directory: string | undefined;
    try {
      const repository = await this.get(id);
      if (!repository.snapshots.some((item) => item.commit === commit)) {
        throw new RecipeStoreError(404, "Recipe snapshot not found");
      }
      await this.prepare();
      directory = await mkdtemp(join(this.root, "staging", "export-"));
      const exportDirectory = directory;
      const path = join(directory, "recipes.tar");
      await this.git(this.repositoryPath(id), [
        "archive",
        "--format=tar",
        `--output=${path}`,
        commit,
      ]);
      const size = (await stat(path)).size;
      const file = await open(path, "r");
      let closed = false;
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const close = async () => {
        if (closed) return;
        closed = true;
        clearTimeout(expiry);
        try {
          await file.close();
        } finally {
          try {
            await rm(exportDirectory, { recursive: true, force: true });
          } finally {
            release();
          }
        }
      };
      return {
        size,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            expiry = setTimeout(() => {
              void close().then(
                () => controller.error(new RecipeStoreError(429, "Recipe export expired")),
                (error: unknown) => controller.error(error),
              );
            }, 5 * 60_000);
            expiry.unref();
          },
          async pull(controller) {
            try {
              const bytes = new Uint8Array(64 * 1024);
              const result = await file.read(bytes);
              if (result.bytesRead === 0) {
                await close();
                controller.close();
              } else {
                controller.enqueue(bytes.subarray(0, result.bytesRead));
              }
            } catch (error) {
              await close();
              controller.error(error);
            }
          },
          cancel: close,
        }),
      };
    } catch (error) {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        release();
      }
      throw error;
    }
  }

  private async prepare(): Promise<void> {
    for (const name of ["repositories", "manifests", "staging"]) {
      await mkdir(join(this.root, name), { recursive: true, mode: 0o700 });
    }
  }

  private repositoryPath(id: string): string {
    if (!RecipeRepositoryIdSchema.safeParse(id).success)
      throw new RecipeStoreError(400, "Invalid recipe repository id");
    return join(this.root, "repositories", `${id}.git`);
  }

  private validateCommit(commit: string): void {
    if (!RecipeCommitSchema.safeParse(commit).success)
      throw new RecipeStoreError(400, "Invalid recipe commit");
  }

  private async readIdentity(id: string) {
    try {
      const identity = IdentitySchema.parse(
        JSON.parse(await readFile(join(this.repositoryPath(id), "kq-repository.json"), "utf8")),
      );
      if (identity.id !== id || RecipeGitStore.repositoryId(identity.repository) !== id) {
        throw new RecipeStoreError(500, "Corrupt recipe repository identity");
      }
      return identity;
    } catch (error) {
      if (isMissing(error)) throw new RecipeStoreError(404, "Recipe repository not found");
      throw error;
    }
  }

  private async ensureRepository(id: string, repository: string, staging: string): Promise<void> {
    try {
      await this.readIdentity(id);
      return;
    } catch (error) {
      if (!(error instanceof RecipeStoreError) || error.status !== 404) throw error;
    }
    const temporary = join(staging, "destination.git");
    await this.git(staging, ["init", "--bare", "--template=", temporary]);
    await mkdir(join(temporary, "info"), { recursive: true });
    // Preserve exact tree bytes even when imported .gitattributes requests export filtering.
    await writeFile(join(temporary, "info", "attributes"), "* -export-ignore -export-subst\n", {
      mode: 0o600,
    });
    await writeFile(join(temporary, "kq-repository.json"), JSON.stringify({ id, repository }), {
      mode: 0o600,
    });
    await rename(temporary, this.repositoryPath(id));
  }

  private async readRef(directory: string, ref: string): Promise<string | null> {
    const result = await this.git(directory, ["rev-parse", "--verify", "--quiet", ref], true);
    if (result.code === 1) return null;
    if (result.code !== 0) throw new RecipeStoreError(500, "Cannot read active recipe reference");
    return RecipeCommitSchema.parse(result.stdout.toString().trim());
  }

  private async writeJsonAtomically(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async createAuditEvent(
    id: string,
    action: "activate" | "deactivate",
    previousActiveCommit: string | null,
    activeCommit: string | null,
    actor: string,
  ): Promise<{ commit: string; previous: string | null }> {
    const directory = this.repositoryPath(id);
    const previous = await this.readRef(directory, AUDIT_REF);
    const event = JSON.stringify({
      version: 1,
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      action,
      actor,
      previousActiveCommit,
      activeCommit,
      previousEvent: previous,
    });
    const blob = (await this.git(directory, ["hash-object", "-w", "--stdin"], false, event)).stdout
      .toString()
      .trim();
    const tree = (
      await this.git(directory, ["mktree"], false, `100644 blob ${blob}\tevent.json\n`)
    ).stdout
      .toString()
      .trim();
    const parents = previous === null ? [] : ["-p", previous];
    const commit = (
      await this.git(directory, [
        "commit-tree",
        tree,
        ...parents,
        "-m",
        this.auditMessage(action, actor),
      ])
    ).stdout
      .toString()
      .trim();
    return { commit: RecipeCommitSchema.parse(commit), previous };
  }

  private auditMessage(action: string, actor: string): string {
    const safeActor = Array.from(actor)
      .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      .join("")
      .slice(0, 200);
    return `${action} by ${safeActor}`;
  }

  private git(directory: string, args: string[], allowFailure = false, input?: string) {
    return runRecipeGit(directory, args, this.limits, allowFailure, input);
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(action);
    // Only the queue tail consumes rejection; the caller receives the original failed promise.
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

import assert from "node:assert/strict";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  RecipeRepositorySchema,
  SpackMaterialBindingSchema,
  SpackMaterialCatalogSchema,
  SpackMaterialManifestSchema,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import { z } from "zod";
import { ReleaseSchema } from "../spack-case/api";
import { CaseSchema, LIMITS, repositoryId } from "./export-contract";
import { readBounded, requireAbsent, safeDirectory, unchanged, verifyInventory } from "./export-files";
import {
  handoffDigest,
  handoffJson,
  hashHandoffStream,
  readManagedDelivery,
} from "./managed-handoff-input";

const PhaseSchema = z.enum(["prepare", "verify"]);
type Phase = z.infer<typeof PhaseSchema>;
type Stage =
  | "guard"
  | "input"
  | "control"
  | "login"
  | "catalog"
  | "manifest"
  | "recipe"
  | "blobs"
  | "commit";
type Code = "SCHEMA_INVALID" | "ASSERTION_FAILED" | "INVALID_JSON" | "TIMEOUT" | "HANDOFF_FAILED";
const BindingsSchema = z.record(z.string().min(1).max(4096), SpackMaterialBindingSchema);
const maximumJson = 2 * 1024 ** 2;
const maximumControl = 64 * 1024;
const timeoutMs = 10 * 60_000;
const registry = "http://registry:3100/api";
const base = "/spack/material-repositories";

export class ManagedHandoffError extends Error {
  constructor(
    readonly stage: Stage,
    readonly code: Code,
  ) {
    super(`Spack artifact managed handoff: stage=${stage} code=${code}`);
  }
}

export interface ManagedHandoffOptions {
  deliveryDirectory?: string;
  controlDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onStage?: (stage: Stage) => void;
}

async function responseBytes(response: Response, maximum: number, signal: AbortSignal) {
  assert.equal(response.status, 200);
  assert(response.body);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      assert(size <= maximum);
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

async function writeExclusive(path: string, bytes: Uint8Array) {
  const file = await open(path, "wx", 0o644);
  try {
    await file.writeFile(bytes);
    await file.chmod(0o644);
    await file.sync();
  } finally {
    await file.close();
  }
}

function jsonBytes(value: unknown) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  assert(bytes.byteLength <= maximumControl);
  return bytes;
}

export async function runManagedHandoff(inputPhase: unknown, options: ManagedHandoffOptions = {}) {
  let stage: Stage = "guard";
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const progress = (next: Stage) => {
    stage = next;
    signal.throwIfAborted();
    options.onStage?.(stage);
  };
  try {
    const phase = PhaseSchema.parse(inputPhase);
    const environment = options.environment ?? process.env;
    assert.equal(environment.GITHUB_ACTIONS, "true");
    assert.equal(environment.KQ_PR_TEST, "1");
    const caseId = CaseSchema.parse(environment.KQ_PR_SPACK_CASE);
    const fetcher = options.fetcher ?? fetch;
    const interval = options.pollIntervalMs ?? 2000;
    assert(Number.isInteger(interval) && interval >= 0 && interval <= 10_000);
    progress("input");
    const delivery = await readManagedDelivery(
      options.deliveryDirectory ?? "/imports/delivery",
      caseId,
      signal,
    );
    progress("control");
    const control = await safeDirectory(options.controlDirectory ?? "/case-control");
    const bindingPath = join(control, "bindings.json");
    const bindingBefore = await lstat(bindingPath, { bigint: true });
    const originalBindings = BindingsSchema.parse(
      handoffJson(await readBounded(control, "bindings.json", maximumControl, signal)),
    );
    if (phase === "prepare") {
      assert.deepEqual(originalBindings, {});
      await requireAbsent(join(control, "release.json"));
      await requireAbsent(join(control, "managed-lock.json"));
    }
    progress("login");
    const login = await fetcher("http://server:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "scheduler-compose-seed@kuintessence.test",
        role: "platform_admin",
      }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    const { token } = z
      .object({ token: z.string().min(1).max(16_384) })
      .parse(handoffJson(await responseBytes(login, maximumControl, signal)));
    const get = (path: string) =>
      fetcher(`${registry}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      });
    progress("catalog");
    const catalogPath = `${base}?repository=${encodeURIComponent(delivery.release.repository)}`;
    const catalog = async () =>
      SpackMaterialCatalogSchema.parse(
        handoffJson(await responseBytes(await get(catalogPath), maximumJson, signal)),
      );
    let listed = await catalog();
    const deadline = Date.now() + 300_000;
    while (phase === "prepare" && listed.releases.length === 0) {
      assert(Date.now() < deadline);
      await delay(interval, undefined, { signal });
      listed = await catalog();
    }
    assert.equal(listed.releases.length, 1);
    const summary = listed.releases[0];
    assert(summary);
    assert.equal(summary.repositoryId, repositoryId(delivery.release.repository));
    assert.equal(summary.repository, delivery.release.repository);
    assert.equal(summary.spec, delivery.release.spec);
    assert.equal(summary.target, delivery.release.target);
    assert.equal(summary.spackVersion, delivery.release.spackVersion);
    assert.equal(summary.redistribution, delivery.release.redistribution);
    const binding = SpackMaterialBindingSchema.parse({
      repositoryId: summary.repositoryId,
      manifestDigest: summary.manifestDigest,
    });
    const releasePath = `${base}/${binding.repositoryId}/releases/${binding.manifestDigest}`;
    progress("manifest");
    const rawManifest = await responseBytes(await get(releasePath), maximumJson, signal);
    assert.equal(handoffDigest(rawManifest).digest, binding.manifestDigest);
    const manifest = SpackMaterialManifestSchema.parse(handoffJson(rawManifest));
    assert.deepEqual(
      {
        ...manifest,
        recipes: manifest.recipes.map(({ archive: _archive, ...recipe }) => recipe),
      },
      delivery.release,
    );
    const blobs = new Map(spackMaterialBlobs(manifest).map((blob) => [blob.digest, blob]));
    assert.equal(summary.sourceCount, manifest.sources.length);
    assert.equal(summary.totalBytes, [...blobs.values()].reduce((sum, blob) => sum + blob.size, 0));
    progress("recipe");
    const recipePath = `/spack/recipe-repositories/${delivery.selection.repositoryId}`;
    const recipe = RecipeRepositorySchema.parse(
      handoffJson(await responseBytes(await get(recipePath), maximumJson, signal)),
    );
    assert.equal(recipe.id, delivery.selection.repositoryId);
    assert.equal(recipe.repository, delivery.recipe.repository);
    assert.equal(recipe.activeCommit, null);
    assert.equal(recipe.snapshots.length, 1);
    const snapshot = recipe.snapshots[0];
    assert(snapshot);
    assert.equal(snapshot.commit, delivery.selection.commit);
    assert.equal(snapshot.bundleSha256, delivery.bundle.digest.slice(7));
    assert(snapshot.diagnostics.every((item) => item.severity !== "error"));
    assert.deepEqual(
      snapshot.roots.map(({ path }) => path).sort(),
      [...delivery.selection.roots].sort(),
    );
    for (const root of snapshot.roots) {
      assert.equal(root.namespace, root.path.split("/").at(-1));
    }
    progress("blobs");
    const verifyBlob = async (path: string, expected: { digest: string; size: number }) => {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert(response.body);
      assert.deepEqual(await hashHandoffStream(response.body, expected.size, signal), expected);
    };
    for (const blob of blobs.values()) {
      // Source/lock limits came from delivery; only Registry-generated archives are additional.
      assert(blob.size <= LIMITS.bundle);
      await verifyBlob(`${releasePath}/blobs/${blob.digest}`, blob);
    }
    for (const selection of manifest.recipes) {
      await verifyBlob(`${recipePath}/snapshots/${selection.commit}/archive`, selection.archive);
    }
    assert.deepEqual(await catalog(), listed);
    await verifyInventory(delivery.root, delivery.inventory);
    const receipt = ReleaseSchema.parse({
      binding,
      spec: manifest.spec,
      target: manifest.target,
      manifestSize: rawManifest.byteLength,
      recipeId: delivery.selection.repositoryId,
      commit: delivery.selection.commit,
    });
    const bindings = { [receipt.spec]: binding };
    progress("control");
    assert(unchanged(bindingBefore, await lstat(bindingPath, { bigint: true })));
    if (phase === "verify") {
      assert.deepEqual(originalBindings, bindings);
      assert.deepEqual(
        handoffJson(await readBounded(control, "release.json", maximumControl, signal)),
        receipt,
      );
      assert.deepEqual(
        await readBounded(control, "managed-lock.json", delivery.lock.byteLength, signal),
        delivery.lock,
      );
    } else {
      await requireAbsent(join(control, "release.json"));
      await requireAbsent(join(control, "managed-lock.json"));
      progress("commit");
      await writeExclusive(join(control, "release.json"), jsonBytes(receipt));
      await writeExclusive(join(control, "managed-lock.json"), delivery.lock);
      const staging = join(control, ".managed-handoff-bindings.json");
      await requireAbsent(staging);
      await writeExclusive(staging, jsonBytes(bindings));
      try {
        signal.throwIfAborted();
        await safeDirectory(control);
        assert(unchanged(bindingBefore, await lstat(bindingPath, { bigint: true })));
        await rename(staging, bindingPath);
      } finally {
        await unlink(staging).catch((error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        });
      }
    }
    signal.throwIfAborted();
    return receipt;
  } catch (error) {
    const code: Code = signal.aborted
      ? "TIMEOUT"
      : error instanceof z.ZodError
        ? "SCHEMA_INVALID"
        : error instanceof assert.AssertionError
          ? "ASSERTION_FAILED"
          : error instanceof SyntaxError
            ? "INVALID_JSON"
            : "HANDOFF_FAILED";
    throw new ManagedHandoffError(stage, code);
  }
}

if (import.meta.main) {
  let phase: Phase | "arguments" = "arguments";
  let stage: Stage = "guard";
  const timer = setTimeout(() => {
    console.error(`Spack artifact managed handoff: phase=${phase} stage=${stage} code=TIMEOUT`);
    process.exit(1);
  }, timeoutMs);
  try {
    assert.equal(process.argv.length, 3);
    phase = PhaseSchema.parse(process.argv[2]);
    await runManagedHandoff(phase, {
      onStage: (value) => {
        stage = value;
      },
    });
    console.log(`Spack artifact managed handoff: phase=${phase} stage=complete code=OK`);
  } catch (error) {
    const code = error instanceof ManagedHandoffError ? error.code : "INVALID_ARGUMENTS";
    console.error(`Spack artifact managed handoff: phase=${phase} stage=${stage} code=${code}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

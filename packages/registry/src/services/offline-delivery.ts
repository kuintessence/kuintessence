import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppError,
  ecosystemCanonicalJson,
  FORGE_DELIVERY_GAPS,
  inspectSpackLock,
  type OfflineDelivery,
  type OfflineDeliveryItem,
  type OfflineDeliveryReport,
  type OfflineDeliveryResult,
  OfflineDeliverySchema,
  type RecipeRepository,
  SignedOfflineDeliverySchema,
  SPACK_LOCK_MAX_BYTES,
  SpackMaterialBindingSchema,
  spackMaterialInputBlobs,
} from "@kuintessence/shared";
import { z } from "zod";
import {
  type EcosystemReleaseService,
  parseSignedEcosystemBundle,
  validateEcosystemManifest,
  verifyEcosystemBundle,
} from "./ecosystem-release-service";
import {
  checkNamespaceAccess,
  NamespacePermissionError,
  parseNamespace,
  type RbacPrincipal,
  type RegistryRole,
} from "./namespace";
import { isDeliveryBinary, type OfflineDeliveryBinaries } from "./offline-delivery-binaries";
import type { DeliveryReceipts } from "./offline-delivery-receipts";
import { RecipeStoreError } from "./recipe-git";
import { RecipeGitStore } from "./recipe-git-store";
import { RegistryError } from "./registry-service";
import type { SpackInstallBindingAccess } from "./spack-install-bindings";
import { SpackMaterialError } from "./spack-material-storage";
import type { SpackMaterialStore } from "./spack-material-store";
import { authorizeMaterialRecipe } from "./spack-material-visibility";

export function deliveryDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(ecosystemCanonicalJson(value)).digest("hex")}`;
}
export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly status = 422,
    readonly details?: unknown,
  ) {
    super(code);
  }
}
function fail(code: string, status = 422): never {
  throw new DeliveryError(code, status);
}
const savedSchema = z.object({
  digest: z.string(),
  status: z.string(),
  receipt: z.unknown().optional(),
});
interface Options {
  binaries?: OfflineDeliveryBinaries;
  recipes: RecipeGitStore;
  materials: SpackMaterialStore;
  ecosystem: Pick<EcosystemReleaseService, "stage" | "activate">;
  bindings: Pick<SpackInstallBindingAccess, "inspect" | "change">;
  receipts: DeliveryReceipts;
  trustedKeys: Record<string, string>;
  deliveryKeys?: Record<string, string>;
  publisherRoles?: RegistryRole[];
  resolvePrincipal: (subject: string) => Promise<(RbacPrincipal & { suspended: boolean }) | null>;
}

export class OfflineDeliveryService {
  constructor(readonly options: Options) {}
  private activePreflights = 0;

  parse(input: unknown): OfflineDelivery {
    return this.readManifest(input).plan;
  }

  private readManifest(input: unknown) {
    let signatureInfo: OfflineDeliveryReport["signature"];
    if (
      input &&
      typeof input === "object" &&
      "artifactType" in input &&
      input.artifactType === FORGE_DELIVERY_GAPS.artifactType
    ) {
      throw new DeliveryError(FORGE_DELIVERY_GAPS.code, 422, FORGE_DELIVERY_GAPS);
    }
    if (input && typeof input === "object" && "format" in input) {
      const signed = SignedOfflineDeliverySchema.safeParse(input);
      if (!signed.success) return fail("DELIVERY_CONTRACT_INVALID");
      const { payload, signature, keyId, format } = signed.data;
      const keys = this.options.deliveryKeys;
      if (!keys || !Object.hasOwn(keys, keyId)) return fail("DELIVERY_SIGNING_KEY_UNKNOWN", 403);
      const bytes = Buffer.from(payload, "utf8");
      if (bytes.toString("utf8") !== payload) return fail("DELIVERY_CONTRACT_INVALID");
      const digest = createHash("sha256").update(bytes).digest("hex");
      try {
        const key = createPublicKey({
          format: "der",
          type: "spki",
          key: Buffer.from(keys[keyId] ?? "", "base64"),
        });
        if (
          key.asymmetricKeyType !== "ed25519" ||
          !verify(
            null,
            Buffer.from([format, keyId, digest].join("\n")),
            key,
            Buffer.from(signature, "base64"),
          )
        )
          return fail("DELIVERY_SIGNATURE_INVALID", 403);
      } catch {
        return fail("DELIVERY_SIGNATURE_INVALID", 403);
      }
      signatureInfo = { keyId, payloadSha256: digest };
      try {
        input = JSON.parse(payload);
      } catch {
        return fail("DELIVERY_CONTRACT_INVALID");
      }
    } else if (this.options.deliveryKeys !== undefined)
      return fail("DELIVERY_SIGNATURE_REQUIRED", 403);
    const parsed = OfflineDeliverySchema.safeParse(input);
    if (!parsed.success)
      throw new DeliveryError("DELIVERY_CONTRACT_INVALID", 422, parsed.error.issues);
    return { plan: parsed.data, signature: signatureInfo };
  }

  async principal(subject: string) {
    const actor = await this.options.resolvePrincipal(subject);
    if (!actor || actor.suspended) return fail("DELIVERY_PRINCIPAL_INACTIVE", 403);
    return actor;
  }

  authorize(plan: OfflineDelivery, actor: RbacPrincipal) {
    const repositories = [
      plan.repository,
      ...plan.items.flatMap((item) =>
        item.kind === "recipe"
          ? [item.repository]
          : item.kind === "material"
            ? [item.release.repository]
            : [],
      ),
    ];
    const scope = parseNamespace(plan.repository);
    for (const repository of repositories) {
      const namespace = parseNamespace(repository);
      if (scope.kind !== namespace.kind || scope.owner !== namespace.owner)
        fail("DELIVERY_NAMESPACE_CONFLICT", 403);
      checkNamespaceAccess(actor, namespace, "read", this.options.publisherRoles);
      checkNamespaceAccess(actor, namespace, "write", this.options.publisherRoles);
    }
    if (plan.items.some((item) => item.kind === "ecosystem" || item.kind === "activate")) {
      if (scope.kind !== "public" || !["platform_admin", "super_admin"].includes(actor.role))
        fail("DELIVERY_PLATFORM_ADMIN_REQUIRED", 403);
    }
    for (const item of plan.items)
      if (item.kind === "binding") {
        if (item.change.scope !== (scope.kind === "public" ? "platform" : scope.owner))
          fail("DELIVERY_BINDING_SCOPE_CONFLICT", 403);
      }
  }

  private binaries() {
    return this.options.binaries ?? fail("DELIVERY_BINARY_STORE_UNAVAILABLE", 503);
  }

  async verify(input: unknown, subject: string) {
    const plan = this.parse(input);
    this.authorize(plan, await this.principal(subject));
    await this.checkBinaryFiles(plan);
    for (const item of plan.items) {
      if (item.kind === "vendor-local") await this.binaries().checkLocal(plan.repository, item);
    }
    return plan;
  }

  private async checkBinaryFiles(plan: OfflineDelivery) {
    if (plan.items.some(isDeliveryBinary))
      await this.binaries().checkDistributableFiles(plan.files.map(({ blob }) => blob.digest));
  }

  private identity(plan: OfflineDelivery) {
    return `delivery:${deliveryDigest([plan.repository, plan.name, plan.release])}`;
  }
  private itemKey(plan: OfflineDelivery, item: OfflineDeliveryItem) {
    return `delivery-item:${deliveryDigest([plan.repository, item.kind === "activate" || item.kind === "binding" || isDeliveryBinary(item) ? plan : item, item.kind === "recipe" || item.kind === "ecosystem" ? plan.files.find((file) => file.path === item.file)?.blob : null])}`;
  }
  private async file(plan: OfflineDelivery, path: string) {
    const file = plan.files.find((entry) => entry.path === path);
    if (!file) return fail("DELIVERY_FILE_MISSING");
    return { file, blob: await this.options.materials.getUploadedBlob(plan.repository, file.blob) };
  }
  private async bundle(plan: OfflineDelivery, path: string) {
    const file = plan.files.find((entry) => entry.path === path);
    if (!file || file.blob.size > 32 * 1024 ** 2) fail("DELIVERY_ECOSYSTEM_SIZE");
    const { blob } = await this.file(plan, path);
    const bundle = parseSignedEcosystemBundle(await new Response(blob.stream).json());
    verifyEcosystemBundle(bundle, this.options.trustedKeys);
    validateEcosystemManifest(bundle.manifest);
    return bundle;
  }

  async preflight(input: unknown, subject: string): Promise<OfflineDeliveryReport> {
    if (this.activePreflights >= 2) fail("DELIVERY_PREFLIGHT_BUSY", 429);
    this.activePreflights++;
    try {
      return await this.inspect(input, subject);
    } finally {
      this.activePreflights--;
    }
  }

  private async inspect(input: unknown, subject: string): Promise<OfflineDeliveryReport> {
    const { plan, signature } = this.readManifest(input);
    const actor = await this.principal(subject);
    this.authorize(plan, actor);
    await this.checkBinaryFiles(plan);
    const digest = deliveryDigest(plan);
    const existing = savedSchema.safeParse(await this.options.receipts.read(this.identity(plan)));
    if (existing.success && existing.data.digest !== digest) fail("DELIVERY_VERSION_CONFLICT", 409);
    const report: OfflineDeliveryReport = {
      digest,
      status: "planned",
      items: [],
      ...(signature ? { signature } : {}),
    };
    const snapshots = new Map<string, RecipeRepository>();
    for (const item of plan.items) {
      const result: OfflineDeliveryResult = { id: item.id, kind: item.kind, status: "planned" };
      try {
        if (isDeliveryBinary(item)) {
          const live = await this.binaries().process(plan, item, actor, false);
          if (live.existing) {
            result.status = "existing";
            result.receipt = live.receipt;
          }
        } else if (item.kind === "recipe") {
          const { file, blob } = await this.file(plan, item.file);
          if (file.blob.size > this.options.recipes.limits.maxBundleBytes) {
            await blob.stream.cancel();
            fail("DELIVERY_RECIPE_SIZE");
          }
          const directory = await mkdtemp(join(tmpdir(), "kq-delivery-check-"));
          try {
            const repository = await new RecipeGitStore(
              directory,
              this.options.recipes.limits,
            ).importBundle(item.repository, blob.stream, actor.sub);
            snapshots.set(item.id, repository);
            const snapshot = repository.snapshots.find((entry) => entry.commit === item.commit);
            if (!snapshot || snapshot.bundleSha256 !== file.blob.digest.slice(7))
              fail("DELIVERY_RECIPE_COMMIT_MISMATCH");
            if (snapshot.diagnostics.some((entry) => entry.severity === "error"))
              fail("DELIVERY_RECIPE_INVALID");
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
          try {
            await this.options.recipes.getSnapshot(
              RecipeGitStore.repositoryId(item.repository),
              item.commit,
            );
            result.status = "existing";
          } catch (error) {
            if (!(error instanceof RecipeStoreError) || error.status !== 404) throw error;
          }
        } else if (item.kind === "material") {
          for (const blob of spackMaterialInputBlobs(item.release)) {
            if (
              !plan.files.some(
                (entry) => entry.blob.digest === blob.digest && entry.blob.size === blob.size,
              )
            )
              fail("DELIVERY_FILE_MISSING");
            const stored = await this.options.materials.getUploadedBlob(plan.repository, blob);
            await stored.stream.cancel();
          }
          for (const selection of item.release.recipes) {
            const dependency = plan.items.find(
              (other) =>
                other.kind === "recipe" &&
                RecipeGitStore.repositoryId(other.repository) === selection.repositoryId &&
                other.commit === selection.commit,
            );
            if (dependency && !item.dependsOn.includes(dependency.id))
              fail("DELIVERY_DEPENDENCY_REQUIRED");
            const staged = dependency ? snapshots.get(dependency.id) : undefined;
            const stored = staged ?? (await this.options.recipes.get(selection.repositoryId));
            authorizeMaterialRecipe(item.release.repository, selection, actor, stored);
          }
          if (item.release.lockfile.size > SPACK_LOCK_MAX_BYTES) fail("DELIVERY_LOCK_SIZE");
          const lock = await this.options.materials.getUploadedBlob(
            plan.repository,
            item.release.lockfile,
          );
          const lockReport = inspectSpackLock(
            new Uint8Array(await new Response(lock.stream).arrayBuffer()),
            item.release,
          );
          if (!lockReport.valid) fail("DELIVERY_LOCK_INVALID");
          result.code = "LOCK_PREFLIGHT_VALID_STATIC_ONLY";
        } else if (item.kind === "ecosystem") await this.bundle(plan, item.file);
        else if (item.kind === "binding") {
          const current = await this.options.bindings.inspect(
            { scope: item.change.scope, spec: item.change.spec },
            subject,
          );
          const receipt = savedSchema.safeParse(
            await this.options.receipts.read(this.itemKey(plan, item)),
          );
          if (
            !(receipt.success && receipt.data.status === "completed") &&
            current.revision !== item.change.expectedRevision
          )
            fail("DELIVERY_BINDING_REVISION_CONFLICT", 409);
        }
        const saved = savedSchema.safeParse(
          await this.options.receipts.read(this.itemKey(plan, item)),
        );
        if (!isDeliveryBinary(item) && saved.success && saved.data.status === "completed") {
          result.status = "existing";
          result.receipt = saved.data.receipt;
        }
      } catch (error) {
        result.code = this.code(error);
        result.status = result.code.includes("CONFLICT")
          ? "conflict"
          : result.code.includes("MISSING") || result.code.endsWith("404")
            ? "missing"
            : "failed";
      }
      report.items.push(result);
    }
    return report;
  }

  async run(input: unknown, subject: string): Promise<OfflineDeliveryReport> {
    const plan = this.parse(input);
    return this.options.receipts.exclusive(async () => {
      const report = await this.preflight(input, subject);
      const key = this.identity(plan);
      if (report.items.some((item) => !["planned", "existing"].includes(item.status))) {
        report.status = "failed";
        await this.options.receipts.append(key, subject, report);
        return report;
      }
      await this.options.receipts.append(key, subject, { ...report, plan, status: "running" });
      const completed = new Map<string, unknown>();
      for (const item of plan.items) {
        const result: OfflineDeliveryResult = { id: item.id, kind: item.kind, status: "completed" };
        try {
          const actor = await this.principal(subject);
          this.authorize(plan, actor);
          if (item.dependsOn.some((id) => !completed.has(id))) fail("DELIVERY_DEPENDENCY_FAILED");
          const saved = savedSchema.safeParse(
            await this.options.receipts.read(this.itemKey(plan, item)),
          );
          if (
            saved.success &&
            saved.data.status === "completed" &&
            (item.kind === "binding" || item.kind === "activate")
          ) {
            // Replays never restore a disabled binding or reactivate an operator-deactivated release.
            result.status = "existing";
            result.receipt = saved.data.receipt;
          } else {
            result.receipt = await this.execute(plan, item, actor, completed);
            await this.options.receipts.append(this.itemKey(plan, item), subject, {
              digest: deliveryDigest(item),
              status: "completed",
              receipt: result.receipt,
            });
          }
          completed.set(item.id, result.receipt);
        } catch (error) {
          result.status = "failed";
          result.code = this.code(error);
        }
        const index = report.items.findIndex((entry) => entry.id === item.id);
        report.items[index] = result;
        report.status = report.items.every((entry) =>
          ["completed", "existing"].includes(entry.status),
        )
          ? "completed"
          : completed.size
            ? "partial"
            : "failed";
        await this.options.receipts.append(key, subject, report);
      }
      return report;
    });
  }

  async history(input: unknown, subject: string) {
    const plan = this.parse(input);
    this.authorize(plan, await this.principal(subject));
    return this.options.receipts.history(this.identity(plan));
  }

  private async execute(
    plan: OfflineDelivery,
    item: OfflineDeliveryItem,
    actor: RbacPrincipal,
    completed: Map<string, unknown>,
  ): Promise<unknown> {
    if (isDeliveryBinary(item))
      return (await this.binaries().process(plan, item, actor, true)).receipt;
    if (item.kind === "recipe") {
      try {
        return await this.options.recipes.getSnapshot(
          RecipeGitStore.repositoryId(item.repository),
          item.commit,
        );
      } catch (error) {
        if (!(error instanceof RecipeStoreError) || error.status !== 404) throw error;
      }
      const { blob } = await this.file(plan, item.file);
      await this.options.recipes.importBundle(item.repository, blob.stream, actor.sub);
      return this.options.recipes.getSnapshot(
        RecipeGitStore.repositoryId(item.repository),
        item.commit,
      );
    }
    if (item.kind === "material") {
      for (const blob of spackMaterialInputBlobs(item.release)) {
        const stored = await this.options.materials.getUploadedBlob(plan.repository, blob);
        await this.options.materials.upload(item.release.repository, blob.digest, stored.stream);
      }
      const preflight = await this.options.materials.preflightLock(item.release, actor);
      if (!preflight.valid) fail("DELIVERY_LOCK_INVALID");
      const binding = await this.options.materials.publish(item.release, actor);
      const { manifest } = await this.options.materials.getManifest(
        binding.repositoryId,
        binding.manifestDigest,
      );
      return { binding, manifest };
    }
    if (item.kind === "binding") {
      const current = await this.options.bindings.inspect(
        { scope: item.change.scope, spec: item.change.spec },
        actor.sub,
      );
      if (current.revision !== item.change.expectedRevision)
        fail("DELIVERY_BINDING_REVISION_CONFLICT", 409);
      if (item.change.action === "bind-imported") {
        const { materialItem, ...change } = item.change;
        const receipt = z
          .object({ binding: SpackMaterialBindingSchema })
          .parse(completed.get(materialItem));
        return this.options.bindings.change(
          { ...change, action: "bind", binding: receipt.binding },
          actor.sub,
        );
      }
      return this.options.bindings.change(item.change, actor.sub);
    }
    if (item.kind === "ecosystem")
      return this.options.ecosystem.stage(await this.bundle(plan, item.file), actor.sub);
    const staged = z.object({ id: z.string().uuid() }).parse(completed.get(item.stagedItem));
    return this.options.ecosystem.activate(staged.id, actor.sub, item.expectedActiveReleaseId);
  }

  private code(error: unknown): string {
    if (error instanceof RegistryError)
      return error.status === 409 ? "DELIVERY_BINARY_CONFLICT" : `DELIVERY_${error.code}`;
    if (error instanceof NamespacePermissionError) return "DELIVERY_PERMISSION_DENIED";
    if (error instanceof AppError) {
      if (error.message === "Bundle signing key is not trusted")
        return "DELIVERY_SIGNING_KEY_UNKNOWN";
      if (error.message === "Bundle signature verification failed")
        return "DELIVERY_SIGNATURE_INVALID";
      return error.code;
    }
    if (error instanceof DeliveryError) return error.code;
    if (error instanceof RecipeStoreError || error instanceof SpackMaterialError)
      return `DELIVERY_INPUT_${error.status}`;
    if (error instanceof Error && error.message === "DELIVERY_BUSY") return "DELIVERY_BUSY";
    return "DELIVERY_ITEM_FAILED";
  }
}

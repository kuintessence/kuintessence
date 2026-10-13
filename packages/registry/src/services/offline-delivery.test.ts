import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OfflineDelivery,
  OfflineDeliveryReport,
  SpackMaterialBinding,
} from "@kuintessence/shared";
import { Hono } from "hono";
import { createOfflineDeliveryRoutes } from "../routes/offline-deliveries";
import { EcosystemReleaseService } from "./ecosystem-release-service";
import { OfflineDeliveryService } from "./offline-delivery";
import { createOfflineDeliveryFixture } from "./offline-delivery.fixture";
import type { DeliveryReceipts } from "./offline-delivery-receipts";
import { seedOfflineDelivery } from "./offline-delivery-seed";
import { RecipeGitStore } from "./recipe-git-store";
import { SpackMaterialStore } from "./spack-material-store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
class MemoryReceipts implements DeliveryReceipts {
  records = new Map<string, unknown[]>();
  tail = Promise.resolve();
  async exclusive<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const deferred = Promise.withResolvers<void>();
    this.tail = deferred.promise;
    await previous;
    try {
      return await run();
    } finally {
      deferred.resolve();
    }
  }
  async read(key: string) {
    return this.records.get(key)?.at(-1);
  }
  async append(key: string, _actor: string, value: unknown) {
    const rows = this.records.get(key) ?? [];
    rows.push(structuredClone(value));
    this.records.set(key, rows);
  }
  async history(key: string) {
    return this.records.get(key) ?? [];
  }
}
const actor = {
  sub: "12345678-abcd-4abc-8def-123456789abc",
  role: "super_admin" as const,
  orgIds: [],
  suspended: false,
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kq-delivery-test-"));
  roots.push(root);
  const input = await createOfflineDeliveryFixture(join(root, "input"));
  const receipts = new MemoryReceipts();
  const recipes = new RecipeGitStore(join(root, "recipes"));
  const materials = new SpackMaterialStore(join(root, "materials"), recipes);
  // Stage/activate persistence has its own PostgreSQL suite; this fixture tests the shared import boundary.
  const stage = spyOn(EcosystemReleaseService.prototype, "stage").mockImplementation(async () => ({
    id: "12345678-abcd-4abc-8def-123456789abc",
    releaseKey: "offline-contract-fixture",
    version: "1.0.0",
    artifactDigest: `sha256:${"a".repeat(64)}`,
    status: "staged",
    manifest: input.bundle.manifest,
    provenance: {},
    signature: input.bundle.signature,
    signingKeyId: "fixture-only",
    importedBy: actor.sub,
    importedAt: new Date(),
    activatedBy: null,
    activatedAt: null,
    deactivatedAt: null,
    failureReason: null,
  }));
  const ecosystem = Object.create(EcosystemReleaseService.prototype) as EcosystemReleaseService;
  const service = new OfflineDeliveryService({
    recipes,
    materials,
    ecosystem,
    receipts,
    trustedKeys: input.trustedKeys,
    bindings: {
      inspect: async () => {
        throw new Error("unexpected binding");
      },
      change: async () => {
        throw new Error("unexpected binding");
      },
    },
    resolvePrincipal: async () => actor,
  });
  const upload = async (plan: OfflineDelivery = input.plan) => {
    for (const file of plan.files)
      await materials.upload(
        plan.repository,
        file.blob.digest,
        Bun.file(join(root, "input", file.path)).stream(),
      );
  };
  return { root, ...input, receipts, recipes, materials, service, upload, stage };
}

test("runtime API and startup seed produce identical immutable materials and evidence; replays preserve receipts", async () => {
  const f = await fixture();
  try {
    await f.upload();
    const app = new Hono().route(
      "/api",
      createOfflineDeliveryRoutes(f.service, { allowTestHeader: true }),
    );
    const response = await app.request("/api/offline-deliveries/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Principal": JSON.stringify(actor) },
      body: JSON.stringify(f.plan),
    });
    expect(response.status).toBe(200);
    const first = (await response.json()) as OfflineDeliveryReport;
    expect(first.status).toBe("completed");
    const second = await seedOfflineDelivery(
      f.service,
      join(f.root, "input/delivery.json"),
      actor.sub,
    );
    expect(second.status).toBe("completed");
    expect(second.items[1]?.receipt).toEqual(first.items[1]?.receipt);
    const receipt = first.items[1]?.receipt as { binding: SpackMaterialBinding };
    const stored = await f.materials.getManifest(
      receipt.binding.repositoryId,
      receipt.binding.manifestDigest,
    );
    expect(stored.manifest.version).toBe(2);
    if (stored.manifest.version !== 2) throw new Error("v2 expected");
    expect(stored.manifest.evidence.materials[0]?.license.status).toBe("pending");
    const attachment = stored.manifest.evidence.materials[0]?.attachments[0];
    if (!attachment) throw new Error("attachment expected");
    const blob = await f.materials.getBlob(
      receipt.binding.repositoryId,
      receipt.binding.manifestDigest,
      attachment.blob.digest,
      actor,
    );
    expect(await new Response(blob.stream).text()).toBe(
      await readFile(join(f.root, "input/NOTICE.txt"), "utf8"),
    );
    expect((await f.service.history(f.plan, actor.sub)).length).toBeGreaterThan(3);
  } finally {
    f.stage.mockRestore();
  }
});

test("preflight checks true lock validity, missing bytes, namespaces and signatures without publishing", async () => {
  const f = await fixture();
  try {
    expect(
      (await f.service.preflight(f.plan, actor.sub)).items.some(
        (item) => item.status === "missing" || item.status === "failed",
      ),
    ).toBe(true);
    await f.upload();
    const invalid = structuredClone(f.plan);
    const item = invalid.items[1];
    if (item?.kind !== "material") throw new Error("fixture");
    item.release.spec = "hello@9.9";
    expect((await f.service.preflight(invalid, actor.sub)).items[1]?.code).toBe(
      "DELIVERY_LOCK_INVALID",
    );
    expect(await f.recipes.list()).toEqual([]);
    f.service.options.trustedKeys = {};
    expect((await f.service.preflight(f.plan, actor.sub)).items[2]?.status).toBe("failed");
    const foreign = structuredClone(f.plan);
    foreign.repository = "org/other/delivery";
    await expect(f.service.preflight(foreign, actor.sub)).rejects.toMatchObject({
      code: "DELIVERY_NAMESPACE_CONFLICT",
    });
  } finally {
    f.stage.mockRestore();
  }
});

test("partial failures retain successful items; concurrent retry is idempotent and a changed immutable plan conflicts", async () => {
  const f = await fixture();
  try {
    await f.upload();
    const publish = spyOn(f.materials, "publish").mockRejectedValueOnce(new Error("interrupted"));
    const first = await f.service.run(f.plan, actor.sub);
    expect(first.status).toBe("partial");
    const [a, b] = await Promise.all([
      f.service.run(f.plan, actor.sub),
      f.service.run(f.plan, actor.sub),
    ]);
    expect(a.status).toBe("completed");
    expect(b.items[1]?.receipt).toEqual(a.items[1]?.receipt);
    expect(
      (await f.recipes.get(RecipeGitStore.repositoryId("public/fixture"))).snapshots,
    ).toHaveLength(1);
    await expect(
      f.service.run({ ...f.plan, files: f.plan.files.slice(1) }, actor.sub),
    ).rejects.toThrow();
    await expect(
      f.service.run({ ...f.plan, items: f.plan.items.slice(0, 1) }, actor.sub),
    ).rejects.toMatchObject({ code: "DELIVERY_VERSION_CONFLICT" });
    publish.mockRestore();
  } finally {
    f.stage.mockRestore();
  }
});

test("seed rejects symlinks and corruption before upload; HTTP rejects host paths and Forge returns a conversion contract", async () => {
  const f = await fixture();
  try {
    const upload = spyOn(f.materials, "upload");
    const path = join(f.root, "input/NOTICE.txt");
    await writeFile(path, "corrupt");
    await expect(
      seedOfflineDelivery(f.service, join(f.root, "input/delivery.json"), actor.sub),
    ).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
    await rm(path);
    await symlink("/etc/passwd", path);
    await expect(
      seedOfflineDelivery(f.service, join(f.root, "input/delivery.json"), actor.sub),
    ).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
    expect(() => f.service.parse({ ...f.plan, root: "/etc" })).toThrow();
    expect(() => f.service.parse({ artifactType: "application/vnd.kq.forge.bundle.v1" })).toThrow(
      "FORGE_SOURCE_CANDIDATE",
    );
    f.service.options.resolvePrincipal = async () => ({ ...actor, suspended: true });
    await expect(f.service.run(f.plan, actor.sub)).rejects.toMatchObject({
      code: "DELIVERY_PRINCIPAL_INACTIVE",
    });
  } finally {
    f.stage.mockRestore();
  }
});

test("successful explicit activation is never replayed after an operator changes active state", async () => {
  const f = await fixture();
  const activate = spyOn(f.service.options.ecosystem, "activate").mockImplementation(async () => {
    const staged = await f.service.options.ecosystem.stage(f.bundle, actor.sub);
    return { ...staged, status: "active" };
  });
  try {
    await f.upload();
    const ecosystem = f.plan.items.find((item) => item.kind === "ecosystem");
    if (!ecosystem) throw new Error("fixture");
    const plan = {
      ...f.plan,
      items: [
        ecosystem,
        {
          id: "activate",
          kind: "activate",
          stagedItem: ecosystem.id,
          dependsOn: [ecosystem.id],
          expectedActiveReleaseId: null,
        },
      ],
    };
    expect((await f.service.run(plan, actor.sub)).status).toBe("completed");
    activate.mockRejectedValue(new Error("must not reactivate"));
    expect((await f.service.run(plan, actor.sub)).items[1]?.status).toBe("existing");
    expect(activate).toHaveBeenCalledTimes(1);
  } finally {
    activate.mockRestore();
    f.stage.mockRestore();
  }
});

test("seed and runtime retries preserve a manually changed install binding revision", async () => {
  const f = await fixture();
  let revision = 1;
  let changes = 0;
  const view = () => ({
    scope: "platform",
    spec: "hello@1.0",
    revision,
    state: "disabled" as const,
    binding: null,
    history: [],
    historyTruncated: false,
  });
  f.service.options.bindings = {
    inspect: async () => view(),
    change: async () => {
      changes++;
      revision++;
      return view();
    },
  };
  try {
    const plan = {
      ...f.plan,
      files: [],
      items: [
        {
          id: "disable",
          kind: "binding",
          change: {
            scope: "platform",
            spec: "hello@1.0",
            action: "disable",
            expectedRevision: 1,
            reason: "Explicit test policy",
          },
        },
      ],
    };
    expect((await f.service.run(plan, actor.sub)).status).toBe("completed");
    revision = 7;
    expect((await f.service.run(plan, actor.sub)).items[0]?.status).toBe("existing");
    expect(changes).toBe(1);
    expect(revision).toBe(7);
  } finally {
    f.stage.mockRestore();
  }
});

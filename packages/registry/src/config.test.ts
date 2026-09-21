import { describe, expect, test } from "bun:test";
import { loadRegistryConfig } from "./config";

const VALID_BASE = {
  DATABASE_URL: "postgres://kq:kq@localhost:5432/kuintessence",
};

describe("loadRegistryConfig", () => {
  test.each([undefined, ""])("material epoch treats %j as unset", (epoch) => {
    expect(
      loadRegistryConfig({ ...VALID_BASE, SPACK_MATERIAL_EPOCH: epoch }).SPACK_MATERIAL_EPOCH,
    ).toBeUndefined();
  });

  test.each([
    "12345678-abcd-4abc-8def-123456789abc",
    "12345678-ABCD-4ABC-8DEF-123456789ABC",
  ])("material epoch accepts and normalizes a strict UUID: %s", (epoch) => {
    expect(
      loadRegistryConfig({ ...VALID_BASE, SPACK_MATERIAL_EPOCH: epoch }).SPACK_MATERIAL_EPOCH,
    ).toBe("12345678-abcd-4abc-8def-123456789abc");
  });

  test.each([
    " ",
    "not-a-uuid",
    "12345678abcd4abc8def123456789abc",
    "{12345678-abcd-4abc-8def-123456789abc}",
    "12345678-abcd-4abc-8def-123456789abc ",
    "12345678-abcd-4abc-8def-123456789abc\n",
    " 12345678-abcd-4abc-8def-123456789abc",
    "12345678-abcd-0abc-8def-123456789abc",
    "12345678-abcd-9abc-8def-123456789abc",
    "12345678-abcd-4abc-7def-123456789abc",
    "12345678-abcd-4abc-8def-123456789abg",
  ])("material epoch rejects noncanonical UUID input: %j", (epoch) => {
    expect(() => loadRegistryConfig({ ...VALID_BASE, SPACK_MATERIAL_EPOCH: epoch })).toThrow(
      "SPACK_MATERIAL_EPOCH",
    );
  });

  test.each([undefined, ""])("material bootstrap treats %j as unset", (manifest) => {
    expect(
      loadRegistryConfig({
        ...VALID_BASE,
        SPACK_MATERIAL_BOOTSTRAP_MANIFEST: manifest,
      }).SPACK_MATERIAL_BOOTSTRAP_MANIFEST,
    ).toBeUndefined();
  });

  test.each([
    undefined,
    "/imports/recipes.json",
  ])("material bootstrap accepts an absolute path with recipe bootstrap %j", (recipeManifest) => {
    expect(
      loadRegistryConfig({
        ...VALID_BASE,
        BLOB_STORE_DIR: "/data/oci",
        SPACK_RECIPE_STORE_DIR: "/data/recipes",
        SPACK_MATERIAL_STORE_DIR: "/data/materials",
        SPACK_RECIPE_BOOTSTRAP_MANIFEST: recipeManifest,
        SPACK_MATERIAL_BOOTSTRAP_MANIFEST: "/imports/materials.json",
      }).SPACK_MATERIAL_BOOTSTRAP_MANIFEST,
    ).toBe("/imports/materials.json");
  });

  test.each([
    "relative/materials.json",
    "https://example.invalid/materials.json",
    " ",
  ])("material bootstrap rejects a nonabsolute local path: %j", (manifest) => {
    expect(() =>
      loadRegistryConfig({
        ...VALID_BASE,
        BLOB_STORE_DIR: "/data/oci",
        SPACK_RECIPE_STORE_DIR: "/data/recipes",
        SPACK_MATERIAL_STORE_DIR: "/data/materials",
        SPACK_MATERIAL_BOOTSTRAP_MANIFEST: manifest,
      }),
    ).toThrow("SPACK_MATERIAL_BOOTSTRAP_MANIFEST");
  });

  for (const key of ["SPACK_MATERIAL_STORE_DIR", "SPACK_RECIPE_STORE_DIR", "BLOB_STORE_DIR"]) {
    test.each([undefined, ""])(`material bootstrap rejects ${key} set to %j`, (directory) => {
      expect(() =>
        loadRegistryConfig({
          ...VALID_BASE,
          BLOB_STORE_DIR: "/data/oci",
          SPACK_RECIPE_STORE_DIR: "/data/recipes",
          SPACK_MATERIAL_STORE_DIR: "/data/materials",
          SPACK_MATERIAL_BOOTSTRAP_MANIFEST: "/imports/materials.json",
          [key]: directory,
        }),
      ).toThrow(key);
    });
  }

  test("material storage is durable, absolute, explicitly dependent on blob and recipe stores", () => {
    expect(loadRegistryConfig(VALID_BASE).SPACK_MATERIAL_STORE_DIR).toBeUndefined();
    const enabled = {
      ...VALID_BASE,
      BLOB_STORE_DIR: "/data/oci",
      SPACK_RECIPE_STORE_DIR: "/data/recipes",
      SPACK_MATERIAL_STORE_DIR: "/data/materials",
    };
    expect(loadRegistryConfig(enabled).SPACK_MATERIAL_MAX_BLOB_BYTES).toBe(16 * 1024 ** 3);
    expect(
      loadRegistryConfig({
        ...enabled,
        SPACK_MATERIAL_MAX_BLOB_BYTES: "1024",
        SPACK_MATERIAL_UPLOAD_TOTAL_TIMEOUT_MS: "1000",
        SPACK_MATERIAL_UPLOAD_IDLE_TIMEOUT_MS: "100",
      }),
    ).toMatchObject({
      SPACK_MATERIAL_MAX_BLOB_BYTES: 1024,
      SPACK_MATERIAL_UPLOAD_TOTAL_TIMEOUT_MS: 1000,
      SPACK_MATERIAL_UPLOAD_IDLE_TIMEOUT_MS: 100,
    });
    for (const overrides of [
      { BLOB_STORE_DIR: "" },
      { SPACK_RECIPE_STORE_DIR: "" },
      { SPACK_MATERIAL_STORE_DIR: "relative/materials" },
      { SPACK_MATERIAL_STORE_DIR: "/data/oci" },
      { SPACK_MATERIAL_STORE_DIR: "/data/oci/sha256/nested" },
      { SPACK_MATERIAL_STORE_DIR: "/data" },
      { SPACK_MATERIAL_STORE_DIR: "/data/recipes" },
      { SPACK_MATERIAL_MAX_BLOB_BYTES: String(16 * 1024 ** 3 + 1) },
      { SPACK_MATERIAL_UPLOAD_IDLE_TIMEOUT_MS: "0" },
    ]) {
      expect(() => loadRegistryConfig({ ...enabled, ...overrides })).toThrow();
    }
  });

  test.each([
    {
      name: "preview",
      blob: "/var/lib/kuintessence/registry",
      recipes: "/var/lib/kuintessence/registry/recipes",
      materials: "/var/lib/kuintessence/registry/materials",
    },
    {
      name: "Helm default",
      blob: "/var/lib/kuintessence/registry/blobs",
      recipes: "/var/lib/kuintessence/registry/blobs/recipes",
      materials: "/var/lib/kuintessence/registry/blobs/materials",
    },
    {
      name: "Helm custom mountPath with trailing slash",
      blob: "/srv/registry/",
      recipes: "/srv/registry/recipes",
      materials: "/srv/registry/materials",
    },
  ])("preserves existing OCI paths for the $name PVC layout", ({ blob, recipes, materials }) => {
    expect(
      loadRegistryConfig({
        ...VALID_BASE,
        BLOB_STORE_DIR: blob,
        SPACK_RECIPE_STORE_DIR: recipes,
        SPACK_MATERIAL_STORE_DIR: materials,
      }),
    ).toMatchObject({
      BLOB_STORE_DIR: blob,
      SPACK_RECIPE_STORE_DIR: recipes,
      SPACK_MATERIAL_STORE_DIR: materials,
    });
  });

  test.each([
    "/data",
    "/data/registry",
    "/data/registry/sha256",
    "/data/registry/sha256/ab",
    "/data/registry/_uploads",
    "/data/registry/_uploads/nested",
    "/data/registry/materials/../sha256",
    "/data/registry/recipes",
    "/data/registry/recipes/materials",
  ])("rejects material overlap with OCI data or recipe storage: %s", (materials) => {
    expect(() =>
      loadRegistryConfig({
        ...VALID_BASE,
        BLOB_STORE_DIR: "/data/registry",
        SPACK_RECIPE_STORE_DIR: "/data/registry/recipes",
        SPACK_MATERIAL_STORE_DIR: materials,
      }),
    ).toThrow();
  });

  test("still rejects materials containing the recipe directory", () => {
    expect(() =>
      loadRegistryConfig({
        ...VALID_BASE,
        BLOB_STORE_DIR: "/data/registry",
        SPACK_RECIPE_STORE_DIR: "/data/registry/materials/recipes",
        SPACK_MATERIAL_STORE_DIR: "/data/registry/materials",
      }),
    ).toThrow();
  });

  test.each([
    "/data/registry/materials",
    "/data/registry/nested/materials",
    "/data/registry/sha256-materials",
    "/data/registry/_uploads-materials",
  ])("allows dedicated material children outside actual OCI data: %s", (materials) => {
    expect(
      loadRegistryConfig({
        ...VALID_BASE,
        BLOB_STORE_DIR: "/data/registry",
        SPACK_RECIPE_STORE_DIR: "/data/registry/recipes",
        SPACK_MATERIAL_STORE_DIR: materials,
      }).SPACK_MATERIAL_STORE_DIR,
    ).toBe(materials);
  });

  test("recipe storage is explicitly configured and never silently ephemeral", () => {
    const config = loadRegistryConfig(VALID_BASE);
    expect(config.SPACK_RECIPE_STORE_DIR).toBeUndefined();
    expect(config.SPACK_RECIPE_MAX_BUNDLE_BYTES).toBe(128 * 1024 * 1024);
    expect(
      loadRegistryConfig({
        ...VALID_BASE,
        SPACK_RECIPE_STORE_DIR: "/data/recipes",
        SPACK_RECIPE_BOOTSTRAP_MANIFEST: "",
      }).SPACK_RECIPE_BOOTSTRAP_MANIFEST,
    ).toBeUndefined();
    expect(() =>
      loadRegistryConfig({ ...VALID_BASE, SPACK_RECIPE_STORE_DIR: "relative/recipes" }),
    ).toThrow();
    expect(() =>
      loadRegistryConfig({
        ...VALID_BASE,
        SPACK_RECIPE_BOOTSTRAP_MANIFEST: "/imports/manifest.json",
      }),
    ).toThrow();
  });

  test("DB pool config defaults to postgres-js compatible values", () => {
    const cfg = loadRegistryConfig({ ...VALID_BASE } as NodeJS.ProcessEnv);
    expect(cfg.DB_MAX_CONNECTIONS).toBe(10);
    expect(cfg.DB_IDLE_TIMEOUT_SEC).toBe(0);
  });

  test("DB pool config honors operator overrides", () => {
    const cfg = loadRegistryConfig({
      ...VALID_BASE,
      DB_MAX_CONNECTIONS: "3",
      DB_IDLE_TIMEOUT_SEC: "30",
    } as NodeJS.ProcessEnv);
    expect(cfg.DB_MAX_CONNECTIONS).toBe(3);
    expect(cfg.DB_IDLE_TIMEOUT_SEC).toBe(30);
  });

  test("loads the shared publisher role contract", () => {
    expect(
      loadRegistryConfig({ ...VALID_BASE } as NodeJS.ProcessEnv).REGISTRY_PUBLISHER_ROLES,
    ).toEqual(["super_admin", "platform_admin", "org_admin"]);
    expect(
      loadRegistryConfig({
        ...VALID_BASE,
        REGISTRY_PUBLISHER_ROLES: "platform_admin,operator",
      } as NodeJS.ProcessEnv).REGISTRY_PUBLISHER_ROLES,
    ).toEqual(["platform_admin", "operator"]);
  });

  test("ecosystem releases require explicit activation by default", () => {
    expect(
      loadRegistryConfig({ ...VALID_BASE } as NodeJS.ProcessEnv).ECOSYSTEM_RELEASE_AUTO_ACTIVATE,
    ).toBe(false);
    expect(
      loadRegistryConfig({
        ...VALID_BASE,
        ECOSYSTEM_RELEASE_AUTO_ACTIVATE: "true",
      } as NodeJS.ProcessEnv).ECOSYSTEM_RELEASE_AUTO_ACTIVATE,
    ).toBe(true);
  });
});

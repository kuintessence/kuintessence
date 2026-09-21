import { createPgDb, userOrgMemberships, users } from "@kuintessence/db";
import { createLogger, RegistryRoleSchema } from "@kuintessence/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { PatternRouter } from "hono/router/pattern-router";
import { z } from "zod";
import { loadRegistryConfig } from "./config";
import { createErrorHandler, createNotFoundHandler } from "./middleware/error-handler";
import { createPrincipalMiddleware } from "./middleware/principal";
import { createRegistryHttpHandler } from "./registry-http";
import { createAppTemplateRoutes } from "./routes/app-templates";
import { createBuildcacheRoutes } from "./routes/buildcache";
import { createEcosystemReleaseRoutes } from "./routes/ecosystem-releases";
import { healthRoutes } from "./routes/health";
import { createOciRoutes } from "./routes/oci";
import { createSpackCatalogRoutes } from "./routes/spack-catalog";
import { createSpackMaterialRoutes } from "./routes/spack-materials";
import { createSpackRepositoryRoutes } from "./routes/spack-repositories";
import { createSpackUpstreamRoutes } from "./routes/spack-upstream";
import { createUsecasePackageRoutes } from "./routes/usecase-packages";
import { createWorkflowTemplateRoutes } from "./routes/workflow-templates";
import { AppTemplateService } from "./services/app-template-service";
import { createBlobStore } from "./services/blob-store";
import { EcosystemOciReader } from "./services/ecosystem-oci-reader";
import { EcosystemReleaseService } from "./services/ecosystem-release-service";
import { RecipeGitStore } from "./services/recipe-git-store";
import { DrizzleAuditPort, RegistryService } from "./services/registry-service";
import { SoftwareAssetService } from "./services/software-asset-service";
import { bootstrapConfiguredSpack } from "./services/spack-bootstrap";
import { SpackCatalogService } from "./services/spack-catalog-service";
import { SpackMaterialStore } from "./services/spack-material-store";
import { SpackUpstreamDownloader } from "./services/spack-upstream-download";
import { SpackUpstreamImportService } from "./services/spack-upstream-import";
import { UsecasePackageService } from "./services/usecase-package-service";
import { WorkflowTemplateService } from "./services/workflow-template-service";

const config = loadRegistryConfig();
const logger = createLogger("registry", config.LOG_LEVEL);
const db = createPgDb(config.DATABASE_URL, {
  max: config.DB_MAX_CONNECTIONS,
  idle_timeout: config.DB_IDLE_TIMEOUT_SEC,
});

const softwareAssetService = new SoftwareAssetService(db);
const appTemplateService = new AppTemplateService(db);
const usecasePackageService = new UsecasePackageService(db, softwareAssetService);
const workflowTemplateService = new WorkflowTemplateService(db, softwareAssetService);
const spackCatalogService = new SpackCatalogService(db, softwareAssetService);
const blobStore = createBlobStore(config.BLOB_STORE_DIR);
const recipeStore = config.SPACK_RECIPE_STORE_DIR
  ? new RecipeGitStore(config.SPACK_RECIPE_STORE_DIR, {
      maxBundleBytes: config.SPACK_RECIPE_MAX_BUNDLE_BYTES,
      maxExpandedBytes: config.SPACK_RECIPE_MAX_EXPANDED_BYTES,
      maxFiles: config.SPACK_RECIPE_MAX_FILES,
    })
  : undefined;
const materialStore =
  config.SPACK_MATERIAL_STORE_DIR && recipeStore
    ? new SpackMaterialStore(config.SPACK_MATERIAL_STORE_DIR, recipeStore, {
        maxBlobBytes: config.SPACK_MATERIAL_MAX_BLOB_BYTES,
        totalTimeoutMs: config.SPACK_MATERIAL_UPLOAD_TOTAL_TIMEOUT_MS,
        idleTimeoutMs: config.SPACK_MATERIAL_UPLOAD_IDLE_TIMEOUT_MS,
      })
    : undefined;
const upstreamImporter =
  config.SPACK_UPSTREAM_ENABLED && config.SPACK_UPSTREAM_PROXY_URL
    ? new SpackUpstreamImportService({
        downloader: new SpackUpstreamDownloader({
          proxyUrl: config.SPACK_UPSTREAM_PROXY_URL,
          allowedOrigins: config.SPACK_UPSTREAM_ALLOWED_ORIGINS,
          maxBytes: config.SPACK_UPSTREAM_MAX_BYTES,
          timeoutMs: config.SPACK_UPSTREAM_TIMEOUT_MS,
          idleTimeoutMs: config.SPACK_UPSTREAM_IDLE_TIMEOUT_MS,
          maxConcurrent: config.SPACK_UPSTREAM_MAX_CONCURRENT,
          caBundle: config.SPACK_UPSTREAM_CA_BUNDLE,
        }),
        recipeStore,
        materialStore,
        publisherRoles: config.REGISTRY_PUBLISHER_ROLES,
        maxConcurrentImports: config.SPACK_UPSTREAM_MAX_CONCURRENT,
      })
    : undefined;
const registryService = new RegistryService(db, blobStore, new DrizzleAuditPort(db), {
  maxUploadBytes: config.REGISTRY_MAX_UPLOAD_BYTES,
  uploadIdleMs: config.REGISTRY_UPLOAD_IDLE_SEC * 1000,
  maxActiveUploads: config.REGISTRY_MAX_ACTIVE_UPLOADS,
  maxActiveUploadsPerRepository: config.REGISTRY_MAX_ACTIVE_UPLOADS_PER_REPOSITORY,
  maxIncompleteUploadBytes: config.REGISTRY_MAX_INCOMPLETE_UPLOAD_BYTES,
});
const ecosystemReleaseService = new EcosystemReleaseService(
  db,
  config.ECOSYSTEM_RELEASE_TRUSTED_KEYS,
  new EcosystemOciReader(registryService),
);
const principalOptions = {
  authMode: config.REGISTRY_AUTH_MODE,
  jwtSecret: config.REGISTRY_JWT_SECRET,
  jwtIssuer: config.REGISTRY_JWT_ISSUER,
  jwtAudience: config.REGISTRY_JWT_AUDIENCE,
  publisherRoles: config.REGISTRY_PUBLISHER_ROLES,
  resolveCanonicalPrincipal: async (subject: string) => {
    const subjectResult = z.string().uuid().safeParse(subject);
    if (!subjectResult.success) return null;
    const [[user], memberships] = await Promise.all([
      db
        .select({ id: users.id, role: users.role, suspended: users.suspended })
        .from(users)
        .where(eq(users.id, subjectResult.data))
        .limit(1),
      db
        .select({ orgId: userOrgMemberships.orgId })
        .from(userOrgMemberships)
        .where(eq(userOrgMemberships.userId, subjectResult.data)),
    ]);
    const role = RegistryRoleSchema.safeParse(user?.role);
    if (!user || !role.success) return null;
    return {
      sub: user.id,
      role: role.data,
      orgIds: memberships.map((membership) => membership.orgId),
      suspended: user.suspended,
    };
  },
} as const;

// Reclaim abandoned upload sessions (client disconnected mid-push). `.unref()`
// so the interval never keeps the process alive on its own.
const uploadSweep = setInterval(
  () => {
    registryService
      .sweepStaleUploads()
      .then((n) => {
        if (n > 0) logger.info({ swept: n }, "Swept stale OCI upload sessions");
      })
      .catch((err) => logger.error({ err }, "OCI upload sweep failed"));
  },
  5 * 60 * 1000,
);
uploadSweep.unref();

if (config.SPACK_RECIPE_BOOTSTRAP_MANIFEST || config.SPACK_MATERIAL_BOOTSTRAP_MANIFEST) {
  bootstrapConfiguredSpack({
    recipeStore,
    recipeManifest: config.SPACK_RECIPE_BOOTSTRAP_MANIFEST,
    materialStore,
    materialManifest: config.SPACK_MATERIAL_BOOTSTRAP_MANIFEST,
  })
    .then((report) => {
      if (report.status === "completed") {
        logger.info({ report }, "Completed configured Spack bootstrap");
      } else {
        logger.error({ report }, "Configured Spack bootstrap has failures");
      }
    })
    .catch(() => logger.error("Failed to bootstrap configured Spack content"));
}

spackCatalogService
  .syncUpstreamAssets()
  .then((result) => logger.info(result, "Synced upstream Spack package assets"))
  .catch((err) => logger.error({ err }, "Failed to sync upstream Spack package assets"));

if (config.ECOSYSTEM_RELEASE_OCI_REPOSITORY && config.ECOSYSTEM_RELEASE_OCI_DIGEST) {
  ecosystemReleaseService
    .stageFromOci(
      {
        repository: config.ECOSYSTEM_RELEASE_OCI_REPOSITORY,
        digest: config.ECOSYSTEM_RELEASE_OCI_DIGEST,
      },
      "registry-startup",
    )
    .then(async (release) => {
      if (config.ECOSYSTEM_RELEASE_AUTO_ACTIVATE && release.status !== "active") {
        await ecosystemReleaseService.activate(release.id, "registry-startup");
      }
      logger.info(
        {
          digest: config.ECOSYSTEM_RELEASE_OCI_DIGEST,
          releaseId: release.id,
        },
        "Synchronized configured ecosystem OCI release",
      );
    })
    .catch((err) => logger.error({ err }, "Failed to synchronize ecosystem OCI release"));
}

// PatternRouter is required because the OCI v2 patterns include
// `/:rest{.+}/blobs/uploads/` where `:rest` itself can contain slashes
// (e.g. `org/<orgId>/<repo>`). Hono's default RegExpRouter mis-routes
// those once the full OCI surface is registered alongside `/_catalog`.
const app = new Hono({ router: new PatternRouter() });
app.onError(createErrorHandler(logger));
app.notFound(createNotFoundHandler());
app.use("*", cors());

app.route("/api", healthRoutes);
app.route("/api", createAppTemplateRoutes(appTemplateService, principalOptions));
app.route("/api", createUsecasePackageRoutes(usecasePackageService, principalOptions));
app.route("/api", createWorkflowTemplateRoutes(workflowTemplateService, principalOptions));
app.route("/api", createSpackCatalogRoutes(spackCatalogService, principalOptions));
app.route("/api", createSpackRepositoryRoutes(recipeStore, principalOptions));
app.route("/api", createSpackMaterialRoutes(materialStore, principalOptions));
app.route("/api", createSpackUpstreamRoutes(upstreamImporter, principalOptions));
app.route("/api", createEcosystemReleaseRoutes(ecosystemReleaseService, principalOptions));

// OCI v2 + Spack buildcache. Both routers mount the principal
// middleware first so every downstream handler sees `c.var.principal`.
//
// Hono's nested routing strips the mount prefix but does NOT normalize a
// trailing slash, so `/v2/` would 404 even though `/v2` works. We
// canonicalize the trailing-slash form via a tiny middleware so Docker
// clients that probe `GET /v2/` (the Distribution spec example) work.
app.use("/v2/", async (_c, next) => {
  return next();
});
const ociApp = new Hono({ router: new PatternRouter() });
ociApp.use("*", createPrincipalMiddleware(principalOptions));
ociApp.route("/", createOciRoutes({ service: registryService, ...principalOptions }));
app.route("/v2", ociApp);
app.route("/v2/", ociApp);

const buildcacheApp = new Hono();
buildcacheApp.use("*", createPrincipalMiddleware(principalOptions));
buildcacheApp.route("/", createBuildcacheRoutes({ service: registryService, ...principalOptions }));
app.route("/buildcache", buildcacheApp);
app.route("/buildcache/", buildcacheApp);

logger.info({ port: config.REGISTRY_PORT }, "Registry starting");

export default {
  port: config.REGISTRY_PORT,
  hostname: "0.0.0.0",
  ...createRegistryHttpHandler(app.fetch, materialStore?.limits.maxBlobBytes),
};

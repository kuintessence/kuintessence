import { expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import type { JobService } from "../services/job-service";
import type { PlacementOrchestrator } from "../services/placement-orchestrator";
import type { PublicationSummary } from "../workflow/output-publication";
import { createJobRoutes } from "./jobs";

const id = "11111111-1111-4111-8111-111111111111";
const summary: PublicationSummary = {
  jobId: id,
  state: "pending",
  totalFiles: 2,
  publishedFiles: 1,
  files: { result: { fileMetadataId: "file-1", fileMetadataName: "result.json" } },
  transferIds: ["transfer-1", "transfer-2"],
};

function fixture(
  options: {
    actor?: string;
    missingJob?: boolean;
    missingSummary?: boolean;
    restricted?: boolean;
    denyAuthz?: boolean;
  } = {},
) {
  let reads = 0;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    const userId = options.actor ?? "owner";
    c.set("user" as never, { sub: userId, role: "user", email: "user@example.test" });
    c.set("principal" as never, {
      userId,
      role: "user",
      email: "user@example.test",
      orgId: null,
      orgIds: [],
      memberships: [],
    });
    await next();
  });
  const service = {
    getById: async () =>
      options.missingJob
        ? null
        : {
            id,
            submittedBy: "owner",
            status: "completed",
            restrictedNoEgress: options.restricted,
          },
  } as unknown as JobService;
  const authz = options.denyAuthz
    ? ({
        mode: "enforce",
        requirePermission: async () => {
          throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
        },
      } as unknown as AuthzService)
    : undefined;
  app.route(
    "/api",
    createJobRoutes(service, {} as PgDb, {} as PlacementOrchestrator, {
      authz,
      outputPublication: {
        get: async (jobId) => {
          expect(jobId).toBe(id);
          reads++;
          return options.missingSummary ? undefined : summary;
        },
      },
    }),
  );
  return { app, reads: () => reads };
}

test("job owner can inspect pending publication independently of completed computation", async () => {
  const { app, reads } = fixture();
  const response = await app.request(`/api/jobs/${id}/output-publication`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(summary);
  expect(reads()).toBe(1);
});

test.each([
  { actor: "unrelated", status: 403 },
  { restricted: true, status: 403 },
  { denyAuthz: true, status: 403 },
  { missingJob: true, status: 404 },
])("publication metadata is not read before job authorization: %j", async ({
  status,
  ...options
}) => {
  const { app, reads } = fixture(options);
  const response = await app.request(`/api/jobs/${id}/output-publication`);
  expect(response.status).toBe(status);
  expect(reads()).toBe(0);
});

test("absence of a publication record is not reported as successful publication", async () => {
  const { app } = fixture({ missingSummary: true });
  const response = await app.request(`/api/jobs/${id}/output-publication`);
  expect(response.status).toBe(404);
});

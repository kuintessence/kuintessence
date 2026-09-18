import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { InstalledRegistry } from "./installed-registry";
import { SoftwareOperationService } from "./operation-service";

function fixture(
  preparation: () => Promise<{ spackMaterialTicket: string; spackManifestDigest: string }>,
) {
  const now = new Date();
  const operation = {
    id: "11111111-1111-4111-8111-111111111111",
    agentId: "agent-a",
    requestedBy: "operator",
    action: "install",
    spec: "zlib@1.3.1",
    status: "queued",
    stdout: null,
    stderr: null,
    exitCode: null,
    error: null,
    requestedAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  let pendingUpdate: Record<string, unknown> = {};
  let selectCount = 0;
  const db = {
    select() {
      const index = selectCount++;
      const rows =
        index < 2 ? [{ agentId: "agent-a", providerOrgId: "provider", siteName: "site" }] : [];
      return {
        from: () => ({
          where: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }),
        }),
      };
    },
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: async () => [operation] }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        pendingUpdate = values;
        return { where: () => ({ returning: async () => [{ ...operation, ...values }] }) };
      },
    }),
  } as unknown as PgDb;
  const pushed: unknown[] = [];
  const dispatcher = {
    pushSoftwareOperation: (_agentId: string, payload: unknown) => {
      pushed.push(payload);
      return true;
    },
  } as unknown as AgentDispatcher;
  const service = new SoftwareOperationService(
    db,
    dispatcher,
    {} as InstalledRegistry,
    preparation,
  );
  return {
    pushed,
    update: () => pendingUpdate,
    run: () =>
      service.requestOperation({
        agentId: "agent-a",
        requestedBy: "operator",
        action: "install",
        spec: "zlib@1.3.1",
        scope: {
          isPlatformWide: true,
          orgIds: [],
          principal: { sub: "operator", role: "platform_admin" },
        },
      }),
  };
}

describe("Spack software operation dispatch gate", () => {
  test("persists rejection without dispatching when materials cannot be authorized", async () => {
    const f = fixture(async () => {
      throw new AppError(ErrorCode.FORBIDDEN, "Materials unavailable", 403);
    });
    expect((await f.run()).status).toBe("rejected");
    expect(f.pushed).toHaveLength(0);
    expect(f.update().error).toBe("Materials unavailable");
  });
  test("does not persist unexpected errors that may contain credentials", async () => {
    const f = fixture(async () => {
      throw new Error("upstream Authorization: secret-value");
    });
    expect((await f.run()).error).not.toContain("secret-value");
    expect(f.pushed).toHaveLength(0);
  });
  test("only forwards the scoped credential after material preparation succeeds", async () => {
    const ticket = {
      spackMaterialTicket: "scoped",
      spackManifestDigest: `sha256:${"a".repeat(64)}`,
    };
    const f = fixture(async () => ticket);
    expect((await f.run()).status).toBe("queued");
    expect(f.pushed).toEqual([expect.objectContaining(ticket)]);
    expect(JSON.stringify(f.update())).not.toContain("scoped");
  });
});

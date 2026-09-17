import { describe, expect, test } from "vitest";
import { CpApiError, type SoftwareOperation } from "./cp-client";
import {
  mergeSoftwareOperationHistory,
  normalizeSoftwareOperationBatchResponse,
  QUEUED_SOFTWARE_OPERATION_POLL_WINDOW_MS,
  SOFTWARE_OPERATION_HISTORY_LIMIT,
  shouldPollSoftwareOperations,
  shouldPollSoftwareOperationsAt,
  shouldRetrySoftwareOperation,
  softwareOperationMatchesQueryKey,
} from "./use-cp-software";

const baseOperation: SoftwareOperation = {
  id: "op-1",
  agentId: "agent-a",
  requestedBy: "admin",
  action: "install",
  spec: "zlib",
  status: "succeeded",
  stdout: null,
  stderr: null,
  exitCode: 0,
  error: null,
  requestedAt: "2026-06-22T00:00:00.000Z",
  startedAt: "2026-06-22T00:00:01.000Z",
  finishedAt: "2026-06-22T00:00:02.000Z",
  updatedAt: "2026-06-22T00:00:02.000Z",
};

describe("software operation request retry", () => {
  test("retries one transient failure so the same mutation variables reuse the idempotency key", () => {
    expect(shouldRetrySoftwareOperation(0, new Error("network offline"))).toBe(true);
    expect(shouldRetrySoftwareOperation(0, new CpApiError(503, "UNAVAILABLE", "retry"))).toBe(true);
    expect(shouldRetrySoftwareOperation(1, new Error("still offline"))).toBe(false);
  });

  test("does not retry client or idempotency conflicts", () => {
    expect(
      shouldRetrySoftwareOperation(0, new CpApiError(409, "CONFLICT", "different payload")),
    ).toBe(false);
    expect(shouldRetrySoftwareOperation(0, new CpApiError(403, "FORBIDDEN", "denied"))).toBe(false);
  });
});

describe("shouldPollSoftwareOperations", () => {
  test("polls while any software operation is running", () => {
    expect(
      shouldPollSoftwareOperations([
        {
          ...baseOperation,
          id: "op-3",
          status: "running",
        },
      ]),
    ).toBe(true);
  });

  test("polls queued operations only within the fresh delivery window", () => {
    const now = Date.parse("2026-06-22T00:05:00.000Z");
    expect(
      shouldPollSoftwareOperationsAt(
        [
          {
            ...baseOperation,
            id: "op-fresh-queued",
            status: "queued",
            updatedAt: new Date(now - QUEUED_SOFTWARE_OPERATION_POLL_WINDOW_MS + 1).toISOString(),
          },
        ],
        now,
      ),
    ).toBe(true);
    expect(
      shouldPollSoftwareOperationsAt(
        [
          {
            ...baseOperation,
            id: "op-stale-queued",
            status: "queued",
            updatedAt: new Date(now - QUEUED_SOFTWARE_OPERATION_POLL_WINDOW_MS - 1).toISOString(),
          },
        ],
        now,
      ),
    ).toBe(false);
  });

  test("stops polling for empty or terminal operation history", () => {
    expect(shouldPollSoftwareOperations(undefined)).toBe(false);
    expect(shouldPollSoftwareOperations([])).toBe(false);
    expect(
      shouldPollSoftwareOperations([
        baseOperation,
        {
          ...baseOperation,
          id: "op-4",
          status: "failed",
          exitCode: 1,
        },
        {
          ...baseOperation,
          id: "op-5",
          status: "rejected",
          exitCode: null,
        },
      ]),
    ).toBe(false);
  });
});

describe("mergeSoftwareOperationHistory", () => {
  test("merges returned operation results in request-time descending order", () => {
    expect(
      mergeSoftwareOperationHistory(
        [
          baseOperation,
          {
            ...baseOperation,
            id: "op-existing",
            spec: "openmpi@4.1.6",
            requestedAt: "2026-06-22T00:01:00.000Z",
            updatedAt: "2026-06-22T00:01:02.000Z",
          },
        ],
        [
          {
            ...baseOperation,
            id: "op-new",
            spec: "gromacs@2024.1 +mpi",
            status: "queued",
            exitCode: null,
            requestedAt: "2026-06-22T00:02:00.000Z",
            updatedAt: "2026-06-22T00:02:00.000Z",
          },
        ],
      ).map((operation) => operation.id),
    ).toEqual(["op-new", "op-existing", "op-1"]);
  });

  test("replaces duplicate operation ids with the newer returned item", () => {
    const merged = mergeSoftwareOperationHistory(
      [
        {
          ...baseOperation,
          id: "op-duplicate",
          status: "queued",
          exitCode: null,
          error: null,
        },
      ],
      [
        {
          ...baseOperation,
          id: "op-duplicate",
          status: "failed",
          exitCode: 1,
          error: "agent is offline",
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe("failed");
    expect(merged[0]?.error).toBe("agent is offline");
  });

  test("does not regress a duplicate operation to an older returned item", () => {
    const merged = mergeSoftwareOperationHistory(
      [
        {
          ...baseOperation,
          id: "op-duplicate",
          status: "succeeded",
          updatedAt: "2026-06-22T00:00:10.000Z",
        },
      ],
      [
        {
          ...baseOperation,
          id: "op-duplicate",
          status: "queued",
          exitCode: null,
          updatedAt: "2026-06-22T00:00:02.000Z",
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe("succeeded");
    expect(merged[0]?.exitCode).toBe(0);
  });

  test("keeps operation history bounded to the batch operation limit", () => {
    const current = Array.from({ length: SOFTWARE_OPERATION_HISTORY_LIMIT + 20 }, (_, index) => ({
      ...baseOperation,
      id: `op-${index}`,
      spec: `pkg-${index}`,
      requestedAt: new Date(Date.parse(baseOperation.requestedAt) - index * 1000).toISOString(),
      updatedAt: new Date(Date.parse(baseOperation.updatedAt) - index * 1000).toISOString(),
    }));

    const merged = mergeSoftwareOperationHistory(current, [
      {
        ...baseOperation,
        id: "op-new",
        spec: "zlib@1.3",
        requestedAt: "2026-06-22T00:01:00.000Z",
        updatedAt: "2026-06-22T00:01:00.000Z",
      },
    ]);

    expect(merged).toHaveLength(SOFTWARE_OPERATION_HISTORY_LIMIT);
    expect(merged[0]?.id).toBe("op-new");
    expect(merged.at(-1)?.id).toBe(`op-${SOFTWARE_OPERATION_HISTORY_LIMIT - 2}`);
  });

  test("uses operation id as the final recency tie breaker", () => {
    const merged = mergeSoftwareOperationHistory(
      [
        {
          ...baseOperation,
          id: "op-a",
          spec: "pkg-a",
        },
      ],
      [
        {
          ...baseOperation,
          id: "op-c",
          spec: "pkg-c",
        },
        {
          ...baseOperation,
          id: "op-b",
          spec: "pkg-b",
        },
      ],
    );

    expect(merged.map((operation) => operation.id)).toEqual(["op-c", "op-b", "op-a"]);
  });
});

describe("softwareOperationMatchesQueryKey", () => {
  test("matches unfiltered operation history query keys for the same agent", () => {
    expect(
      softwareOperationMatchesQueryKey(baseOperation, [
        "cp",
        "software",
        "operations",
        "agent-a",
        null,
        null,
      ]),
    ).toBe(true);
  });

  test("respects action and status filters encoded in the query key", () => {
    expect(
      softwareOperationMatchesQueryKey(baseOperation, [
        "cp",
        "software",
        "operations",
        "agent-a",
        "install",
        "succeeded",
      ]),
    ).toBe(true);
    expect(
      softwareOperationMatchesQueryKey(baseOperation, [
        "cp",
        "software",
        "operations",
        "agent-a",
        "load",
        "succeeded",
      ]),
    ).toBe(false);
    expect(
      softwareOperationMatchesQueryKey(baseOperation, [
        "cp",
        "software",
        "operations",
        "agent-a",
        "install",
        "failed",
      ]),
    ).toBe(false);
  });

  test("does not match other agents or non-operation query keys", () => {
    expect(
      softwareOperationMatchesQueryKey(baseOperation, [
        "cp",
        "software",
        "operations",
        "agent-b",
        null,
        null,
      ]),
    ).toBe(false);
    expect(softwareOperationMatchesQueryKey(baseOperation, ["cp", "software", "overview"])).toBe(
      false,
    );
  });
});

describe("normalizeSoftwareOperationBatchResponse", () => {
  test("keeps server-side batch summaries", () => {
    expect(
      normalizeSoftwareOperationBatchResponse({
        items: [baseOperation],
        summary: {
          inputCount: 3,
          nonEmptyCount: 2,
          uniqueSpecCount: 1,
          ignoredEmptyCount: 1,
          ignoredDuplicateCount: 1,
        },
      }).summary,
    ).toEqual({
      inputCount: 3,
      nonEmptyCount: 2,
      uniqueSpecCount: 1,
      ignoredEmptyCount: 1,
      ignoredDuplicateCount: 1,
    });
  });

  test("wraps legacy array responses for older mocks and clients", () => {
    expect(normalizeSoftwareOperationBatchResponse([baseOperation])).toEqual({
      items: [baseOperation],
      summary: {
        inputCount: 1,
        nonEmptyCount: 1,
        uniqueSpecCount: 1,
        ignoredEmptyCount: 0,
        ignoredDuplicateCount: 0,
      },
    });
  });

  test("fills missing summaries for transitional object responses", () => {
    expect(normalizeSoftwareOperationBatchResponse({ items: [baseOperation] })).toEqual({
      items: [baseOperation],
      summary: {
        inputCount: 1,
        nonEmptyCount: 1,
        uniqueSpecCount: 1,
        ignoredEmptyCount: 0,
        ignoredDuplicateCount: 0,
      },
    });
  });

  test("fills missing summary fields without overwriting server counts", () => {
    expect(
      normalizeSoftwareOperationBatchResponse({
        items: [baseOperation],
        summary: {
          inputCount: 4,
          ignoredDuplicateCount: 3,
        },
      }).summary,
    ).toEqual({
      inputCount: 4,
      nonEmptyCount: 1,
      uniqueSpecCount: 1,
      ignoredEmptyCount: 0,
      ignoredDuplicateCount: 3,
    });
  });
});

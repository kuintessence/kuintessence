import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { ErrorCode } from "@kuintessence/shared";
import { SelectableDatasetService } from "./selectable-datasets";

const PACKAGE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_ORG_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG_ID = "44444444-4444-4444-8444-444444444444";
const DATASET_ID = "55555555-5555-4555-8555-555555555555";
const DATASET_VERSION_ID = "66666666-6666-4666-8666-666666666666";

const packageSpec = {
  description: "Selectable Dataset authorization fixture",
  domain: "testing",
  tags: [],
  citations: [],
  softwareRef: {
    source: "platform-fork",
    name: "fixture",
    version: "1.0.0",
  },
  inputs: [{ descriptor: "dataset", type: "Dataset", required: false }],
  outputs: [],
  resources: {},
  materialMappings: [],
  licenseRequirements: [],
  usecase: { commandFile: "true", inputSlots: [] },
  software: { kind: "Bare" },
  arguments: [],
  environments: [],
  filesomeInputs: [],
  filesomeOutputs: [],
  valueOutputs: [],
};

interface PackageScopeFixture {
  namespace: "org" | "user";
  ownerSubject: string | null;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  createdBy: string | null;
}

class FakeSelectQuery {
  constructor(private readonly rows: readonly unknown[]) {}

  from(): this {
    return this;
  }

  where(): this {
    return this;
  }

  innerJoin(): this {
    return this;
  }

  limit(): Promise<readonly unknown[]> {
    return Promise.resolve(this.rows);
  }

  orderBy(): Promise<readonly unknown[]> {
    return Promise.resolve(this.rows);
  }
}

function fakeDbForPackage(scope: PackageScopeFixture, spec: unknown = packageSpec): PgDb {
  return {
    select: (fields?: Record<string, unknown>) => {
      if (fields && "namespace" in fields) {
        return new FakeSelectQuery([{ id: PACKAGE_ID, ...scope }]);
      }
      if (fields && "spec" in fields) {
        return new FakeSelectQuery([{ spec }]);
      }
      return new FakeSelectQuery([]);
    },
  } as unknown as PgDb;
}

function datasetInput() {
  return {
    source: "data-market" as const,
    assetId: DATASET_ID,
    versionId: DATASET_VERSION_ID,
    manifestDigest: "sha256:fixture",
    selectedEntries: [],
  };
}

describe("SelectableDatasetService usecase scope", () => {
  test("list and validate require a governed package for Dataset inputs", async () => {
    const service = new SelectableDatasetService(
      fakeDbForPackage(
        {
          namespace: "user",
          ownerSubject: "owner-subject",
          ownerUserId: null,
          ownerOrgId: null,
          createdBy: null,
        },
        {
          usecase: { commandFile: "true", inputSlots: [] },
          software: { kind: "Bare" },
        },
      ),
    );
    const actor = { userId: USER_ID, orgId: ACTIVE_ORG_ID, subject: "owner-subject" };
    const rejection = {
      code: ErrorCode.VALIDATION_ERROR,
      statusCode: 409,
      message: "Dataset inputs require a governed usecase package",
    };

    await expect(
      service.list(PACKAGE_ID, actor, { descriptor: "dataset", limit: 25, offset: 0 }),
    ).rejects.toMatchObject(rejection);
    await expect(
      service.validate(PACKAGE_ID, actor, { descriptor: "dataset", dataset: datasetInput() }),
    ).rejects.toMatchObject(rejection);
  });

  test("list and validate reject an out-of-scope organization package", async () => {
    const service = new SelectableDatasetService(
      fakeDbForPackage({
        namespace: "org",
        ownerSubject: null,
        ownerUserId: null,
        ownerOrgId: OTHER_ORG_ID,
        createdBy: null,
      }),
    );
    const actor = { userId: USER_ID, orgId: ACTIVE_ORG_ID, subject: "active-user" };

    await expect(
      service.list(PACKAGE_ID, actor, { descriptor: "dataset", limit: 25, offset: 0 }),
    ).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
      statusCode: 403,
      message: "Usecase package is outside the active organization",
    });
    await expect(
      service.validate(PACKAGE_ID, actor, {
        descriptor: "dataset",
        dataset: datasetInput(),
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
      statusCode: 403,
      message: "Usecase package is outside the active organization",
    });
  });

  test("list forwards the canonical subject for a private user package", async () => {
    const service = new SelectableDatasetService(
      fakeDbForPackage({
        namespace: "user",
        ownerSubject: "owner-subject",
        ownerUserId: null,
        ownerOrgId: null,
        createdBy: null,
      }),
    );

    await expect(
      service.list(
        PACKAGE_ID,
        { userId: USER_ID, orgId: ACTIVE_ORG_ID, subject: "owner-subject" },
        { descriptor: "dataset", limit: 25, offset: 0 },
      ),
    ).resolves.toEqual({ options: [], total: 0, limit: 25, offset: 0 });
  });
});

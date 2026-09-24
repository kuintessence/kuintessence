import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { usecase } from "@kuintessence/shared";
import {
  type FileWorkflowAssetsOptions,
  type FileWorkflowAssetsStage,
  registerFileWorkflowAssets,
} from "./file-workflow-assets";
import { FileWorkflowAssetsSchema, fileWorkflowPackage } from "./file-workflow-contract";
import { managedWorkflowPackage } from "./workflow-contract";

const flags = [
  "KQ_PR_TEST",
  "KQ_PR_SPACK_WORKFLOW",
  "KQ_PR_SPACK_FILE_WORKFLOW",
  "KQ_PR_SPACK_CASE",
] as const;
const original = new Map(flags.map((key) => [key, process.env[key]]));
const baseId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const usecaseIds = {
  convert: "44444444-4444-4444-8444-444444444444",
  sort: "55555555-5555-4555-8555-555555555555",
  verify: "66666666-6666-4666-8666-666666666666",
} as const;
type Receipt = Awaited<ReturnType<typeof registerFileWorkflowAssets>>;
type ResponseHook = (path: string, response: Record<string, unknown>) => void;
const packageFaults = [
  "id",
  "name",
  "version",
  "namespace",
  "spec",
  "revision",
  "missing-revision",
] as const;

beforeEach(() => {
  process.env.KQ_PR_TEST = "1";
  process.env.KQ_PR_SPACK_WORKFLOW = "1";
  process.env.KQ_PR_SPACK_FILE_WORKFLOW = "1";
  process.env.KQ_PR_SPACK_CASE = "samtools";
});

afterEach(() => {
  for (const key of flags) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function registrationFixture(changeResponse?: ResponseHook) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const receipts: Receipt[] = [];
  const stages: FileWorkflowAssetsStage[] = [];
  const created = new Map<string, usecase.UsecasePackageCreate>();
  let reads = 0;
  let logins = 0;
  const options: FileWorkflowAssetsOptions = {
    onStage: (stage) => {
      stages.push(stage);
    },
    readText: async (path) => {
      reads += 1;
      expect(path).toBe("/case-control/workflow-assets.json");
      return JSON.stringify({ usecaseId: baseId, softwareRevisionId: revisionId });
    },
    login: async (origin) => {
      logins += 1;
      expect(origin).toBe("http://server:3000");
      return "private-file-workflow-token";
    },
    request: async (origin, token, path, body) => {
      expect(origin).toBe("http://registry:3100");
      expect(token).toBe("private-file-workflow-token");
      calls.push({ path, body });
      let response: Record<string, unknown>;
      if (path === `/usecase-packages/${baseId}`) {
        expect(body).toBeUndefined();
        response = {
          id: baseId,
          name: "pr-managed-samtools-workflow",
          version: "1",
          namespace: "platform",
          spec: managedWorkflowPackage(),
          publishedSoftwareRevisionId: revisionId,
        };
      } else if (path === "/usecase-packages") {
        const parsed = usecase.UsecasePackageCreateSchema.parse(body);
        const nodeId = (["convert", "sort", "verify"] as const).find(
          (id) => parsed.name === `pr-managed-samtools-file-workflow-${id}`,
        );
        assert(nodeId, "Unexpected file workflow package");
        expect(parsed.spec).toEqual(fileWorkflowPackage(nodeId));
        expect(parsed.version).toBe("1");
        const id = usecaseIds[nodeId];
        created.set(id, parsed);
        response = { ...parsed, id, namespace: "platform" };
      } else {
        expect(body).toBeUndefined();
        const id = path.slice("/usecase-packages/".length);
        const pkg = created.get(id);
        assert(pkg, "Unexpected file workflow API");
        response = {
          ...pkg,
          id,
          namespace: "platform",
          publishedSoftwareRevisionId: revisionId,
        };
      }
      const result = structuredClone(response);
      changeResponse?.(path, result);
      return result;
    },
    writeReceipt: async (receipt) => {
      receipts.push(FileWorkflowAssetsSchema.parse(receipt));
    },
  };
  return { options, calls, receipts, stages, reads: () => reads, logins: () => logins };
}

describe("file workflow asset registration", () => {
  test("reuses the frozen software revision for three HTTP-registered usecases", async () => {
    const fixture = registrationFixture();
    const receipt = await registerFileWorkflowAssets(fixture.options);
    expect(receipt).toEqual({ softwareRevisionId: revisionId, usecases: usecaseIds });
    expect(fixture.receipts).toEqual([receipt]);
    expect(fixture.reads()).toBe(1);
    expect(fixture.logins()).toBe(1);
    expect(fixture.calls.map((call) => call.path)).toEqual([
      `/usecase-packages/${baseId}`,
      "/usecase-packages",
      `/usecase-packages/${usecaseIds.convert}`,
      "/usecase-packages",
      `/usecase-packages/${usecaseIds.sort}`,
      "/usecase-packages",
      `/usecase-packages/${usecaseIds.verify}`,
    ]);
    expect(fixture.stages).toEqual([
      "guard",
      "material",
      "auth",
      "readback",
      "usecase",
      "readback",
      "usecase",
      "readback",
      "usecase",
      "readback",
      "receipt",
    ]);
    expect(JSON.stringify(receipt)).not.toContain("private-file-workflow-token");
    expect(Object.keys(receipt).sort()).toEqual(["softwareRevisionId", "usecases"]);
    expect(Object.keys(receipt.usecases).sort()).toEqual(["convert", "sort", "verify"]);
  });

  for (const flag of ["KQ_PR_TEST", "KQ_PR_SPACK_WORKFLOW", "KQ_PR_SPACK_FILE_WORKFLOW"]) {
    test.each([undefined, "0", "true"])(`${flag} rejects %s before I/O`, async (value) => {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
      const fixture = registrationFixture();
      await expect(registerFileWorkflowAssets(fixture.options)).rejects.toThrow();
      expect(fixture.reads()).toBe(0);
      expect(fixture.logins()).toBe(0);
      expect(fixture.calls).toEqual([]);
      expect(fixture.receipts).toEqual([]);
      expect(fixture.stages).toEqual(["guard"]);
    });
  }

  test.each(["hello", "unknown"])("rejects case %s before I/O", async (caseId) => {
    process.env.KQ_PR_SPACK_CASE = caseId;
    const fixture = registrationFixture();
    await expect(registerFileWorkflowAssets(fixture.options)).rejects.toThrow();
    expect(fixture.reads()).toBe(0);
    expect(fixture.logins()).toBe(0);
    expect(fixture.calls).toEqual([]);
    expect(fixture.receipts).toEqual([]);
  });

  test.each([
    "{",
    "{}",
    JSON.stringify({ usecaseId: baseId, softwareRevisionId: "invalid" }),
    JSON.stringify({ usecaseId: "invalid", softwareRevisionId: revisionId }),
  ])("rejects malformed handoff %s before authentication", async (text) => {
    const fixture = registrationFixture();
    fixture.options.readText = async () => text;
    await expect(registerFileWorkflowAssets(fixture.options)).rejects.toThrow();
    expect(fixture.logins()).toBe(0);
    expect(fixture.calls).toEqual([]);
    expect(fixture.receipts).toEqual([]);
    expect(fixture.stages.at(-1)).toBe("material");
  });

  test.each([...packageFaults])("rejects base %s drift before registration", async (field) => {
    const fixture = registrationFixture((path, response) => {
      if (path !== `/usecase-packages/${baseId}`) return;
      corruptPackage(response, field);
    });
    await expect(registerFileWorkflowAssets(fixture.options)).rejects.toThrow();
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.receipts).toEqual([]);
    expect(fixture.stages.at(-1)).toBe("readback");
  });

  test.each([
    "name",
    "version",
    "namespace",
    "spec",
    "duplicate-id",
  ])("rejects create %s drift", async (field) => {
    const fixture = registrationFixture((path, response) => {
      if (path !== "/usecase-packages") return;
      if (field === "duplicate-id") response.id = baseId;
      else corruptPackage(response, field);
    });
    await expect(registerFileWorkflowAssets(fixture.options)).rejects.toThrow();
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.receipts).toEqual([]);
    expect(fixture.stages.at(-1)).toBe("usecase");
  });

  for (const nodeId of ["convert", "sort", "verify"] as const) {
    test.each([...packageFaults])(`${nodeId} rejects readback %s drift`, async (field) => {
      const fixture = registrationFixture((path, response) => {
        if (path !== `/usecase-packages/${usecaseIds[nodeId]}`) return;
        corruptPackage(response, field);
      });
      await expect(registerFileWorkflowAssets(fixture.options)).rejects.toThrow();
      expect(fixture.calls.at(-1)?.path).toBe(`/usecase-packages/${usecaseIds[nodeId]}`);
      expect(fixture.receipts).toEqual([]);
      expect(fixture.stages.at(-1)).toBe("readback");
    });
  }

  test("rejects reuse of a preceding node's identity", async () => {
    const fixture = registrationFixture((path, response) => {
      if (path === "/usecase-packages" && response.id === usecaseIds.sort) {
        response.id = usecaseIds.convert;
      }
    });
    await expect(registerFileWorkflowAssets(fixture.options)).rejects.toThrow("distinct identities");
    expect(fixture.receipts).toEqual([]);
    expect(fixture.stages.at(-1)).toBe("usecase");
  });

  test.each([
    "material",
    "auth",
    "readback",
    "usecase",
    "receipt",
  ])("stops on %s I/O failure", async (stage) => {
    const fixture = registrationFixture();
    const fail = async () => {
      throw new Error("Synthetic I/O failure");
    };
    if (stage === "material") fixture.options.readText = fail;
    if (stage === "auth") fixture.options.login = fail;
    if (stage === "readback") fixture.options.request = fail;
    if (stage === "usecase") {
      const request = fixture.options.request;
      assert(request);
      fixture.options.request = async (origin, token, path, body) =>
        body === undefined ? request(origin, token, path, body) : fail();
    }
    if (stage === "receipt") fixture.options.writeReceipt = fail;
    await expect(registerFileWorkflowAssets(fixture.options)).rejects.toThrow("Synthetic I/O");
    expect(fixture.receipts).toEqual([]);
    expect(fixture.stages.at(-1)).toBe(stage);
  });
});

function corruptPackage(response: Record<string, unknown>, field: string): void {
  if (field === "id") response.id = otherId;
  else if (field === "name") response.name = "wrong-package";
  else if (field === "version") response.version = "999";
  else if (field === "namespace") response.namespace = "private";
  else if (field === "revision") response.publishedSoftwareRevisionId = otherId;
  else if (field === "missing-revision") delete response.publishedSoftwareRevisionId;
  else if (field === "spec") {
    const spec = usecase.GovernedUsecasePackageSchema.parse(response.spec);
    response.spec = { ...spec, description: "Changed package content" };
  } else {
    throw new Error("Unexpected package fault");
  }
}

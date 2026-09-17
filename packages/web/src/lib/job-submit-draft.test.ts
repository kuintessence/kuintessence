import { afterEach, describe, expect, test } from "vitest";
import {
  clearJobSubmitDraft,
  type JobSubmitDraft,
  jobSubmitDraftStorageKey,
  loadJobSubmitDraft,
  saveJobSubmitDraft,
} from "./job-submit-draft";

const key = jobSubmitDraftStorageKey({
  email: "scientist@example.test",
  organizationId: "org-a",
});

const draft: JobSubmitDraft = {
  mode: "usecase",
  name: "trajectory-analysis",
  command: "analyze",
  cpus: 4,
  memMb: 8_192,
  placementSelection: { mode: "named", queueId: "queue-a" },
  selectedUsecaseId: "usecase-a",
  usecaseInputs: {
    steps: "1000",
    structure: {
      fileMetadataId: "file-a",
      fileMetadataName: "input.gro",
    },
  },
  usecaseDataInputs: {
    trajectory: {
      source: "data-market",
      assetId: "00000000-0000-4000-8000-000000000001",
      versionId: "00000000-0000-4000-8000-000000000002",
      manifestDigest: "sha256:immutable",
      selectedEntries: ["trajectory.xtc"],
    },
  },
  commandWorkdirEntries: [
    {
      id: "cloud:file-a",
      source: "cloud",
      fileMetadataId: "file-a",
      fileMetadataName: "input.gro",
      cloudPath: "inputs/input.gro",
      stagePath: "input.gro",
      size: 1024,
    },
  ],
  commandWorkdirFolders: ["inputs"],
};

afterEach(() => {
  globalThis.sessionStorage?.clear();
});

describe("job submit draft", () => {
  test("keeps drafts scoped by the active organization", () => {
    const orgBKey = jobSubmitDraftStorageKey({
      email: "scientist@example.test",
      organizationId: "org-b",
    });
    saveJobSubmitDraft(key, draft);

    expect(loadJobSubmitDraft(key)).toEqual(draft);
    expect(loadJobSubmitDraft(orgBKey)).toBeNull();
  });

  test("drops malformed persisted values instead of restoring arbitrary objects", () => {
    if (!key) throw new Error("Expected a storage key");
    globalThis.sessionStorage.setItem(
      key,
      JSON.stringify({
        ...draft,
        version: 1,
        savedAt: Date.now(),
        usecaseInputs: { script: { arbitrary: true } },
      }),
    );

    expect(loadJobSubmitDraft(key)).toBeNull();
    expect(globalThis.sessionStorage.getItem(key)).toBeNull();
  });

  test("migrates a v1 queueId into an explicit selection without falling back to Auto", () => {
    if (!key) throw new Error("Expected a storage key");
    globalThis.sessionStorage.setItem(
      key,
      JSON.stringify({ ...draft, version: 1, savedAt: Date.now(), queueId: "queue-default" }),
    );

    expect(loadJobSubmitDraft(key)).toMatchObject({
      placementSelection: { mode: "named", queueId: "queue-default" },
      legacyQueueId: "queue-default",
    });
  });

  test("keeps a v1 draft without a queue as Auto placement", () => {
    if (!key) throw new Error("Expected a storage key");
    globalThis.sessionStorage.setItem(
      key,
      JSON.stringify({ ...draft, version: 1, savedAt: Date.now(), queueId: "" }),
    );

    expect(loadJobSubmitDraft(key)).toMatchObject({ placementSelection: { mode: "auto" } });
    expect(loadJobSubmitDraft(key)?.legacyQueueId).toBeUndefined();
  });

  test("does not persist presigned URLs or inputs named as secrets", () => {
    saveJobSubmitDraft(key, {
      ...draft,
      command: "curl 'https://example.test/file?X-Amz-Signature=temporary'",
    });
    expect(loadJobSubmitDraft(key)).toBeNull();

    saveJobSubmitDraft(key, {
      ...draft,
      usecaseInputs: { apiToken: "not-for-storage" },
    });
    expect(loadJobSubmitDraft(key)).toBeNull();
  });

  test("clears only the selected organization draft", () => {
    const orgBKey = jobSubmitDraftStorageKey({
      email: "scientist@example.test",
      organizationId: "org-b",
    });
    saveJobSubmitDraft(key, draft);
    saveJobSubmitDraft(orgBKey, { ...draft, name: "org-b-job" });

    clearJobSubmitDraft(key);

    expect(loadJobSubmitDraft(key)).toBeNull();
    expect(loadJobSubmitDraft(orgBKey)?.name).toBe("org-b-job");
  });
});

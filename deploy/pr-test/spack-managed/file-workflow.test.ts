import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { expectedReport } from "./file-workflow-contract";
import {
  assertArtifactBytes, assertFileWorkflowIdentity, executeFileWorkflow, fileWorkflowFailureCode,
  invalidSamRejected,
} from "./file-workflow";

describe("downloaded scientific artifact validation", () => {
  test("a cancellation read failure does not mask the first polling failure", async () => {
    const flags = {
      KQ_PR_TEST: "1", KQ_PR_SPACK_WORKFLOW: "1",
      KQ_PR_SPACK_FILE_WORKFLOW: "1", KQ_PR_SPACK_CASE: "samtools",
    };
    const saved = new Map(Object.keys(flags).map((key) => [key, process.env[key]]));
    Object.assign(process.env, flags);
    const primary = new assert.AssertionError({ message: "/workflows/fixture: HTTP 401" });
    const cleanup = new assert.AssertionError({ message: "/workflows/fixture: HTTP 503" });
    const runId = randomUUID();
    let reads = 0;
    try {
      await expect(executeFileWorkflow(
        "fixture-token", randomUUID(),
        "/srv/kq/spack/releases/11111111-1111-4111-8111-111111111111/root",
        { fileMetadataId: randomUUID(), fileMetadataName: "input.sam", hash: "a".repeat(64), size: 16 },
        {
          loadAssets: async () => ({
            softwareRevisionId: randomUUID(),
            usecases: { convert: randomUUID(), sort: randomUUID(), verify: randomUUID() },
          }),
          request: async (path, body) => {
            if (body !== undefined) {
              expect(path).toBe("/workflows");
              return { runId };
            }
            expect(path).toBe(`/workflows/${runId}`);
            throw ++reads === 1 ? primary : cleanup;
          },
        },
      )).rejects.toBe(primary);
      expect(reads).toBe(2);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("diagnostics distinguish identity and HTTP failures without arbitrary details", () => {
    expect(fileWorkflowFailureCode(new assert.AssertionError({
      message: "File workflow identity mismatch",
    }))).toBe("IDENTITY_MISMATCH");
    expect(fileWorkflowFailureCode(new assert.AssertionError({
      message: "/workflows/fixture: HTTP 401",
    }))).toBe("HTTP_401");
    expect(fileWorkflowFailureCode(new assert.AssertionError({
      message: "Private assertion value",
    }))).toBe("ASSERTION_FAILED");
    expect(fileWorkflowFailureCode(new Error("Private response"))).toBe("REQUEST_FAILED");
  });

  test("rejects a polled result belonging to another submitted workflow", () => {
    const runId = randomUUID();
    const result = { id: runId, status: "completed" as const, stepJobs: {}, result: null };
    expect(assertFileWorkflowIdentity(result, runId)).toEqual(result);
    expect(() => assertFileWorkflowIdentity(result, randomUUID())).toThrow();
  });

  test("requires SAM header rejection instead of generic execution or I/O failure", () => {
    const started = "KQ_FILE_WORKFLOW_CONVERT_STARTED";
    const diagnostic = '[main_samview] fail to read the header from "input.sam".';
    expect(invalidSamRejected(1, `${started}\n${diagnostic}\n`)).toBe(true);
    for (const text of [
      started,
      diagnostic,
      `${started}\nPermission denied\n`,
      `${started}\nNo space left on device\n`,
      `${started}\n${diagnostic}\nKQ_FILE_WORKFLOW_CONVERT_OK\n`,
    ]) {
      expect(invalidSamRejected(1, text)).toBe(false);
    }
    for (const exitCode of [null, 0, 2, 126, 127, 139]) {
      expect(invalidSamRejected(exitCode, `${started}\n${diagnostic}\n`)).toBe(false);
    }
  });

  test("report requires exact scientific counts", () => {
    expect(() => assertArtifactBytes("report", Buffer.from(expectedReport))).not.toThrow();
    for (const value of ["", "count=0\nregion=0\n", `${expectedReport}extra\n`]) {
      expect(() => assertArtifactBytes("report", Buffer.from(value))).toThrow();
    }
  });

  test("index requires BAI header and exactly one reference", () => {
    const index = Buffer.alloc(16);
    index.write("BAI\x01", "binary");
    index.writeInt32LE(1, 4);
    expect(() => assertArtifactBytes("index", index)).not.toThrow();
    index.writeInt32LE(2, 4);
    expect(() => assertArtifactBytes("index", index)).toThrow();
    expect(() => assertArtifactBytes("index", Buffer.from("BAI\x01"))).toThrow();
  });

  test("BAM checks binary signature and synthetic read identifiers after decompression", () => {
    const fixture = Buffer.from("BAM\x01chrSynthetic\0read1\0read2\0read3\0", "binary");
    for (const kind of ["bam", "sorted"] as const) {
      expect(() => assertArtifactBytes(kind, gzipSync(fixture))).not.toThrow();
      expect(() => assertArtifactBytes(kind, fixture)).toThrow();
      expect(() => assertArtifactBytes(kind, gzipSync(Buffer.from("not BAM")))).toThrow();
      expect(() => assertArtifactBytes(kind, gzipSync(Buffer.from(
        "BAM\x01chrSynthetic\0read1\0read2\0", "binary",
      )))).toThrow();
    }
  });
});

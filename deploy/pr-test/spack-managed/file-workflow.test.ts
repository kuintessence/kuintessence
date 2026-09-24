import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expectedReport } from "./file-workflow-contract";
import { assertArtifactBytes, assertFileWorkflowIdentity, invalidSamRejected } from "./file-workflow";

describe("downloaded scientific artifact validation", () => {
  test("rejects a polled result belonging to another submitted workflow", () => {
    const runId = randomUUID();
    const result = { id: runId, status: "completed", stepJobs: {}, result: null };
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

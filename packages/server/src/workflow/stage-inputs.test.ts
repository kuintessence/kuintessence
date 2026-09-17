import { describe, expect, test } from "bun:test";
import { stageWorkflowInputs, type WorkflowInputFile } from "./stage-inputs";

describe("stageWorkflowInputs", () => {
  test("stages each input to <workingDir>/<stagePath> via the transfer subsystem, in order", async () => {
    const calls: Array<{ file: WorkflowInputFile; target: string }> = [];
    const stageOne = async (file: WorkflowInputFile, target: string) => {
      calls.push({ file, target });
    };
    await stageWorkflowInputs(
      "/scratch/run-1",
      [
        { fileMetadataId: "fm-1", stagePath: "mesh.tar.gz" },
        { fileMetadataId: "fm-2", stagePath: "case/0/U" },
      ],
      stageOne,
    );
    expect(calls).toEqual([
      {
        file: { fileMetadataId: "fm-1", stagePath: "mesh.tar.gz" },
        target: "/scratch/run-1/mesh.tar.gz",
      },
      {
        file: { fileMetadataId: "fm-2", stagePath: "case/0/U" },
        target: "/scratch/run-1/case/0/U",
      },
    ]);
  });

  test("normalizes a trailing slash on the working dir", async () => {
    let target = "";
    await stageWorkflowInputs(
      "/run/",
      [{ fileMetadataId: "x", stagePath: "a.txt" }],
      async (_f, t) => {
        target = t;
      },
    );
    expect(target).toBe("/run/a.txt");
  });

  test("propagates a transfer failure (staging must not be silently skipped)", async () => {
    let threw = false;
    try {
      await stageWorkflowInputs("/run", [{ fileMetadataId: "x", stagePath: "a" }], async () => {
        throw new Error("transfer failed");
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("does nothing for no inputs", async () => {
    let count = 0;
    await stageWorkflowInputs("/run", [], async () => {
      count++;
    });
    expect(count).toBe(0);
  });
});

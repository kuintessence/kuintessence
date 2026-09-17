import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutputCollector, hostOutputReader } from "../output-collector";

describe("Data Market output isolation", () => {
  test("does not collect a protected readonly mount or descendants as expected outputs", async () => {
    const workRoot = await mkdtemp(join(tmpdir(), "kq-data-output-"));
    const mountRoot = join(workRoot, "inputs", "restricted");
    await mkdir(mountRoot, { recursive: true });
    await writeFile(join(mountRoot, "record.txt"), "restricted bytes");
    const collect = createOutputCollector(hostOutputReader);
    const collected = await collect(
      [
        {
          descriptor: "restricted",
          path: "inputs/restricted/record.txt",
          isBatch: false,
          protectedPaths: [mountRoot],
        },
      ],
      workRoot,
    );
    expect(collected).toEqual({});
  });
});

import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ManagedHandoffError, runManagedHandoff } from "./managed-handoff";
import { handoffDigest } from "./managed-handoff-input";
import {
  encoded,
  type HandoffFixture,
  rejectHandoff,
  setHandoffResponses,
  withHandoffFixture,
} from "./managed-handoff.test-helpers";

type RemoteMutation = {
  name: string;
  stage: ManagedHandoffError["stage"];
  change: (fixture: HandoffFixture) => void;
};

const mismatches: RemoteMutation[] = [
  {
    name: "manifest source",
    stage: "manifest",
    change: (fixture) => {
      const source = fixture.manifest.sources[0];
      assert(source);
      source.path = "hello/unexpected.tar.gz";
    },
  },
  {
    name: "manifest commit",
    stage: "manifest",
    change: (fixture) => {
      const recipe = fixture.manifest.recipes[0];
      assert(recipe);
      recipe.commit = "b".repeat(40);
    },
  },
  {
    name: "recipe namespace",
    stage: "recipe",
    change: (fixture) => {
      fixture.recipe.repository = "public/unexpected-recipe";
    },
  },
  {
    name: "active recipe",
    stage: "recipe",
    change: (fixture) => {
      fixture.recipe.activeCommit = fixture.provenance.recipe.commit;
    },
  },
  {
    name: "snapshot commit",
    stage: "recipe",
    change: (fixture) => {
      const snapshot = fixture.recipe.snapshots[0];
      assert(snapshot);
      snapshot.commit = "b".repeat(40);
    },
  },
  {
    name: "snapshot bundle",
    stage: "recipe",
    change: (fixture) => {
      const snapshot = fixture.recipe.snapshots[0];
      assert(snapshot);
      snapshot.bundleSha256 = "f".repeat(64);
    },
  },
  {
    name: "extra snapshot",
    stage: "recipe",
    change: (fixture) => {
      const snapshot = fixture.recipe.snapshots[0];
      assert(snapshot);
      fixture.recipe.snapshots.push({ ...snapshot, commit: "b".repeat(40) });
    },
  },
  {
    name: "extra root",
    stage: "recipe",
    change: (fixture) => {
      const snapshot = fixture.recipe.snapshots[0];
      assert(snapshot);
      snapshot.roots.push({
        path: "repos/spack_repo/extra",
        namespace: "extra",
        api: "v2.2",
        packageCount: 1,
      });
    },
  },
  {
    name: "missing root",
    stage: "recipe",
    change: (fixture) => {
      const snapshot = fixture.recipe.snapshots[0];
      assert(snapshot);
      snapshot.roots.pop();
    },
  },
  {
    name: "root namespace",
    stage: "recipe",
    change: (fixture) => {
      const root = fixture.recipe.snapshots[0]?.roots[0];
      assert(root);
      root.namespace = "unexpected";
    },
  },
  {
    name: "error diagnostics",
    stage: "recipe",
    change: (fixture) => {
      const snapshot = fixture.recipe.snapshots[0];
      assert(snapshot);
      snapshot.diagnostics.push({
        severity: "error",
        code: "synthetic-error",
        message: "synthetic-private-detail",
      });
    },
  },
];

for (const { name, stage, change } of mismatches) {
  test(`readback rejects ${name} before handoff`, async () => {
    await withHandoffFixture("hello", async (fixture) => {
      change(fixture);
      setHandoffResponses(fixture);
      await rejectHandoff(fixture, "prepare", stage);
      expect(await readdir(fixture.control)).toEqual(["bindings.json"]);
      expect(await readFile(join(fixture.control, "bindings.json"), "utf8")).toBe("{}\n");
    });
  });
}

test("snapshot roots may have scanner order, but must be the exact selected set", async () => {
  await withHandoffFixture("hello", async (fixture) => {
    const snapshot = fixture.recipe.snapshots[0];
    assert(snapshot);
    snapshot.roots.reverse();
    setHandoffResponses(fixture);
    await runManagedHandoff("prepare", fixture.options);
  });
});

for (const field of ["repositoryId", "repository", "spec", "target", "sourceCount", "totalBytes"]) {
  test(`catalog rejects inconsistent ${field}`, async () => {
    await withHandoffFixture("hello", async (fixture) => {
      const { catalog, summary } = setHandoffResponses(fixture);
      const values = {
        repositoryId: "f".repeat(64),
        repository: "public/unexpected",
        spec: "hello@1.0",
        target: "darwin-none-m1",
        sourceCount: summary.sourceCount + 1,
        totalBytes: summary.totalBytes + 1,
      };
      assert(field in values);
      const value = Object.entries(values).find(([key]) => key === field)?.[1];
      fixture.responses.set(catalog, {
        status: 200,
        bytes: encoded({ releases: [{ ...summary, [field]: value }] }),
      });
      const stage = field === "sourceCount" || field === "totalBytes" ? "manifest" : "catalog";
      await rejectHandoff(fixture, "prepare", stage);
      expect(await readdir(fixture.control)).toEqual(["bindings.json"]);
    });
  });
}

test("catalog cannot select among multiple bootstrap releases", async () => {
  await withHandoffFixture("hello", async (fixture) => {
    const { catalog, summary } = setHandoffResponses(fixture);
    fixture.responses.set(catalog, {
      status: 200,
      bytes: encoded({
        releases: [summary, { ...summary, manifestDigest: `sha256:${"b".repeat(64)}` }],
      }),
    });
    await rejectHandoff(fixture, "prepare", "catalog");
  });
});

test("raw manifest bytes must hash to the catalog binding", async () => {
  await withHandoffFixture("hello", async (fixture) => {
    const { releasePath } = setHandoffResponses(fixture);
    fixture.responses.set(releasePath, {
      status: 200,
      bytes: Buffer.concat([encoded(fixture.manifest), Buffer.from(" ")]),
    });
    await rejectHandoff(fixture, "prepare", "manifest");
    expect(await readdir(fixture.control)).toEqual(["bindings.json"]);
  });
});

for (const resource of ["lock", "source", "material archive", "recipe archive"]) {
  for (const corruption of ["hash", "short", "long"]) {
    test(`readback rejects ${resource} ${corruption}`, async () => {
      await withHandoffFixture("hello", async (fixture) => {
        const { releasePath } = setHandoffResponses(fixture);
        const bytes =
          resource === "lock"
            ? fixture.lock
            : resource === "source"
              ? fixture.source
              : fixture.archive;
        const path =
          resource === "recipe archive"
            ? `http://registry:3100/api/spack/recipe-repositories/${fixture.recipe.id}/snapshots/${fixture.provenance.recipe.commit}/archive`
            : `${releasePath}/blobs/${handoffDigest(bytes).digest}`;
        const corrupt =
          corruption === "hash"
            ? Buffer.alloc(bytes.byteLength, 120)
            : corruption === "short"
              ? bytes.subarray(0, -1)
              : Buffer.concat([bytes, Buffer.from("x")]);
        fixture.responses.set(path, { status: 200, bytes: corrupt });
        await rejectHandoff(fixture, "prepare", "blobs");
        expect(await readdir(fixture.control)).toEqual(["bindings.json"]);
      });
    });
  }
}

for (const failure of ["http", "redirect", "json", "oversized"]) {
  test(`catalog ${failure} fails closed with no body in errors`, async () => {
    await withHandoffFixture("hello", async (fixture) => {
      const { catalog } = setHandoffResponses(fixture);
      fixture.responses.set(catalog, {
        status: failure === "http" ? 503 : failure === "redirect" ? 302 : 200,
        bytes:
          failure === "oversized"
            ? Buffer.alloc(2 * 1024 ** 2 + 1, 120)
            : Buffer.from("synthetic-private-detail"),
      });
      await rejectHandoff(fixture, "prepare", "catalog");
      expect(await readdir(fixture.control)).toEqual(["bindings.json"]);
    });
  });
}

test("catalog identity must remain stable through the final blob readback", async () => {
  await withHandoffFixture("hello", async (fixture) => {
    const { catalog } = setHandoffResponses(fixture);
    const fetcher = fixture.options.fetcher;
    assert(fetcher);
    let reads = 0;
    fixture.options.fetcher = async (url, init) => {
      if (url === catalog && ++reads === 2) {
        return new Response(encoded({ releases: [] }));
      }
      return fetcher(url, init);
    };
    await rejectHandoff(fixture, "prepare", "blobs");
    expect(await readdir(fixture.control)).toEqual(["bindings.json"]);
  });
});

import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { link, readFile, readdir, rm, symlink, truncate } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "./export-contract";
import { handoffDigest } from "./managed-handoff-input";
import {
  encoded,
  type HandoffFixture,
  handoffFixtureLock,
  putHandoffFile,
  rejectHandoff,
  sealHandoffDelivery,
  withHandoffFixture,
} from "./managed-handoff.test-helpers";

const identities: { name: string; change: (fixture: HandoffFixture) => void }[] = [
  {
    name: "case",
    change: (fixture) => {
      fixture.provenance.case = "samtools";
    },
  },
  {
    name: "material namespace",
    change: (fixture) => {
      fixture.release.repository = "public/unexpected-material";
    },
  },
  {
    name: "recipe namespace",
    change: (fixture) => {
      const recipe = fixture.recipeInput.repositories[0];
      assert(recipe);
      recipe.repository = "public/unexpected-recipe";
    },
  },
  {
    name: "spec",
    change: (fixture) => {
      fixture.release.spec = "hello@1.0";
    },
  },
  {
    name: "target",
    change: (fixture) => {
      fixture.release.target = "darwin-none-m1";
    },
  },
  {
    name: "commit",
    change: (fixture) => {
      fixture.provenance.recipe.commit = "b".repeat(40);
    },
  },
  {
    name: "roots",
    change: (fixture) => {
      const selection = fixture.release.recipes[0];
      assert(selection);
      selection.roots = ["repos/spack_repo/builtin"];
    },
  },
  {
    name: "recipe ID",
    change: (fixture) => {
      const selection = fixture.release.recipes[0];
      assert(selection);
      selection.repositoryId = "f".repeat(64);
    },
  },
  {
    name: "bundle hash",
    change: (fixture) => {
      fixture.provenance.recipe.bundle.digest = `sha256:${"f".repeat(64)}`;
    },
  },
  {
    name: "root hash",
    change: (fixture) => {
      fixture.provenance.rootHash = "b".repeat(32);
    },
  },
  {
    name: "canonical blob path",
    change: (fixture) => {
      const file = fixture.pack.files[0];
      assert(file);
      file.path = "blobs/alternate";
    },
  },
  {
    name: "source binding",
    change: (fixture) => {
      const source = fixture.release.sources[0];
      assert(source);
      source.path = "hello/different-source.tar.gz";
    },
  },
  {
    name: "unique release",
    change: (fixture) => {
      fixture.pack.releases.push(structuredClone(fixture.release));
    },
  },
];

for (const { name, change } of identities) {
  test(`delivery rejects mismatched ${name} before login`, async () => {
    await withHandoffFixture("hello", async (fixture) => {
      change(fixture);
      await sealHandoffDelivery(fixture);
      await rejectHandoff(fixture, "prepare", "input");
      expect(fixture.requests).toHaveLength(0);
      expect(await readdir(fixture.control)).toEqual(["bindings.json"]);
      expect(await readFile(join(fixture.control, "bindings.json"), "utf8")).toBe("{}\n");
    });
  });
}

test("fixed upstream preparation commit cannot be replaced", async () => {
  await withHandoffFixture("hello", async (fixture) => {
    const provenance = {
      ...fixture.provenance,
      preparationContract: {
        ...fixture.provenance.preparationContract,
        upstreamCommit: "f".repeat(40),
      },
    };
    await putHandoffFile(join(fixture.directory, "provenance.json"), encoded(provenance));
    await rejectHandoff(fixture, "prepare", "input");
    expect(fixture.requests).toHaveLength(0);
  });
});

for (const file of ["recipe-pack/recipes.bundle", "README.md", "checksums.txt"]) {
  test(`delivery rejects changed ${file} bytes`, async () => {
    await withHandoffFixture("hello", async (fixture) => {
      await putHandoffFile(join(fixture.directory, file), Buffer.from("changed\n"));
      await rejectHandoff(fixture, "prepare", "input");
      expect(fixture.requests).toHaveLength(0);
    });
  });
}

for (const damage of ["digest", "size"]) {
  test(`delivery rejects source ${damage} mismatch`, async () => {
    await withHandoffFixture("hello", async (fixture) => {
      const path = `material-pack/blobs/${handoffDigest(fixture.source).digest.slice(7)}`;
      const bytes =
        damage === "digest"
          ? Buffer.alloc(fixture.source.byteLength, 120)
          : fixture.source.subarray(0, -1);
      fixture.files.set(path, bytes);
      await sealHandoffDelivery(fixture);
      await rejectHandoff(fixture, "prepare", "input");
      expect(fixture.requests).toHaveLength(0);
    });
  });
}

test("delivery lock still requires validateLock after consistent hashes are replaced", async () => {
  await withHandoffFixture("hello", async (fixture) => {
    const lock = handoffFixtureLock("hello");
    const root = Object.values(lock.concrete_specs).find((node) => node.name === "hello");
    assert(root);
    root.version = "9.9";
    const bytes = encoded(lock);
    const previous = fixture.release.lockfile.digest;
    const blob = handoffDigest(bytes);
    fixture.release.lockfile = blob;
    fixture.provenance.lockfile = blob;
    fixture.pack.files = fixture.pack.files.map((file) =>
      file.blob.digest === previous ? { path: `blobs/${blob.digest.slice(7)}`, blob } : file,
    );
    const oldPath = `material-pack/blobs/${previous.slice(7)}`;
    fixture.files.delete(oldPath);
    await rm(join(fixture.directory, oldPath));
    fixture.files.set(`material-pack/blobs/${blob.digest.slice(7)}`, bytes);
    await sealHandoffDelivery(fixture);
    await rejectHandoff(fixture, "prepare", "input");
    expect(fixture.requests).toHaveLength(0);
  });
});

for (const damage of ["extra", "missing", "symlink", "hardlink", "oversized"]) {
  test(`delivery refuses ${damage} filesystem input`, async () => {
    await withHandoffFixture("hello", async (fixture) => {
      const path = join(fixture.directory, "README.md");
      if (damage === "extra") {
        await putHandoffFile(join(fixture.directory, "unexpected"), Buffer.from("extra"));
      } else if (damage === "missing") {
        await rm(path);
      } else if (damage === "oversized") {
        await truncate(path, LIMITS.metadata + 1);
      } else {
        const external = join(fixture.work, "external");
        await putHandoffFile(external, Buffer.from("external"));
        await rm(path);
        if (damage === "symlink") await symlink(external, path);
        else await link(external, path);
      }
      await rejectHandoff(fixture, "prepare", "input");
      expect(fixture.requests).toHaveLength(0);
      expect(await readdir(fixture.control)).toEqual(["bindings.json"]);
    });
  });
}

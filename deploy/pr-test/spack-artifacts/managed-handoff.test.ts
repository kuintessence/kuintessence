import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ReleaseSchema } from "../spack-case/api";
import type { CaseId } from "./export-contract";
import { runManagedHandoff } from "./managed-handoff";
import {
  encoded,
  handoffControlBytes,
  putHandoffFile,
  rejectHandoff,
  setHandoffResponses,
  withHandoffFixture,
} from "./managed-handoff.test-helpers";

const cases: CaseId[] = ["hello", "samtools"];
for (const caseId of cases) {
  test(`${caseId}: prepare hands off exact bytes; verify never writes`, async () => {
    await withHandoffFixture(caseId, async (fixture) => {
      const expected = setHandoffResponses(fixture);
      const receipt = await runManagedHandoff("prepare", fixture.options);
      expect(ReleaseSchema.parse(receipt)).toEqual(receipt);
      expect(receipt.binding).toEqual(expected.binding);
      expect(receipt.manifestSize).toBe(encoded(fixture.manifest).byteLength);
      expect(await readFile(join(fixture.control, "managed-lock.json"))).toEqual(fixture.lock);
      expect(JSON.parse(await readFile(join(fixture.control, "bindings.json"), "utf8"))).toEqual({
        [fixture.release.spec]: expected.binding,
      });
      expect(JSON.parse(await readFile(join(fixture.control, "release.json"), "utf8"))).toEqual(
        receipt,
      );
      expect((await readdir(fixture.control)).sort()).toEqual([
        "bindings.json",
        "managed-lock.json",
        "release.json",
      ]);
      const before = await handoffControlBytes(fixture);
      const paths = ["", ...before.map(({ name }) => name)];
      const stats = await Promise.all(
        paths.map((name) => lstat(join(fixture.control, name), { bigint: true })),
      );
      for (const stat of stats.slice(1)) expect(stat.mode & 0o777n).toBe(0o644n);
      fixture.requests.length = 0;
      expect(await runManagedHandoff("verify", fixture.options)).toEqual(receipt);
      expect(await handoffControlBytes(fixture)).toEqual(before);
      for (const [index, name] of paths.entries()) {
        const current = await lstat(join(fixture.control, name), { bigint: true });
        const previous = stats[index];
        assert(previous);
        expect(current.ino).toBe(previous.ino);
        expect(current.size).toBe(previous.size);
        expect(current.mtimeNs).toBe(previous.mtimeNs);
        expect(current.ctimeNs).toBe(previous.ctimeNs);
      }
      expect(new Set(fixture.requests.map(({ url }) => url))).toEqual(
        new Set(fixture.responses.keys()),
      );
      const writes = fixture.requests.filter(({ init }) => init.method !== "GET");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.url).toBe("http://server:3000/api/auth/login");
      expect(writes[0]?.init.method).toBe("POST");
      expect(JSON.parse(String(writes[0]?.init.body))).toEqual({
        email: "scheduler-compose-seed@kuintessence.test",
        role: "platform_admin",
      });
      for (const request of fixture.requests) {
        expect(request.init.redirect).toBe("error");
        expect(request.init.signal).toBeInstanceOf(AbortSignal);
        if (request.init.method === "GET") expect(request.init.body).toBeUndefined();
      }
    });
  });
}

const invalidEnvironments: NodeJS.ProcessEnv[] = [
  {},
  { GITHUB_ACTIONS: "false", KQ_PR_TEST: "1", KQ_PR_SPACK_CASE: "hello" },
  { GITHUB_ACTIONS: "true", KQ_PR_TEST: "0", KQ_PR_SPACK_CASE: "hello" },
  { GITHUB_ACTIONS: "true", KQ_PR_TEST: "1" },
  { GITHUB_ACTIONS: "true", KQ_PR_TEST: "1", KQ_PR_SPACK_CASE: "unknown" },
];
for (const [index, environment] of invalidEnvironments.entries()) {
  test(`guard rejects environment ${index} before IO`, async () => {
    await expect(runManagedHandoff("prepare", { environment })).rejects.toMatchObject({
      stage: "guard",
    });
  });
}

test("guard rejects an unknown phase before IO", async () => {
  await expect(runManagedHandoff("publish")).rejects.toMatchObject({ stage: "guard" });
});

test("prepare waits for bootstrap, but verify never waits on an empty catalog", async () => {
  await withHandoffFixture("hello", async (fixture) => {
    const { catalog } = setHandoffResponses(fixture);
    const fetcher = fixture.options.fetcher;
    assert(fetcher);
    let reads = 0;
    fixture.options.fetcher = async (url, init) => {
      if (url === catalog && ++reads === 1) {
        return new Response(encoded({ releases: [] }));
      }
      return fetcher(url, init);
    };
    await runManagedHandoff("prepare", fixture.options);
    expect(reads).toBe(3);
    const before = await handoffControlBytes(fixture);
    fixture.options.fetcher = fetcher;
    fixture.requests.length = 0;
    fixture.responses.set(catalog, { status: 200, bytes: encoded({ releases: [] }) });
    await rejectHandoff(fixture, "verify", "catalog");
    expect(fixture.requests.filter(({ url }) => url === catalog)).toHaveLength(1);
    expect(await handoffControlBytes(fixture)).toEqual(before);
  });
});

for (const name of ["release.json", "managed-lock.json", "bindings.json"]) {
  test(`prepare refuses existing control ${name}`, async () => {
    await withHandoffFixture("hello", async (fixture) => {
      const { binding } = setHandoffResponses(fixture);
      const bytes = name === "bindings.json" ? encoded({ existing: binding }) : encoded({});
      await putHandoffFile(join(fixture.control, name), bytes);
      await rejectHandoff(fixture, "prepare", "control");
      expect(fixture.requests).toHaveLength(0);
      expect(await readFile(join(fixture.control, name))).toEqual(bytes);
    });
  });
}

for (const name of ["release.json", "managed-lock.json", "bindings.json"]) {
  for (const change of ["remove", "replace"]) {
    test(`verify cannot repair ${change} ${name}`, async () => {
      await withHandoffFixture("hello", async (fixture) => {
        await runManagedHandoff("prepare", fixture.options);
        const path = join(fixture.control, name);
        if (change === "remove") {
          await rm(path);
        } else {
          const bytes =
            name === "managed-lock.json"
              ? Buffer.concat([fixture.lock, Buffer.from(" ")])
              : encoded({});
          await putHandoffFile(path, bytes);
        }
        const names = (await readdir(fixture.control)).sort();
        const before = await Promise.all(
          names.map(async (entry) => ({
            bytes: await readFile(join(fixture.control, entry)),
            stat: await lstat(join(fixture.control, entry), { bigint: true }),
          })),
        );
        await rejectHandoff(fixture, "verify", "control");
        expect((await readdir(fixture.control)).sort()).toEqual(names);
        for (const [index, entry] of names.entries()) {
          const previous = before[index];
          assert(previous);
          expect(await readFile(join(fixture.control, entry))).toEqual(previous.bytes);
          const stat = await lstat(join(fixture.control, entry), { bigint: true });
          expect(stat.mtimeNs).toBe(previous.stat.mtimeNs);
          expect(stat.ctimeNs).toBe(previous.stat.ctimeNs);
        }
      });
    });
  }
}

test("delivery and empty bindings are rechecked after remote readback", async () => {
  for (const target of ["delivery", "bindings"]) {
    await withHandoffFixture("hello", async (fixture) => {
      const { catalog } = setHandoffResponses(fixture);
      const fetcher = fixture.options.fetcher;
      assert(fetcher);
      let reads = 0;
      fixture.options.fetcher = async (url, init) => {
        if (url === catalog && ++reads === 2) {
          const path =
            target === "delivery"
              ? join(fixture.directory, "README.md")
              : join(fixture.control, "bindings.json");
          await putHandoffFile(path, Buffer.from("{} \n"));
        }
        return fetcher(url, init);
      };
      await rejectHandoff(fixture, "prepare", target === "delivery" ? "blobs" : "control");
      expect(await readdir(fixture.control)).toEqual(["bindings.json"]);
    });
  }
});

test("aborted and transport failures expose only fixed stage/code", async () => {
  await withHandoffFixture("hello", async (fixture) => {
    fixture.options.signal = AbortSignal.abort(new Error("synthetic-private-detail"));
    await expect(runManagedHandoff("prepare", fixture.options)).rejects.toMatchObject({
      stage: "input",
      code: "TIMEOUT",
      message: "Spack artifact managed handoff: stage=input code=TIMEOUT",
    });
    fixture.options.signal = undefined;
    fixture.options.fetcher = async () => {
      throw new Error("synthetic-private-detail");
    };
    await rejectHandoff(fixture, "prepare", "login");
    expect(await readdir(fixture.control)).toEqual(["bindings.json"]);
  });
});

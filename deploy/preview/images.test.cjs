const { describe, expect, test } = require("bun:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  COMPONENTS, imageTag, matchesPRTag, imagesFromMetadata, validateImages, verifyPull, runCLI,
} = require("./images.cjs");

const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const identity = { pr: 17, run: 12345, attempt: 2 };
const tag = `pr-17-sha-${sha}-run-12345-2`;

function metadata(named = false) {
  return Object.fromEntries(COMPONENTS.map((name) => [name, {
    "containerimage.digest": digest,
    ...(named ? { "image.name": `ghcr.io/example/kq-dev-${name}:${tag}` } : {}),
  }]));
}

function images() {
  return imagesFromMetadata(metadata(), "example", sha, identity);
}

function environment() {
  return {
    IMAGE_OWNER: "example",
    PREVIEW_PR: "17",
    PREVIEW_SHA: sha,
    PREVIEW_RUN: "12345",
    PREVIEW_ATTEMPT: "2",
    GITHUB_OUTPUT: "/fake/outputs",
    GITHUB_RUN_ATTEMPT: "99",
  };
}

function memoryFiles(input) {
  const writes = [];
  const outputs = [];
  return {
    writes, outputs,
    readFileSync: () => JSON.stringify(input),
    writeFileSync: (...args) => { writes.push(args); },
    appendFileSync: (...args) => { outputs.push(args); },
  };
}

function pullServer(options = {}) {
  const requests = [];
  return {
    requests,
    request: async (url, init) => {
      requests.push({ url, init });
      if (new URL(url).pathname === "/token") {
        return options.tokenDenied
          ? new Response(null, { status: 401 })
          : Response.json({ token: "fake-scoped-pull-token" });
      }
      return new Response(null, {
        status: options.manifestDenied ? 403 : 200,
        headers: options.missingDigest ? {} : {
          "docker-content-digest": options.digest ?? digest,
          "content-type": "application/vnd.oci.image.manifest.v1+json",
        },
      });
    },
  };
}

describe("preview image tag identity", () => {
  test("uses full SHA and canonical positive integer identifiers", () => {
    expect(imageTag(17, sha, 12345, 2)).toBe(tag);
    expect(imageTag("17", sha, "12345", "2")).toBe(tag);
    expect(new Set([
      tag, imageTag(18, sha, 12345, 2), imageTag(17, sha, 12346, 2),
      imageTag(17, sha, 12345, 3), imageTag(17, "c".repeat(40), 12345, 2),
    ]).size).toBe(5);
  });

  test.each(["pr", "run", "attempt"])("rejects non-integer or unsafe %s identities", (field) => {
    for (const bad of [
      undefined, null, true, false, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
      "", "0", "-1", "1.5", "1e3", "+1", "01", " 1", "1 ", "1\n", "1;exit", [1], {},
      "9".repeat(16),
    ]) {
      const context = { ...identity, [field]: bad };
      expect(() => imageTag(context.pr, sha, context.run, context.attempt)).toThrow();
    }
  });

  test("rejects abbreviated, uppercase, padded and non-string commit identities", () => {
    for (const bad of [
      "", sha.slice(0, 7), sha.slice(0, 39), `${sha}a`, `${sha}\n`, "A".repeat(40),
      ` ${sha}`, undefined, null, 123, [sha],
    ]) {
      expect(() => imageTag(17, bad, 12345, 2)).toThrow();
    }
  });

  test("cleanup matches only complete tags belonging to the exact PR", () => {
    expect(matchesPRTag(tag, 17)).toBe(true);
    expect(matchesPRTag(tag, "17")).toBe(true);
    expect(matchesPRTag(imageTag(17, sha, 99999, 5), 17)).toBe(true);
    for (const other of [
      imageTag(117, sha, 12345, 2), imageTag(18, sha, 12345, 2),
      `sha-${sha}`, `pr-17-sha-${sha}`, `${tag}-other`, `${tag}\n`,
      `pr-017-sha-${sha}-run-12345-2`, `pr-17-sha-${sha}-run-0-2`,
      `pr-17-sha-${sha}-run-12345-0`, `pr-17-sha-${sha}-run-1.5-2`,
      `pr-17-sha-${sha}-run-12345-02`, null, undefined, 17, "",
    ]) {
      expect(matchesPRTag(other, 17)).toBe(false);
    }
    expect(() => matchesPRTag(tag, "17;exit")).toThrow();
  });
});

describe("image manifest identity", () => {
  test("uses exactly six fixed packages with no PR-specific repository names", () => {
    const manifest = imagesFromMetadata(metadata(true), "example", sha, identity);
    expect(Object.keys(manifest)).toEqual(COMPONENTS);
    for (const component of COMPONENTS) {
      expect(manifest[component]).toEqual({
        repository: `ghcr.io/example/kq-dev-${component}`,
        tag, digest, pullPolicy: "IfNotPresent",
      });
    }
    expect(validateImages(manifest, "example", sha, identity)).toEqual(manifest);
    const reordered = Object.fromEntries(Object.entries(manifest).reverse().map(([name, image]) =>
      [name, Object.fromEntries(Object.entries(image).reverse())]));
    expect(validateImages(reordered, "example", sha, identity)).toEqual(manifest);
  });

  test("requires explicit context for metadata and artifact manifests", () => {
    expect(() => imagesFromMetadata(metadata(), "example", sha)).toThrow();
    expect(() => validateImages(images(), "example", sha)).toThrow();
    for (const context of [
      null, [], true, {}, { pr: 17 }, { pr: 17, run: 12345 },
      { ...identity, attempt: "2.5" }, { ...identity, run: "12345/other" },
    ]) {
      expect(() => imagesFromMetadata(metadata(), "example", sha, context)).toThrow();
      expect(() => validateImages(images(), "example", sha, context)).toThrow();
    }
  });

  test("rejects artifacts from another PR, run, publish attempt, commit or owner", () => {
    for (const context of [
      { ...identity, pr: 18 }, { ...identity, run: 12346 }, { ...identity, attempt: 3 },
    ]) {
      expect(() => validateImages(images(), "example", sha, context)).toThrow();
    }
    expect(() => validateImages(images(), "example", "c".repeat(40), identity)).toThrow();
    expect(() => validateImages(images(), "other-owner", sha, identity)).toThrow();
  });

  test("rejects incorrect tags even when the digest is well formed", () => {
    for (const wrong of [
      `sha-${sha}`, imageTag(18, sha, 12345, 2), imageTag(17, sha, 12346, 2),
      imageTag(17, sha, 12345, 3), "latest",
    ]) {
      const manifest = images();
      manifest.server.tag = wrong;
      expect(() => validateImages(manifest, "example", sha, identity)).toThrow();
      const source = metadata(true);
      source.server["image.name"] = `ghcr.io/example/kq-dev-server:${wrong}`;
      expect(() => imagesFromMetadata(source, "example", sha, identity)).toThrow();
    }
  });

  test("rejects malformed owners, digests, repositories and unexpected manifest fields", () => {
    for (const owner of ["Example", "example/other", "example\n", "", null]) {
      expect(() => imagesFromMetadata(metadata(), owner, sha, identity)).toThrow();
    }
    for (const bad of [undefined, "", `sha256:${"B".repeat(64)}`, `${digest}\n`, "sha256:short"]) {
      const source = metadata();
      source.server["containerimage.digest"] = bad;
      expect(() => imagesFromMetadata(source, "example", sha, identity)).toThrow();
    }
    const missing = images();
    delete missing.scheduler;
    expect(() => validateImages(missing, "example", sha, identity)).toThrow();
    expect(() => validateImages({ ...images(), extra: {} }, "example", sha, identity)).toThrow();
    for (const mutation of [
      { repository: "ghcr.io/example/kq-pr-17-server" }, { pullPolicy: "Always" },
      { untrusted: "extra" },
    ]) {
      const manifest = images();
      Object.assign(manifest.server, mutation);
      expect(() => validateImages(manifest, "example", sha, identity)).toThrow();
    }
  });
});

describe("public preview image CLI", () => {
  test("collect emits the original publish attempt for deploy-only reruns", async () => {
    const files = memoryFiles(metadata(true));
    const result = await runCLI(["collect", "/fake/metadata", "/fake/images"], environment(), files);
    expect(result).toEqual(images());
    expect(files.writes).toEqual([["/fake/images", JSON.stringify(images()), { mode: 0o600 }]]);
    expect(files.outputs).toEqual([["/fake/outputs", "attempt=2\n"]]);
  });

  test("missing attempt or output channel fails before writing an artifact", async () => {
    for (const key of ["PREVIEW_PR", "PREVIEW_RUN", "PREVIEW_ATTEMPT", "GITHUB_OUTPUT"]) {
      const env = environment();
      delete env[key];
      const files = memoryFiles(metadata());
      await expect(runCLI(["collect", "/fake/metadata", "/fake/images"], env, files)).rejects.toThrow();
      expect(files.writes).toEqual([]);
      expect(files.outputs).toEqual([]);
    }
  });

  test("verify ignores private pull env and checks every public tag against its digest", async () => {
    const env = environment();
    for (const key of ["GHCR_PULL_USER", "GHCR_PULL_TOKEN"]) {
      Object.defineProperty(env, key, { get() { throw new Error("Private credential accessed"); } });
    }
    const remote = pullServer();
    const files = memoryFiles(images());
    await runCLI(["verify", "/fake/images"], env, files, remote.request);
    expect(files.writes).toEqual([]);
    expect(files.outputs).toEqual([]);
    expect(remote.requests).toHaveLength(COMPONENTS.length * 2);
    for (let i = 0; i < COMPONENTS.length; i++) {
      const token = remote.requests[i * 2];
      const manifest = remote.requests[i * 2 + 1];
      expect(token.init.headers.Authorization).toBeUndefined();
      expect(manifest.init.method).toBe("HEAD");
      expect(manifest.url).toBe(`https://ghcr.io/v2/example/kq-dev-${COMPONENTS[i]}/manifests/${tag}`);
      expect(manifest.init.redirect).toBe("error");
    }
  });

  test("wrong publish attempt is rejected before any registry request", async () => {
    const remote = pullServer();
    await expect(runCLI(["verify", "/fake/images"],
      { ...environment(), PREVIEW_ATTEMPT: "99" }, memoryFiles(images()), remote.request)).rejects.toThrow();
    expect(remote.requests).toEqual([]);
  });

  test("anonymous access failures tell operators to publish packages and rerun", async () => {
    for (const options of [{ tokenDenied: true }, { manifestDenied: true }]) {
      const remote = pullServer(options);
      await expect(verifyPull(images(), undefined, undefined, remote.request))
        .rejects.toThrow("make all six kq-dev packages public, then rerun failed jobs");
    }
  });

  test("registry tag mismatch or missing digest fails closed", async () => {
    for (const options of [{ digest: `sha256:${"c".repeat(64)}` }, { missingDigest: true }]) {
      const remote = pullServer(options);
      await expect(verifyPull(images(), undefined, undefined, remote.request))
        .rejects.toThrow("tag digest does not match");
    }
  });

  test("generic optional auth remains available without changing public CLI behavior", async () => {
    const remote = pullServer();
    await verifyPull(images(), "test-user", "test-password", remote.request);
    expect(remote.requests[0].init.headers.Authorization).toBe(
      `Basic ${Buffer.from("test-user:test-password").toString("base64")}`,
    );
    await expect(verifyPull(images(), "test-user", undefined, remote.request)).rejects.toThrow();
  });
});

describe("preview bake tag contract", () => {
  test("all six published targets bind the tag into both reference and image config", () => {
    const hcl = readFileSync(join(__dirname, "images.hcl"), "utf8");
    expect(hcl).toContain('variable "IMAGE_TAG"');
    expect(hcl).toContain('"kq.preview.tag" = IMAGE_TAG');
    expect(hcl).toContain('platforms = ["linux/amd64"]');
    expect(hcl.match(/tags = /g)).toHaveLength(COMPONENTS.length);
    for (const component of COMPONENTS) {
      expect(hcl).toContain(`tags = ["\${IMAGE_PREFIX}-${component}:\${IMAGE_TAG}"]`);
    }
    expect(hcl).not.toContain(":sha-");
  });

  test("preview values have no private credential mode", () => {
    const source = readFileSync(join(__dirname, "values.cjs"), "utf8");
    expect(source).not.toContain("registry-secret");
    expect(source).not.toContain("GHCR_PULL_");
    expect(source).not.toContain("privatePull");
    expect(source).toContain("imagePullSecrets: []");
    expect(source).toContain("process.env.PREVIEW_RUN");
    expect(source).toContain("process.env.PREVIEW_ATTEMPT");
  });
});

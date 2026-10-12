const { describe, expect, test } = require("bun:test");
const { readFileSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const { parse } = require("yaml");

const root = resolve(__dirname, "..");
const workflow = parse(readFileSync(resolve(root, ".github/workflows/build-images.yml"), "utf8"));
const job = workflow.jobs.images;
const resolver = job.steps.find((step) => step.id === "image");

async function tags(eventName, ref, payload = {}, component = "server") {
  const outputs = {};
  await runInNewContext(`(async () => { ${resolver.with.script} })()`, {
    context: { eventName, ref, payload, repo: { owner: "Example" } },
    process: { env: { COMPONENT: component } },
    core: {
      setOutput: (name, value) => {
        outputs[name] = value;
      },
    },
  });
  return outputs.tags.split("\n");
}

function release(tag, prerelease = false, draft = false) {
  return { action: "published", release: { tag_name: tag, prerelease, draft } };
}

describe("production image publication", () => {
  test("main publishes only the main tag for each production component", async () => {
    expect(job.strategy.matrix.include.map((entry) => entry.component)).toEqual([
      "server",
      "registry",
      "web",
      "db-migrate",
    ]);
    for (const entry of job.strategy.matrix.include) {
      expect(existsSync(resolve(root, entry.dockerfile))).toBe(true);
      expect(await tags("push", "refs/heads/main", {}, entry.component)).toEqual([
        `ghcr.io/example/kuintessence-${entry.component}:main`,
      ]);
    }
  });

  test.each([
    "v1.2.3",
    "1.2.3",
    "release-2026.10",
  ])("stable release preserves Git tag %s and moves latest to the same build", async (tag) => {
    expect(await tags("release", `refs/tags/${tag}`, release(tag))).toEqual([
      `ghcr.io/example/kuintessence-server:${tag}`,
      "ghcr.io/example/kuintessence-server:latest",
    ]);
  });

  test("prereleases do not move latest", async () => {
    expect(await tags("release", "refs/tags/v2.0.0-rc.1", release("v2.0.0-rc.1", true))).toEqual([
      "ghcr.io/example/kuintessence-server:v2.0.0-rc.1",
    ]);
  });

  test.each([
    "main",
    "latest",
    "release/v1.0.0",
    "v1+build",
    "",
    "a".repeat(129),
  ])("rejects reserved or incompatible Git tag %s instead of silently renaming it", async (tag) => {
    await expect(tags("release", `refs/tags/${tag}`, release(tag))).rejects.toThrow();
  });

  test("rejects other branches, tag pushes and unpublished releases", async () => {
    await expect(tags("push", "refs/heads/feature")).rejects.toThrow();
    await expect(tags("push", "refs/tags/v1.0.0")).rejects.toThrow();
    await expect(tags("pull_request", "refs/pull/1/merge")).rejects.toThrow();
    await expect(
      tags("release", "refs/tags/v1.0.0", release("v1.0.0", false, true)),
    ).rejects.toThrow();
    await expect(
      tags("release", "refs/tags/v1.0.0", {
        ...release("v1.0.0"),
        action: "created",
      }),
    ).rejects.toThrow();
  });

  test("publication uses the event commit and disables preview login", () => {
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      release: { types: ["published"] },
    });
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(job.steps.find((step) => step.uses === "actions/checkout@v4").with).toEqual({
      ref: `\${{ github.sha }}`,
      "persist-credentials": false,
    });
    const build = job.steps.find((step) => step.uses === "docker/build-push-action@v6").with;
    expect(build.push).toBe(true);
    expect(build.tags).toBe(`\${{ steps.image.outputs.tags }}`);
    expect(build["build-args"].trim()).toBe("VITE_PREVIEW_LOGIN=false");
    expect(build.platforms).toBe("linux/amd64");
  });
});

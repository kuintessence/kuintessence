const { describe, expect, test } = require("bun:test");
const { eligible, positiveInteger, testsPassed, gate, REQUIRED_JOBS } = require("./gate.cjs");
const { sanitizeConfig } = require("./kubeconfig.cjs");
const { imagesFromMetadata, validateImages, COMPONENTS } = require("./images.cjs");
const { credentialData } = require("./credentials.cjs");
const { previewValues } = require("./values.cjs");
const { verifyHttps } = require("./https.cjs");

const sha = "a".repeat(40);
function pull() {
  return {
    number: 17,
    state: "open",
    draft: false,
    user: { login: "member" },
    labels: [{ name: "TRUST_PR_CREATOR" }],
    base: { ref: "main" },
    head: { sha, repo: { full_name: "example/project" } },
  };
}
function jobs() {
  return REQUIRED_JOBS.map((name) => ({ name, status: "completed", conclusion: "success" }));
}

describe("remote preview trust gate", () => {
  test("requires both the exact trust label and current write permission", () => {
    for (const permission of ["write", "maintain", "admin"]) {
      expect(eligible(pull(), "example/project", permission)).toBe(true);
    }
    for (const permission of ["read", "triage", "none", undefined]) {
      expect(eligible(pull(), "example/project", permission)).toBe(false);
    }
    expect(eligible({ ...pull(), labels: [] }, "example/project", "admin")).toBe(false);
    expect(eligible({ ...pull(), labels: [{ name: "trust_pr_creator" }] }, "example/project", "admin")).toBe(false);
  });
  test("rejects forks, draft, closed and paused PRs", () => {
    expect(eligible(pull(), "another/project", "write")).toBe(false);
    expect(eligible({ ...pull(), base: { ref: "feat/unreviewed-base" } }, "example/project", "write")).toBe(false);
    expect(eligible({ ...pull(), state: "closed" }, "example/project", "write")).toBe(false);
    expect(eligible({ ...pull(), draft: true }, "example/project", "write")).toBe(false);
    expect(eligible({ ...pull(), labels: [...pull().labels, { name: "preview-paused" }] }, "example/project", "write")).toBe(false);
  });
  test("never accepts skipped, missing or failed required test suites", () => {
    expect(testsPassed(jobs())).toBe(true);
    for (const conclusion of ["skipped", "failure", "cancelled", null]) {
      const data = jobs();
      data[3].conclusion = conclusion;
      expect(testsPassed(data)).toBe(false);
    }
    expect(testsPassed(jobs().slice(1))).toBe(false);
    expect(testsPassed(jobs().slice(0, -1))).toBe(false);
    expect(testsPassed([...jobs(), { name: "ci / Generate database migrations", status: "completed", conclusion: "skipped" }])).toBe(true);
    const swapped = jobs();
    swapped[3].name = "ci / Unrelated passing check";
    expect(testsPassed(swapped)).toBe(false);
    expect(testsPassed([...jobs(), jobs()[3]])).toBe(false);
  });
  test("validates numeric identifiers before use in paths or shell", () => {
    expect(positiveInteger("17", "PR")).toBe(17);
    for (const value of ["0", "-1", "1;exit", "../17", "1\n", "0001", "1e3", "9".repeat(16)]) {
      expect(() => positiveInteger(value, "PR")).toThrow();
    }
  });
  test("live recheck rejects stale SHA and newer runs", async () => {
    let pr = pull();
    let newer = false;
    const outputs = {};
    const run = {
      id: 12, path: ".github/workflows/preview-tests.yml", event: "pull_request",
      status: "completed", conclusion: "success", head_sha: sha,
      head_repository: { full_name: "example/project" }, pull_requests: [{ number: 17 }],
    };
    const github = {
      rest: {
        pulls: { get: async () => ({ data: pr }) },
        repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: "write" } }) },
        actions: {
          getWorkflowRun: async () => ({ data: run }),
          listJobsForWorkflowRun: "jobs",
          listWorkflowRuns: "runs",
        },
      },
      paginate: async (method, options) => method === "jobs"
        ? options.run_id === 14 ? [{ name: "resolve", status: "completed", conclusion: "skipped" }] : jobs()
        : newer === "ignored"
          ? [{ ...run, id: 14, display_title: "PR preview tests (ignored label event)" }]
          : newer ? [{ ...run, id: 13 }] : [run],
    };
    const context = {
      repo: { owner: "example", repo: "project" },
      payload: { workflow_run: run, repository: { default_branch: "main" } },
    };
    const core = { setOutput: (key, value) => { outputs[key] = value; }, info: () => {} };
    await gate({ github, context, core });
    expect(outputs.allowed).toBe("true");
    pr = { ...pull(), head: { ...pull().head, sha: "b".repeat(40) } };
    await gate({ github, context, core });
    expect(outputs.allowed).toBe("false");
    pr = pull();
    newer = "ignored";
    await gate({ github, context, core });
    expect(outputs.allowed).toBe("true");
    pr = pull();
    newer = true;
    await gate({ github, context, core });
    expect(outputs.allowed).toBe("false");
  });
});

function kubeconfig() {
  return {
    "current-context": "default",
    contexts: [{ name: "default", context: { cluster: "default", user: "default" } }],
    clusters: [{ name: "default", cluster: { server: "https://127.0.0.1:6443", "certificate-authority-data": "Y2E=" } }],
    users: [{ name: "default", user: { "client-certificate-data": "Y2VydA==", "client-key-data": "a2V5" } }],
  };
}
describe("SSH-tunneled Kubernetes authentication", () => {
  test("rewrites loopback port while preserving CA and API TLS identity", () => {
    const original = kubeconfig();
    original.clusters[0].cluster.server = "https://api.example.test:6443";
    const safe = sanitizeConfig(original);
    expect(safe.clusters[0].cluster.server).toBe("https://127.0.0.1:16443");
    expect(safe.clusters[0].cluster["tls-server-name"]).toBe("api.example.test");
    expect(safe.clusters[0].cluster["certificate-authority-data"]).toBe("Y2E=");
    expect(safe.users[0].user).toEqual(original.users[0].user);
  });
  test("refuses insecure TLS, proxies, plugins and local credential references", () => {
    for (const [key, value] of [
      ["insecure-skip-tls-verify", true], ["proxy-url", "http://proxy.invalid"],
      ["certificate-authority", "/etc/passwd"], ["server", "http://localhost:6443"],
      ["server", "https://localhost:443"],
      ["server", "https://localhost"],
    ]) {
      const config = kubeconfig();
      config.clusters[0].cluster[key] = value;
      expect(() => sanitizeConfig(config)).toThrow();
    }
    for (const key of ["exec", "auth-provider", "client-key", "tokenFile"]) {
      const config = kubeconfig();
      config.users[0].user[key] = "forbidden";
      expect(() => sanitizeConfig(config)).toThrow();
    }
  });
});

describe("immutable preview images and credentials", () => {
  const metadata = Object.fromEntries(COMPONENTS.map((name) =>
    [name, { "containerimage.digest": `sha256:${"b".repeat(64)}` }]));
  test("only consumes expected dev images with full commit tags and digests", () => {
    const images = imagesFromMetadata(metadata, "example", sha);
    expect(images.server.repository).toBe("ghcr.io/example/kq-dev-server");
    expect(images.server.tag).toBe(`sha-${sha}`);
    expect(validateImages(images, "example", sha)).toEqual(images);
    expect(() => validateImages(images, "example", "c".repeat(40))).toThrow();
    expect(() => imagesFromMetadata({}, "example", sha)).toThrow();
    expect(() => validateImages({ ...images, server: { ...images.server, repository: "untrusted/image" } }, "example", sha)).toThrow();
    const values = previewValues(images, "17", "example", sha, true)["kq-platform"];
    expect(values.migration.image).toEqual(images["db-migrate"]);
    expect(values.global.imagePullSecrets).toEqual([{ name: "kq-preview-ghcr" }]);
    expect(values.preview.host).toBe("pr-17.preview.dev.kuintessence.com");
    expect(JSON.stringify(values)).not.toContain("PASSWORD");
  });
  test("upgrades preserve existing database and application credentials", () => {
    const hash = () => "test-hash";
    const initial = credentialData({}, "kq-pr-17", undefined, hash);
    expect(Buffer.from(initial.PREVIEW_COOKIE, "base64").toString("utf8")).toMatch(/^[a-f0-9]{64}$/);
    expect(credentialData(initial, "kq-pr-17", undefined, hash)).toEqual(initial);
    const next = credentialData(initial, "kq-pr-17", "a-new-dedicated-preview-password", hash);
    expect(next.JWT_SECRET).toBe(initial.JWT_SECRET);
    expect(next.POSTGRES_PASSWORD).toBe(initial.POSTGRES_PASSWORD);
    expect(next.PREVIEW_COOKIE).not.toBe(initial.PREVIEW_COOKIE);
    expect(() => credentialData({}, "production", undefined, hash)).toThrow();
    expect(() => credentialData({}, "kq-pr-17", "short", hash)).toThrow();
  });
  test("HTTPS acceptance checks the gate, unlock, Web and Server", async () => {
    const requests = [];
    const request = async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/__preview/unlock")) {
        return options.headers?.Authorization
          ? new Response("unlock", { headers: { "set-cookie": "kq_preview=opaque; Path=/; Secure; HttpOnly" } })
          : new Response("", { status: 401 });
      }
      if (!options.headers?.Cookie) {
        return new Response("", { status: 302, headers: { location: "/__preview/unlock" } });
      }
      return new Response("", { headers: { "content-type": url.endsWith("/api/health") ? "application/json" : "text/html" } });
    };
    await verifyHttps("https://preview.example.test", "password", "opaque", request);
    expect(requests).toHaveLength(5);
    expect(requests.every(({ options }) => options.redirect === "manual")).toBe(true);
    await expect(verifyHttps("https://preview.example.test", "password", "opaque",
      async () => new Response("unguarded"))).rejects.toThrow();
  });
});

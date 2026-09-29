const { describe, expect, test } = require("bun:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const { X509Certificate, createPrivateKey, createPublicKey } = require("node:crypto");
const { parse } = require("yaml");
const { addTlsData } = require("./credentials.cjs");
const { cleanupGate } = require("./gate.cjs");
const { imageTag } = require("./images.cjs");

const root = resolve(__dirname, "../..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const preview = () => parse(read(".github/workflows/preview.yml"));
const cleanup = () => parse(read(".github/workflows/preview-cleanup.yml"));
const revision = "a".repeat(40);

function stepAllowed(step, steps, successful = true) {
  const condition = step.if ?? "true";
  // Actions implicitly requires success unless the condition has a status function.
  if (!/\b(always|success|failure|cancelled)\s*\(/.test(condition) && !successful) {
    return false;
  }
  return runInNewContext(condition.replace(/steps\.([\w-]+)/g, 'steps["$1"]'), {
    steps,
    always: () => true,
    success: () => successful,
    failure: () => !successful,
    cancelled: () => false,
  });
}

function interpolate(value, context) {
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expression) =>
    String(runInNewContext(expression, context)));
}

async function runScript(step, modules, env, api = {}) {
  expect(step.uses).toBe("actions/github-script@v7");
  expect(typeof step.with.script).toBe("string");
  return runInNewContext(`(async () => {\n${step.with.script}\n})()`, {
    require: (name) => {
      if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected workflow module: ${name}`);
      return modules[name];
    },
    github: api.github ?? {},
    context: api.context ?? {},
    core: api.core ?? {},
    process: { env },
  });
}

function cleanupFixture(state) {
  const outputs = {};
  const requests = [];
  const api = {
    github: { rest: {
      pulls: { get: async ({ pull_number }) => {
        requests.push(pull_number);
        if (state === "lookup-failed") throw new Error("Mock PR lookup unavailable");
        return { data: {
          state: state === "closed" ? "closed" : "open",
          draft: state === "draft",
          user: { login: "member" },
          labels: [
            ...(state === "untrusted" ? [] : [{ name: "TRUST_PR_CREATOR" }]),
            ...(state === "paused" ? [{ name: "preview-paused" }] : []),
          ],
          base: { ref: "main" },
          head: { sha: revision, repo: { full_name: "example/project" } },
        } };
      } },
      repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: "write" } }) },
    } },
    context: {
      repo: { owner: "example", repo: "project" },
      payload: { repository: { default_branch: "main" }, inputs: { pr_number: "999" } },
    },
    core: { setOutput: (key, value) => { outputs[key] = value; }, info: () => {} },
  };
  return { api, outputs, requests };
}

describe("privileged preview orchestration boundaries", () => {
  test("only defaults to workflow completion and default-branch manual control", () => {
    const workflow = parse(read(".github/workflows/preview.yml"));
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.pull_request_target).toBeUndefined();
    expect(workflow.on.workflow_run.workflows).toEqual(["PR preview tests"]);
    expect(workflow.jobs.gate.if).toContain("github.event.repository.default_branch");
    expect(workflow.jobs.gate.steps[0].with.ref).toBe("${{ github.workflow_sha }}");
    expect(workflow.jobs.deploy.environment).toBeUndefined();
    expect(JSON.stringify(workflow.jobs.deploy.env)).not.toContain("runner.");
    expect(workflow.jobs.deploy.needs).toEqual(["gate", "images"]);
    expect(workflow.jobs.deploy.concurrency["cancel-in-progress"]).toBe(false);
    const build = JSON.stringify(workflow.jobs.images);
    expect(build).not.toContain("SSH_KEY");
    expect(build).not.toContain("KUBE_CONFIG");
    expect(workflow.jobs.images.permissions.packages).toBe("write");
    expect(workflow.jobs.deploy.permissions.packages).toBe("write");
    expect(build).toContain("kq-dev");
  });

  test("only checked controller code orchestrates the tested source checkout", () => {
    let sourceCheckouts = 0;
    let controllerCheckouts = 0;
    for (const workflow of [preview(), cleanup()]) {
      for (const [id, job] of Object.entries(workflow.jobs)) {
        for (const step of job.steps) {
          if (step.uses?.startsWith("actions/checkout@")) {
            expect(step.with["persist-credentials"]).toBe(false);
            if (id === "images" && step.with.path === "source") {
              expect(step.with.ref).toBe("${{ needs.gate.outputs.sha }}");
              sourceCheckouts++;
            } else {
              expect(step.with.ref).toBe("${{ github.workflow_sha }}");
              controllerCheckouts++;
            }
          }
          if (step.uses === "actions/github-script@v7") {
            expect(step.with.script).not.toContain("source/");
            expect(step["working-directory"]).toBeUndefined();
          }
        }
      }
    }
    expect(sourceCheckouts).toBe(1);
    expect(controllerCheckouts).toBe(4);
  });

  test("package writes are restricted to the three authorized jobs", () => {
    const publishing = preview();
    const removal = cleanup();
    expect(publishing.permissions).toEqual({ contents: "read" });
    expect(Object.keys(publishing.jobs).sort()).toEqual(["deploy", "gate", "images"]);
    expect(Object.keys(removal.jobs)).toEqual(["cleanup"]);
    const writers = [];
    for (const [workflowName, workflow] of [["preview", publishing], ["cleanup", removal]]) {
      for (const [id, job] of Object.entries(workflow.jobs)) {
        const permissions = job.permissions ?? workflow.permissions;
        if (permissions.packages === "write") writers.push(`${workflowName}/${id}`);
        if (id === "gate") expect(permissions.packages).toBeUndefined();
      }
    }
    expect(writers.sort()).toEqual(["cleanup/cleanup", "preview/deploy", "preview/images"]);
    const build = JSON.stringify(publishing.jobs.images);
    for (const credential of ["SSH_HOST", "SSH_PORT", "SSH_USER", "SSH_KEY", "KUBE_CONFIG"]) {
      expect(build).not.toContain(credential);
    }
  });

  test("only deploy and cleanup share the uncancelled per-PR lock", () => {
    const publishing = preview();
    const removal = cleanup();
    expect(publishing.concurrency).toBeUndefined();
    expect(removal.concurrency).toBeUndefined();
    expect(publishing.jobs.images.concurrency).toBeUndefined();
    const deployLock = publishing.jobs.deploy.concurrency;
    const cleanupLock = removal.jobs.cleanup.concurrency;
    expect(deployLock["cancel-in-progress"]).toBe(false);
    expect(cleanupLock["cancel-in-progress"]).toBe(false);
    for (const pr of ["17", "18"]) {
      const expected = `kq-preview-pr-${pr}`;
      expect(interpolate(deployLock.group, { needs: { gate: { outputs: { pr } } } })).toBe(expected);
      for (const dispatched of [false, true]) {
        expect(interpolate(cleanupLock.group, {
          github: { event: { pull_request: dispatched ? {} : { number: Number(pr) } } },
          inputs: dispatched ? { pr_number: pr } : {},
        })).toBe(expected);
      }
    }
  });

  test("eligible deploy preflight fails before SSH and preserves a private publication", () => {
    const workflow = preview();
    const { images, deploy } = workflow.jobs;
    const preflight = deploy.steps.find((step) => step.run?.includes("images.cjs verify"));
    const helm = deploy.steps.find((step) => step.id === "helm");
    expect(preflight.run).toBe('node deploy/preview/images.cjs verify "$IMAGE_MANIFEST"');
    expect(preflight.if).toBe("steps.recheck.outputs.allowed == 'true'");
    expect(preflight["continue-on-error"]).toBeUndefined();
    expect(preflight.env).toEqual({
      IMAGE_MANIFEST: "${{ runner.temp }}/kq-preview-images/kq-images.json",
    });
    expect(deploy.steps.indexOf(preflight)).toBeLessThan(deploy.steps.indexOf(helm));
    const steps = {
      recheck: { outputs: { allowed: "true" } },
      retired: { outcome: "skipped", outputs: {} },
      "retired-namespace": { outcome: "skipped" },
      helm: { outcome: "skipped", outputs: {} },
      "final-check": { outcome: "skipped", outputs: {} },
      removed: { outcome: "skipped" },
    };
    for (const [index, step] of deploy.steps.entries()) {
      if (/SSH_|KUBE_CONFIG/.test(JSON.stringify(step.env ?? {}))) {
        if (index < deploy.steps.indexOf(preflight)) {
          expect(step.id).toBe("retired-namespace");
          expect(stepAllowed(step, steps)).toBe(false);
        } else {
          expect(index).toBeGreaterThan(deploy.steps.indexOf(preflight));
        }
      }
    }
    expect(JSON.stringify(workflow)).not.toContain("GHCR_PULL_");
    expect(JSON.stringify(workflow.env ?? {})).not.toMatch(/SSH_|KUBE_CONFIG/);
    expect(JSON.stringify(deploy.env)).not.toMatch(/SSH_|KUBE_CONFIG/);
    expect(read("deploy/preview/remote.sh")).not.toContain("GHCR_PULL_");
    expect(images.steps.some((step) => step.run?.includes("images.cjs verify"))).toBe(false);
    const manifest = images.steps.findIndex((step) => step.id === "manifest");
    const upload = images.steps.findIndex((step) => step.uses === "actions/upload-artifact@v4");
    const revoked = images.steps.findIndex((step) => step.id === "revoked");
    expect(manifest).toBeGreaterThanOrEqual(0);
    expect(upload).toBeGreaterThan(manifest);
    expect(revoked).toBeGreaterThan(upload);
    expect(stepAllowed(helm, steps, false)).toBe(false);
    for (const id of ["retired-namespace", "retired-images", "removed", "compensated-images"]) {
      const step = deploy.steps.find((entry) => entry.id === id);
      expect(stepAllowed(step, steps, false)).toBe(false);
    }
  });

  test("deploy retries retain the original successful publish attempt", () => {
    const { images, deploy } = preview().jobs;
    expect(images.outputs.attempt).toBe("${{ steps.manifest.outputs.attempt }}");
    expect(deploy.if).toBe(
      "needs.images.outputs.attempt != '' && needs.images.outputs.deployable == 'true'",
    );
    const publishedAttempt = interpolate(images.outputs.attempt, {
      steps: { manifest: { outputs: { attempt: "1" } } },
    });
    const context = {
      github: { run_id: "99", run_attempt: "2" },
      needs: {
        gate: { outputs: { pr: "17", sha: revision, owner: "example", run: "88" } },
        images: { outputs: { attempt: publishedAttempt, deployable: "true" } },
      },
    };
    const env = Object.fromEntries(Object.entries(deploy.env).map(([key, value]) =>
      [key, interpolate(value, context)]));
    expect(env.PREVIEW_RUN).toBe("99");
    expect(env.PREVIEW_ATTEMPT).toBe("1");
    expect(deploy.env.PREVIEW_ATTEMPT).toBe("${{ needs.images.outputs.attempt }}");
    expect(images.env.PREVIEW_ATTEMPT).toBe("${{ github.run_attempt }}");
    const upload = images.steps.find((step) => step.uses === "actions/upload-artifact@v4");
    const download = deploy.steps.find((step) => step.uses === "actions/download-artifact@v4");
    const firstPublish = { ...context, github: { ...context.github, run_attempt: "1" } };
    const originalArtifact = `kq-preview-images-${revision}-99-1`;
    expect(interpolate(upload.with.name, firstPublish)).toBe(originalArtifact);
    expect(interpolate(download.with.name, context)).toBe(originalArtifact);
    const republishedArtifact = interpolate(upload.with.name, context);
    expect(republishedArtifact).toBe(`kq-preview-images-${revision}-99-2`);
    expect(republishedArtifact).not.toBe(originalArtifact);
    expect(interpolate(download.with.name, {
      ...context,
      needs: { ...context.needs, images: { outputs: { attempt: "2", deployable: "true" } } },
    })).toBe(republishedArtifact);
    expect(interpolate(upload.with.name, {
      ...context, github: { run_id: "100", run_attempt: "1" },
    })).toBe(`kq-preview-images-${revision}-100-1`);
    expect(upload.with.overwrite).not.toBe(true);
    expect(download.with["run-id"]).toBeUndefined();
    const build = images.steps.find((step) => step.run?.includes("docker buildx bake"));
    expect(interpolate(build.env.IMAGE_TAG, firstPublish)).toBe(
      imageTag(env.PREVIEW_PR, env.PREVIEW_SHA, env.PREVIEW_RUN, env.PREVIEW_ATTEMPT),
    );
    expect(build.run).toContain("--provenance=false --sbom=false");
  });

  test("CI validates the publishing configuration without building or pushing", () => {
    const ci = parse(read(".github/workflows/ci.yml"));
    const job = ci.jobs["lint-and-typecheck"];
    const validations = job.steps.filter((step) => step.run?.includes("docker buildx bake"));
    expect(validations).toHaveLength(1);
    const [validation] = validations;
    expect(validation.if).toBeUndefined();
    expect(validation["continue-on-error"]).toBeUndefined();
    expect(validation.run.replace(/\s+/g, " ").trim()).toBe(
      "docker buildx bake --file deploy/preview/images.hcl --provenance=false --sbom=false --print",
    );
    expect(validation.env).toEqual({
      IMAGE_PREFIX: "ghcr.io/example/kq-dev",
      IMAGE_SOURCE: "https://github.com/example/example",
      REVISION: revision,
      IMAGE_TAG: `pr-1-sha-${revision}-run-1-1`,
    });
    expect(ci.permissions.packages).toBeUndefined();
    expect(job.permissions?.packages).toBeUndefined();
    expect(job.steps.some((step) => step.uses?.startsWith("docker/login-action@"))).toBe(false);
  });

  test("deployment compensation deletes only its exact original publish tag", async () => {
    const { deploy } = preview().jobs;
    const remove = deploy.steps.find((step) => step.id === "removed");
    const images = deploy.steps.find((step) => step.id === "compensated-images");
    const notice = deploy.steps.find((step) => step.id === "compensated-notice");
    expect(deploy.steps.indexOf(images)).toBeGreaterThan(deploy.steps.indexOf(remove));
    expect(deploy.steps.indexOf(notice)).toBeGreaterThan(deploy.steps.indexOf(images));
    for (const outcome of ["success", "failure", "cancelled", "skipped"]) {
      const steps = { removed: { outcome } };
      expect(stepAllowed(images, steps, false)).toBe(outcome === "success");
      expect(stepAllowed(notice, steps, false)).toBe(outcome === "success");
    }
    const calls = [];
    await runScript(images, {
      "./deploy/preview/images.cjs": { imageTag },
      "./deploy/preview/ghcr-cleanup.cjs": {
        cleanupImages: async (_api, options) => calls.push(options),
      },
    }, { PREVIEW_PR: "17", PREVIEW_SHA: revision, PREVIEW_RUN: "99", PREVIEW_ATTEMPT: "1" });
    expect(calls).toEqual([{ pr: "17", tag: `pr-17-sha-${revision}-run-99-1` }]);
  });

  test("handoff requires a successful non-revoked publication and a publish attempt", () => {
    const { images, deploy } = preview().jobs;
    const handoff = images.steps.find((step) => step.id === "handoff");
    const remove = images.steps.find((step) => step.id === "late-images");
    expect(images.outputs.deployable).toBe("${{ steps.handoff.outputs.deployable }}");
    expect(images.steps.at(-1)).toBe(handoff);
    expect(images.steps.indexOf(handoff)).toBeGreaterThan(images.steps.indexOf(remove));
    expect(handoff.if).toBe("success() && steps.revoked.outputs.allowed == 'false'");
    expect(handoff.run).toBe('echo "deployable=true" >> "$GITHUB_OUTPUT"');
    for (const allowed of ["true", "false", "", undefined]) {
      for (const successful of [true, false]) {
        const mayHandoff = stepAllowed(handoff, { revoked: { outputs: { allowed } } }, successful);
        expect(mayHandoff).toBe(successful && allowed === "false");
        const deployable = interpolate(images.outputs.deployable, {
          steps: { handoff: { outputs: { deployable: mayHandoff ? "true" : "" } } },
        });
        for (const attempt of ["1", ""]) {
          expect(runInNewContext(deploy.if, {
            needs: { images: { outputs: { attempt, deployable } } },
          })).toBe(mayHandoff && attempt !== "");
        }
      }
    }
    for (const deployable of ["false", "", "TRUE", undefined]) {
      expect(runInNewContext(deploy.if, {
        needs: { images: { outputs: { attempt: "1", deployable } } },
      })).toBe(false);
    }
  });

  test("a queued deploy reconciles revoked PRs before downloading any artifact", async () => {
    const { deploy } = preview().jobs;
    const recheck = deploy.steps.find((step) => step.id === "recheck");
    const retired = deploy.steps.find((step) => step.id === "retired");
    const namespace = deploy.steps.find((step) => step.id === "retired-namespace");
    const download = deploy.steps.find((step) => step.uses === "actions/download-artifact@v4");
    const kubectl = deploy.steps.find((step) => step.uses === "azure/setup-kubectl@v4");
    const publicPull = deploy.steps.find((step) => step.run?.includes("images.cjs verify"));
    const helm = deploy.steps.find((step) => step.id === "helm");
    const setupHelm = deploy.steps.find((step) => step.uses === "azure/setup-helm@v4");
    expect(deploy.steps.indexOf(recheck)).toBeLessThan(deploy.steps.indexOf(retired));
    expect(deploy.steps.indexOf(retired)).toBeLessThan(deploy.steps.indexOf(kubectl));
    expect(deploy.steps.indexOf(kubectl)).toBeLessThan(deploy.steps.indexOf(namespace));
    expect(deploy.steps.indexOf(namespace)).toBeLessThan(deploy.steps.indexOf(download));
    expect(namespace.run).toBe("bash deploy/preview/remote.sh cleanup");
    expect(namespace["continue-on-error"]).toBeUndefined();
    const env = { PREVIEW_PR: "17", TEST_RUN_ID: "88" };
    for (const state of ["open", "closed", "draft", "paused", "untrusted", "lookup-failed"]) {
      const fixture = cleanupFixture(state);
      const recheckOutputs = {};
      await runScript(recheck, {
        "./deploy/preview/gate.cjs": {
          gate: async ({ core }, options) => {
            expect(options).toEqual({ pr: "17", runId: "88" });
            core.setOutput("allowed", "false");
          },
        },
      }, env, {
        core: { setOutput: (key, value) => { recheckOutputs[key] = value; } },
      });
      const steps = {
        recheck: { outputs: recheckOutputs },
        retired: { outputs: fixture.outputs },
      };
      expect(stepAllowed(retired, steps)).toBe(true);
      const execution = runScript(
        retired, { "./deploy/preview/gate.cjs": { cleanupGate } }, env, fixture.api,
      );
      if (state === "lookup-failed") {
        await expect(execution).rejects.toThrow("Mock PR lookup unavailable");
      } else {
        await execution;
      }
      const shouldRemove = !["open", "lookup-failed"].includes(state);
      expect(fixture.requests).toEqual([17]);
      expect(stepAllowed(namespace, steps, state !== "lookup-failed")).toBe(shouldRemove);
      expect(stepAllowed(kubectl, steps, state !== "lookup-failed")).toBe(shouldRemove);
      for (const step of [download, publicPull, setupHelm, helm]) {
        expect(stepAllowed(step, steps, state !== "lookup-failed")).toBe(false);
      }
    }
    for (const allowed of ["true", "", undefined]) {
      expect(stepAllowed(retired, { recheck: { outputs: { allowed } } })).toBe(false);
    }
    expect(stepAllowed(retired, { recheck: { outputs: { allowed: "false" } } }, false)).toBe(false);
  });

  test("retired deploys replace lost cleanup with namespace-first all-PR reclamation", async () => {
    const { deploy } = preview().jobs;
    const namespace = deploy.steps.find((step) => step.id === "retired-namespace");
    const images = deploy.steps.find((step) => step.id === "retired-images");
    const notice = deploy.steps.find((step) => step.id === "retired-notice");
    const download = deploy.steps.find((step) => step.uses === "actions/download-artifact@v4");
    expect(deploy.steps.indexOf(images)).toBeGreaterThan(deploy.steps.indexOf(namespace));
    expect(deploy.steps.indexOf(notice)).toBeGreaterThan(deploy.steps.indexOf(images));
    expect(deploy.steps.indexOf(notice)).toBeLessThan(deploy.steps.indexOf(download));
    for (const outcome of ["success", "failure", "cancelled", "skipped"]) {
      const steps = { "retired-namespace": { outcome } };
      expect(stepAllowed(images, steps, false)).toBe(outcome === "success");
      expect(stepAllowed(notice, steps, false)).toBe(outcome === "success");
    }
    for (const imageApiFails of [false, true]) {
      const calls = [];
      const env = { PREVIEW_PR: "17", PREVIEW_SHA: revision, PREVIEW_RUN: "99", PREVIEW_ATTEMPT: "1" };
      const execution = runScript(images, {
        "./deploy/preview/ghcr-cleanup.cjs": {
          cleanupImages: async (_api, options) => {
            calls.push(["images", options]);
            if (imageApiFails) throw new Error("Mock package API unavailable");
          },
        },
      }, env);
      if (imageApiFails) {
        await expect(execution).rejects.toThrow("Mock package API unavailable");
      } else {
        await execution;
      }
      await runScript(notice, {
        "./deploy/preview/notice.cjs": {
          notice: async (_api, ...args) => calls.push(["notice", ...args]),
        },
      }, env);
      expect(calls).toEqual([["images", { pr: "17" }], ["notice", "inactive", "17"]]);
    }
  });

  test("namespace cleanup gates image deletion and notice survives an image API failure", async () => {
    const job = cleanup().jobs.cleanup;
    const namespace = job.steps.find((step) => step.id === "namespace");
    const images = job.steps.find((step) => step.with?.script?.includes("cleanupImages("));
    const notice = job.steps.find((step) => step.with?.script?.includes(".notice("));
    expect(namespace.run).toBe("bash deploy/preview/remote.sh cleanup");
    expect(namespace.if).toBe("steps.check.outputs.allowed == 'true'");
    expect(namespace["continue-on-error"]).toBeUndefined();
    expect(images.env.PREVIEW_PR).toBe("${{ steps.check.outputs.pr }}");
    expect(job.steps.indexOf(images)).toBeGreaterThan(job.steps.indexOf(namespace));
    expect(job.steps.indexOf(notice)).toBeGreaterThan(job.steps.indexOf(images));
    for (const outcome of ["success", "failure", "cancelled", "skipped"]) {
      const steps = { namespace: { outcome } };
      expect(stepAllowed(images, steps)).toBe(outcome === "success");
      expect(stepAllowed(notice, steps, false)).toBe(outcome === "success");
    }
    const calls = [];
    await expect(runScript(images, {
      "./deploy/preview/ghcr-cleanup.cjs": {
        cleanupImages: async (_api, options) => {
          calls.push(options);
          throw new Error("Mock package API unavailable");
        },
      },
    }, { PREVIEW_PR: "17" })).rejects.toThrow("Mock package API unavailable");
    expect(calls).toEqual([{ pr: "17" }]);
    const notices = [];
    await runScript(notice, {
      "./deploy/preview/notice.cjs": {
        notice: async (_api, ...args) => notices.push(args),
      },
    }, { PREVIEW_PR: "17" });
    expect(notices).toEqual([["inactive", "17"]]);
  });

  test("image tail rechecks the explicit PR and removes only a revoked late publication", async () => {
    const { images } = preview().jobs;
    const revoked = images.steps.find((step) => step.id === "revoked");
    const remove = images.steps.find((step) => step.id === "late-images");
    const env = { PREVIEW_PR: "17", PREVIEW_SHA: revision, PREVIEW_RUN: "99", PREVIEW_ATTEMPT: "2" };
    expect(images.steps.indexOf(remove)).toBeGreaterThan(images.steps.indexOf(revoked));
    expect(stepAllowed(revoked, { recheck: { outputs: { allowed: "true" } } }, false)).toBe(true);
    expect(stepAllowed(revoked, { recheck: { outputs: {} } }, false)).toBe(false);
    for (const state of ["open", "closed", "lookup-failed"]) {
      const { api, outputs, requests } = cleanupFixture(state);
      const execution = runScript(
        revoked, { "./tooling/deploy/preview/gate.cjs": { cleanupGate } }, env, api,
      );
      if (state === "lookup-failed") {
        await expect(execution).rejects.toThrow("Mock PR lookup unavailable");
      } else {
        await execution;
      }
      expect(requests).toEqual([17]);
      expect(outputs.allowed).toBe(state === "closed" ? "true" : "false");
      expect(stepAllowed(remove, { revoked: { outputs } }, false)).toBe(state === "closed");
    }
    expect(stepAllowed(remove, { revoked: { outputs: {} } }, false)).toBe(false);
    const calls = [];
    await runScript(remove, {
      "./tooling/deploy/preview/images.cjs": { imageTag },
      "./tooling/deploy/preview/ghcr-cleanup.cjs": {
        cleanupImages: async (_api, options) => calls.push(options),
      },
    }, env);
    expect(calls).toEqual([{ pr: "17", tag: `pr-17-sha-${revision}-run-99-2` }]);
  });

  test("compensates when the final authorization query throws", () => {
    const workflow = parse(read(".github/workflows/preview.yml"));
    const remove = workflow.jobs.deploy.steps.find((step) => step.id === "removed");
    const condition = remove.if.replaceAll("steps.final-check", "steps.finalCheck");
    const allowed = runInNewContext(condition, {
      always: () => true,
      steps: {
        helm: { outcome: "success", outputs: { applied: "true" } },
        finalCheck: { outcome: "failure", outputs: {} },
      },
    });
    expect(allowed).toBe(true);
    expect(condition).not.toContain("success()");
    expect(runInNewContext(condition, {
      always: () => true,
      steps: {
        helm: { outcome: "failure", outputs: { applied: "true" } },
        finalCheck: { outcome: "skipped", outputs: {} },
      },
    })).toBe(true);
    const cleanup = parse(read(".github/workflows/preview-cleanup.yml"));
    expect(cleanup.jobs.cleanup.if).toContain("github.event.repository.default_branch");
    expect(cleanup.jobs.cleanup.if).toContain("github.event.pull_request.base.ref");
    expect(cleanup.jobs.cleanup.concurrency["cancel-in-progress"]).toBe(false);
  });

  test("SSH waiver never disables Kubernetes or HTTPS authentication", () => {
    const script = read("deploy/preview/remote.sh");
    expect(script).toContain("-L 127.0.0.1:16443:127.0.0.1:6443");
    expect(script).toContain("StrictHostKeyChecking=no");
    expect(script).not.toContain("--insecure-skip-tls-verify");
    expect(script).not.toContain("curl -k");
    expect(script).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
    expect(script).toContain("Namespace ownership mismatch");
    expect(script).toContain('kubectl delete namespace "$namespace"');
    expect(script).toContain("--atomic --wait --wait-for-jobs");
    expect(script).not.toContain("helm uninstall --all");
  });

  test("preview charts and secret helper agree on cookie and certificate keys", () => {
    const gateway = read("deploy/helm/kq-platform/templates/preview-gateway.yaml");
    expect(gateway).toContain('\"${#PREVIEW_COOKIE}\" -eq 64');
    expect(gateway).toContain("credentialsRevision");
    const server = read("deploy/helm/kq-platform/templates/server-deployment.yaml");
    for (const key of ["SERVER_CA_CERT", "SERVER_CA_KEY", "SERVER_TLS_CERT", "SERVER_TLS_KEY"]) {
      expect(server).toContain(key);
    }
  });

  test("retains initialization barriers for later Pod restarts", () => {
    for (const file of ["seed-job.yaml", "db-migration.yaml", "rustfs-bootstrap.yaml"]) {
      expect(read(`deploy/helm/kq-platform/templates/${file}`)).not.toContain("ttlSecondsAfterFinished");
    }
  });

  test("generates compatible persistent CA and matching server identity", () => {
    const data = {};
    addTlsData(data, "kq-pr-17");
    const decode = (key) => Buffer.from(data[key], "base64");
    const ca = new X509Certificate(decode("SERVER_CA_CERT"));
    const server = new X509Certificate(decode("SERVER_TLS_CERT"));
    expect(ca.ca).toBe(true);
    expect(server.verify(ca.publicKey)).toBe(true);
    expect(server.checkHost("kq-pr-17-server")).toBe("kq-pr-17-server");
    const privateKey = createPrivateKey(decode("SERVER_TLS_KEY"));
    expect(createPublicKey(privateKey).equals(server.publicKey)).toBe(true);
    const previous = JSON.stringify(data);
    addTlsData(data, "kq-pr-17");
    expect(JSON.stringify(data) === previous).toBe(true);
    expect(() => addTlsData({ SERVER_CA_CERT: data.SERVER_CA_CERT }, "kq-pr-17")).toThrow();
  }, 15000);
});

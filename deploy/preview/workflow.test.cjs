const { describe, expect, test } = require("bun:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const { X509Certificate, createPrivateKey, createPublicKey } = require("node:crypto");
const { parse } = require("yaml");
const { addTlsData } = require("./credentials.cjs");

const root = resolve(__dirname, "../..");
const read = (file) => readFileSync(resolve(root, file), "utf8");

describe("privileged preview orchestration boundaries", () => {
  test("only defaults to workflow completion and default-branch manual control", () => {
    const workflow = parse(read(".github/workflows/preview.yml"));
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.pull_request_target).toBeUndefined();
    expect(workflow.on.workflow_run.workflows).toEqual(["PR preview tests"]);
    expect(workflow.jobs.gate.if).toContain("github.event.repository.default_branch");
    expect(workflow.jobs.gate.steps[0].with.ref).toBe("${{ github.workflow_sha }}");
    expect(workflow.jobs.deploy.environment).toBeUndefined();
    expect(workflow.jobs.deploy.needs).toEqual(["gate", "images"]);
    expect(workflow.jobs.deploy.concurrency["cancel-in-progress"]).toBe(false);
    const build = JSON.stringify(workflow.jobs.images);
    expect(build).not.toContain("SSH_KEY");
    expect(build).not.toContain("KUBE_CONFIG");
    expect(workflow.jobs.images.permissions.packages).toBe("write");
    expect(workflow.jobs.deploy.permissions.packages).toBeUndefined();
    expect(build).toContain("kq-dev");
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

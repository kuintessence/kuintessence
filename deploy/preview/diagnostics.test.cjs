const { describe, expect, test } = require("bun:test");
const { diagnosticCode, diagnosticLine, prepare, cleanup, previewScope } = require("./resources.cjs");

describe("public-safe preview resource diagnostics", () => {
  test("reports only an allowlisted RBAC verb, resource and API group", () => {
    expect(diagnosticCode({
      stderr: Buffer.from('Error from server (Forbidden): confidential-name: User "private-user" cannot list resource "roles" in API group "rbac.authorization.k8s.io" in the namespace "preview"'),
    })).toBe("RBAC_DENIED verb=list resource=roles group=rbac.authorization.k8s.io");
    expect(diagnosticCode({
      stderr: 'Forbidden: private-user cannot get resource "secrets" in API group ""',
    })).toBe("RBAC_DENIED verb=get resource=secrets group=core");
    for (const stderr of [
      'Forbidden: cannot get resource "privatevalue" in API group "apps"',
      'Forbidden: cannot list resource "secrets" in API group "private.example"',
      'Forbidden: cannot list resource "roles" in API group ""',
      'Forbidden: private-cluster private-token',
      'Forbidden:\nprivate-token\u001b[31m\ncannot list resource "private" in API group ""',
    ]) expect(diagnosticCode({ stderr })).toBe("RBAC_DENIED");
  });

  test("stages distinguish inventory failures from Helm failures without new mutations", () => {
    const scope = previewScope({
      PREVIEW_PR: "16", PREVIEW_NAMESPACE: "preview", PREVIEW_RELEASE: "kq-pr-16",
      GITHUB_REPOSITORY: "example/project",
    });
    for (const operation of [prepare, cleanup]) {
      for (const failedCommand of ["kubectl", "helm"]) {
        const calls = [];
        let failure;
        try {
          operation(scope, (command, args) => {
            calls.push([command, args]);
            if (command === failedCommand) {
              const error = new Error("private command arguments");
              error.stderr = 'Forbidden: private-user cannot list resource "secrets" in API group ""';
              throw error;
            }
            return '{"items":[]}';
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeDefined();
        expect(diagnosticLine(failure)).toBe(
          `KQ_PREVIEW_RESOURCE_ERROR stage=${failedCommand === "kubectl" ? "INVENTORY_READ" : "HELM_LIST"} code=RBAC_DENIED verb=list resource=secrets group=core`,
        );
        expect(calls.every(([command, args]) =>
          command === "kubectl" ? args[2] === "get" : args[0] === "list")).toBe(true);
      }
    }
  });

  test("untrusted stage values cannot enter public diagnostics", () => {
    expect(diagnosticLine({
      previewStage: "private-stage\nsecret-value",
      stderr: "private-stderr",
      stdout: "private-stdout",
    })).toBe("KQ_PREVIEW_RESOURCE_ERROR stage=LIFECYCLE code=UNCLASSIFIED_FAILURE");
  });

  test("classifies known lifecycle failures without dumping inventory or commands", () => {
    expect(diagnosticCode(new Error("Existing preview resources require an owned release marker")))
      .toBe("OWNER_MARKER_MISSING");
    expect(diagnosticCode(new Error("Preview resource ownership mismatch")))
      .toBe("RESOURCE_OWNERSHIP_MISMATCH");
    expect(diagnosticCode(new Error("Preview resource changed after ownership preflight")))
      .toBe("RESOURCE_CHANGED");
    expect(diagnosticCode(new SyntaxError("private JSON value"))).toBe("INVALID_JSON_RESPONSE");
    expect(diagnosticCode({ code: "ENOENT", path: "/private/path" })).toBe("COMMAND_OR_FILE_MISSING");
    expect(diagnosticCode({ code: "ETIMEDOUT", stdout: "private-data" })).toBe("COMMAND_TIMEOUT");
  });

  test("never prints arbitrary stderr, stdout, messages or credential material", () => {
    for (const error of [
      new Error("private-secret"),
      { stderr: "private-secret", stdout: "private-secret", message: "private-secret" },
      { stderr: { toString: () => "private-secret" } },
      null,
      undefined,
    ]) expect(diagnosticCode(error)).toBe("UNCLASSIFIED_FAILURE");
    for (const [stderr, code] of [
      ["Unauthorized: private-token", "API_UNAUTHORIZED"],
      ["the server doesn't have a resource type private-resource", "API_RESOURCE_UNAVAILABLE"],
      ["x509: certificate is valid for private-host", "API_TLS_FAILURE"],
      ["Unable to connect to the server private-address", "API_UNREACHABLE"],
    ]) expect(diagnosticCode({ stderr })).toBe(code);
  });
});

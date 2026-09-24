import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { usecase } from "@kuintessence/shared";
import {
  canonicalJson,
  parseSignedEcosystemBundle,
  type SignedEcosystemBundle,
  verifyEcosystemBundle,
} from "../../../packages/registry/src/services/ecosystem-release-service";
import { ReleaseSchema } from "../spack-case/api";
import { selectedCase } from "../spack-case/fixture";
import {
  registerWorkflowAssets,
  setupWorkflowSigning,
  type WorkflowAssetsOptions,
  type WorkflowAssetsStage,
} from "./workflow-assets";
import { type WorkflowAssets, WorkflowAssetsSchema } from "./workflow-contract";
import {
  workflowPrivateKeyPath,
  workflowSigningKeyId,
  workflowTrustedKeysPath,
} from "./workflow-signing";

const flags = ["KQ_PR_TEST", "KQ_PR_SPACK_WORKFLOW", "KQ_PR_SPACK_CASE"] as const;
const original = new Map(flags.map((key) => [key, process.env[key]]));
const releaseId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const packageId = "44444444-4444-4444-8444-444444444444";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

beforeEach(() => {
  process.env.KQ_PR_TEST = "1";
  process.env.KQ_PR_SPACK_WORKFLOW = "1";
  process.env.KQ_PR_SPACK_CASE = "hello";
});

afterEach(() => {
  for (const key of flags) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type Fault =
  | "none"
  | "digest"
  | "activate"
  | "inactive"
  | "payload"
  | "license"
  | "revision"
  | "network";

function registrationFixture(fault: Fault = "none") {
  const fixture = selectedCase();
  const keys = generateKeyPairSync("ed25519");
  const trusted = {
    [workflowSigningKeyId]: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
  const material = ReleaseSchema.parse({
    binding: {
      repositoryId: sha256(fixture.repository),
      manifestDigest: `sha256:${"a".repeat(64)}`,
    },
    spec: fixture.spec,
    target: "linux-ubuntu20.04-x86_64",
    manifestSize: 1024,
    recipeId: sha256(fixture.recipes),
    commit: "b".repeat(40),
  });
  const calls: Array<{ path: string; body?: unknown }> = [];
  const receipts: WorkflowAssets[] = [];
  const stages: WorkflowAssetsStage[] = [];
  let bundle: SignedEcosystemBundle | undefined;
  let created: usecase.UsecasePackageCreate | undefined;
  const release = (status: string) => {
    assert(bundle);
    return {
      id: releaseId,
      releaseKey: bundle.manifest.releaseKey,
      version: bundle.manifest.version,
      artifactDigest: `sha256:${sha256(canonicalJson(bundle.manifest))}`,
      status,
    };
  };
  const options: WorkflowAssetsOptions = {
    onStage: (stage) => {
      stages.push(stage);
    },
    readText: async (path) => {
      expect(path).toBe("/case-control/release.json");
      return JSON.stringify(material);
    },
    readSigner: async () => keys.privateKey,
    login: async (origin) => {
      expect(origin).toBe("http://server:3000");
      return "private-test-token";
    },
    request: async (origin, token, path, body) => {
      expect(origin).toBe("http://registry:3100");
      expect(token).toBe("private-test-token");
      calls.push({ path, body });
      if (fault === "network") throw new Error("Synthetic HTTP failure");
      if (path === "/ecosystem-releases/import") {
        bundle = parseSignedEcosystemBundle(body);
        verifyEcosystemBundle(bundle, trusted);
        return fault === "digest"
          ? { ...release("staged"), artifactDigest: `sha256:${"f".repeat(64)}` }
          : release("staged");
      }
      if (path === `/ecosystem-releases/${releaseId}/activate`) {
        expect(body).toEqual({});
        return release(fault === "activate" ? "staged" : "active");
      }
      if (path === `/ecosystem-releases/pr-spack-managed-${fixture.id}-workflow/status`) {
        expect(body).toBeUndefined();
        assert(bundle?.manifest.assets[0]);
        const entry = structuredClone(bundle.manifest.assets[0]);
        return {
          release: release(fault === "inactive" ? "inactive" : "active"),
          assets: [
            {
              ...entry,
              assetId,
              assetRevisionId: revisionId,
              payload: fault === "payload"
                ? {
                    kind: "spack-package",
                    spack: { packageName: fixture.name, defaultSpec: "wrong" },
                  }
                : entry.payload,
              licensePolicy: fault === "license"
                ? { ...entry.licensePolicy, acceptanceRequired: true }
                : entry.licensePolicy,
            },
          ],
        };
      }
      if (path === "/usecase-packages") {
        created = usecase.UsecasePackageCreateSchema.parse(body);
        return { ...created, id: packageId, namespace: "platform" };
      }
      if (path === `/usecase-packages/${packageId}`) {
        expect(body).toBeUndefined();
        assert(created);
        return {
          ...created,
          id: packageId,
          namespace: "platform",
          publishedSoftwareRevisionId: fault === "revision" ? assetId : revisionId,
        };
      }
      throw new Error("Unexpected registration API");
    },
    writeReceipt: async (receipt) => {
      receipts.push(WorkflowAssetsSchema.parse(receipt));
    },
  };
  return {
    options,
    calls,
    receipts,
    stages,
    material,
    trusted,
    bundle: () => {
      assert(bundle);
      return bundle;
    },
  };
}

describe("managed workflow signing", () => {
  test("setup export writes an ephemeral private key separately from public Registry trust", async () => {
    const writes = new Map<string, { content: string; mode: number }>();
    const directories: string[] = [];
    await setupWorkflowSigning({
      getuid: () => 0,
      mkdir: async (path) => {
        directories.push(path);
      },
      writeExclusive: async (path, content, mode) => {
        writes.set(path, { content, mode });
      },
    });
    expect(directories).toEqual(["/case-server", "/case-control"]);
    expect([...writes.keys()]).toEqual([workflowPrivateKeyPath, workflowTrustedKeysPath]);
    const privateFile = writes.get(workflowPrivateKeyPath);
    const publicFile = writes.get(workflowTrustedKeysPath);
    assert(privateFile && publicFile);
    expect(privateFile.mode).toBe(0o600);
    expect(publicFile.mode).toBe(0o444);
    const privateKey = createPrivateKey(privateFile.content);
    expect(privateKey.asymmetricKeyType).toBe("ed25519");
    expect(JSON.parse(publicFile.content)).toEqual({
      [workflowSigningKeyId]: createPublicKey(privateKey)
        .export({ format: "der", type: "spki" })
        .toString("base64"),
    });
    expect(publicFile.content).not.toContain("PRIVATE KEY");
    expect(publicFile.content).not.toContain(privateFile.content);
  });

  test("setup refuses non-root before writing files", async () => {
    let wrote = false;
    await expect(
      setupWorkflowSigning({
        getuid: () => 1000,
        mkdir: async () => {
          throw new Error("Filesystem must not be accessed");
        },
        writeExclusive: async () => {
          wrote = true;
        },
      }),
    ).rejects.toThrow("requires root");
    expect(wrote).toBe(false);
  });

  test.each(["KQ_PR_TEST", "KQ_PR_SPACK_WORKFLOW"] as const)(
    "setup and registration require %s before any I/O",
    async (flag) => {
      delete process.env[flag];
      let accessed = false;
      const stages: WorkflowAssetsStage[] = [];
      await expect(
        setupWorkflowSigning({
          getuid: () => {
            accessed = true;
            return 0;
          },
        }),
      ).rejects.toThrow();
      await expect(
        registerWorkflowAssets({
          onStage: (stage) => {
            stages.push(stage);
          },
          readText: async () => {
            accessed = true;
            return "{}";
          },
        }),
      ).rejects.toThrow();
      expect(accessed).toBe(false);
      expect(stages).toEqual(["guard"]);
    },
  );
});

describe("managed workflow public API registration", () => {
  test.each(["hello", "samtools"] as const)(
    "%s signs canonical manifest bytes and registers real API identities",
    async (caseId) => {
      process.env.KQ_PR_SPACK_CASE = caseId;
      const fixture = registrationFixture();
      const receipt = await registerWorkflowAssets(fixture.options);
      expect(receipt).toEqual({ usecaseId: packageId, softwareRevisionId: revisionId });
      expect(fixture.receipts).toEqual([receipt]);
      expect(fixture.stages).toEqual([
        "guard", "material", "sign", "auth", "import", "activate", "readback", "usecase", "receipt",
      ]);
      expect(fixture.calls.map((call) => call.path)).toEqual([
        "/ecosystem-releases/import",
        `/ecosystem-releases/${releaseId}/activate`,
        `/ecosystem-releases/pr-spack-managed-${caseId}-workflow/status`,
        "/usecase-packages",
        `/usecase-packages/${packageId}`,
      ]);
      const bundle = fixture.bundle();
      expect(() => verifyEcosystemBundle(bundle, fixture.trusted)).not.toThrow();
      expect(canonicalJson({ z: 1, a: [{ b: 2, a: "x" }] })).toBe(
        '{"a":[{"a":"x","b":2}],"z":1}',
      );
      expect(bundle.manifest.assets).toHaveLength(1);
      expect(bundle.manifest.assets[0]?.payload).toMatchObject({
        kind: "spack-package",
        spack: { packageName: caseId, defaultSpec: selectedCase().spec },
      });
      expect(bundle.manifest.assets[0]?.licensePolicy).toMatchObject({
        classification: "open-source",
        identifiers: [{ kind: "spdx", value: caseId === "hello" ? "GPL-3.0-or-later" : "MIT" }],
        autoInstall: "denied",
      });
      expect(JSON.stringify(receipt)).not.toContain("private-test-token");
      expect(Object.keys(receipt).sort()).toEqual(["softwareRevisionId", "usecaseId"]);
      const tampered = structuredClone(bundle);
      tampered.manifest.version = "tampered";
      expect(() => verifyEcosystemBundle(tampered, fixture.trusted)).toThrow();
      expect(() => verifyEcosystemBundle(bundle, {})).toThrow();
    },
  );

  test.each([
    ["digest", "import"],
    ["activate", "activate"],
    ["inactive", "readback"],
    ["payload", "readback"],
    ["license", "readback"],
    ["revision", "usecase"],
    ["network", "import"],
  ] as const)(
    "reports %s failure at %s without writing a receipt",
    async (fault, stage) => {
      const fixture = registrationFixture(fault);
      await expect(registerWorkflowAssets(fixture.options)).rejects.toThrow();
      expect(fixture.receipts).toEqual([]);
      expect(fixture.stages.at(-1)).toBe(stage);
    },
  );

  test.each(["sign", "auth", "receipt"] as const)(
    "reports injected %s I/O failures without advancing",
    async (stage) => {
      const fixture = registrationFixture();
      const fail = async () => {
        throw new Error("Synthetic I/O failure");
      };
      if (stage === "sign") fixture.options.readSigner = fail;
      if (stage === "auth") fixture.options.login = fail;
      if (stage === "receipt") fixture.options.writeReceipt = fail;
      await expect(registerWorkflowAssets(fixture.options)).rejects.toThrow("Synthetic I/O failure");
      expect(fixture.stages.at(-1)).toBe(stage);
      expect(fixture.receipts).toEqual([]);
    },
  );

  test.each(["spec", "repository", "recipe"] as const)(
    "rejects a %s material handoff mismatch before HTTP",
    async (field) => {
      const fixture = registrationFixture();
      if (field === "spec") fixture.material.spec = "wrong@0";
      if (field === "repository") fixture.material.binding.repositoryId = "f".repeat(64);
      if (field === "recipe") fixture.material.recipeId = "f".repeat(64);
      await expect(registerWorkflowAssets(fixture.options)).rejects.toThrow();
      expect(fixture.calls).toEqual([]);
      expect(fixture.receipts).toEqual([]);
      expect(fixture.stages.at(-1)).toBe("material");
    },
  );
});

import assert from "node:assert/strict";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { MeCapabilitiesSchema, SpackMaterialBindingSchema } from "@kuintessence/shared/browser";
import { expect, type Page, type Response, test } from "patchright/test";
import { z } from "zod";
import cp from "../src/locales/cp/en.json" with { type: "json" };
import type { ArtifactStage } from "./material-artifacts.reporter";

const origin = "http://127.0.0.1:15173";
const api = "/platform/api/cp/software";
const agentId = "pr-scheduler";
const spec = "hello@2.12.1";
const OperationSchema = z.object({
  id: z.string().uuid(),
  agentId: z.literal(agentId),
  action: z.literal("install"),
  spec: z.literal(spec),
  status: z.enum(["queued", "running", "succeeded", "failed", "rejected"]),
});
const OverviewSchema = z.object({
  agents: z.array(
    z.object({
      agentId: z.string(),
      controlChannelOnline: z.boolean(),
      installedCount: z.number().int().nonnegative(),
      installedSpecs: z.array(z.string()),
      effectivePolicy: z
        .object({
          installMode: z.string(),
          trustedPublicAutoInstall: z.boolean(),
          preinstallList: z.array(z.string()),
        })
        .passthrough(),
    }),
  ),
});

async function stage<T>(name: ArtifactStage, action: () => Promise<T>): Promise<T> {
  return test.step(name, async () => {
    try {
      return await action();
    } catch {
      throw new Error(`artifact-web stage=${name} code=failed`);
    }
  });
}

function isResponse(response: Response, path: string, method: string): boolean {
  const url = new URL(response.url());
  return url.origin === origin && url.pathname === path && response.request().method() === method;
}

// Read-only observation. Login and the sole install POST must come from the real UI.
async function getJson(page: Page, path: string): Promise<unknown> {
  const result = await page.evaluate(async (apiPath) => {
    const token = localStorage.getItem("kq_token");
    const response = await fetch(apiPath, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: response.ok ? await response.json() : null };
  }, path);
  assert.equal(result.status, 200);
  return result.body;
}

async function history(page: Page) {
  return z
    .object({ items: z.array(OperationSchema) })
    .parse(await getJson(page, `${api}/operations?agentId=${agentId}&limit=500`)).items;
}

async function agent(page: Page) {
  const overview = OverviewSchema.parse(await getJson(page, `${api}/overview`));
  const result = overview.agents.find((item) => item.agentId === agentId);
  assert(result);
  return result;
}

test("Hello is installed manually through CP and appears in inventory", async ({ page }) => {
  const input = await stage("install-inputs", async () => {
    assert.equal(process.env.GITHUB_ACTIONS, "true");
    assert.equal(process.env.KQ_PR_SPACK_CASE, "hello");
    assert.equal(process.env.KQ_ARTIFACT_WEB_URL, origin);
    assert.equal(process.env.KQ_WEB_REGISTRY_PROXY_TARGET, "http://127.0.0.1:1");
    const bindingPath = process.env.KQ_ARTIFACT_RESULT_PATH;
    const resultPath = process.env.KQ_ARTIFACT_INSTALL_RESULT_PATH;
    assert(bindingPath && resultPath && isAbsolute(bindingPath) && isAbsolute(resultPath));
    assert.notEqual(await realpath(dirname(bindingPath)), await realpath(dirname(resultPath)));
    const info = await lstat(bindingPath);
    assert(info.isFile() && !info.isSymbolicLink() && info.size <= 16_384);
    await assert.rejects(lstat(resultPath), { code: "ENOENT" });
    const binding = SpackMaterialBindingSchema.parse(
      JSON.parse(await readFile(bindingPath, "utf8")),
    );
    return { binding, resultPath };
  });
  const writes: { path: string; method: string }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push({ path: url.pathname, method: request.method() });
    }
  });
  await stage("install-login", async () => {
    await page.addInitScript(() => localStorage.setItem("kq.lang", "en"));
    await page.goto("/login?redirect=%2Fcp%2Fsoftware");
    await page.getByTestId("login-email").fill("artifact-web-admin@example.test");
    await page.getByTestId("login-role").selectOption("super_admin");
    const [response] = await Promise.all([
      page.waitForResponse((item) => isResponse(item, "/platform/api/auth/login", "POST")),
      page.getByTestId("login-submit").click(),
    ]);
    assert.equal(response.status(), 200);
    await expect(page).toHaveURL(`${origin}/cp/software`);
    await expect(page.getByTestId("cp-layout")).toBeVisible();
    const capabilities = MeCapabilitiesSchema.parse(
      await getJson(page, "/platform/api/me/capabilities"),
    );
    assert(capabilities.capabilities.includes("workspace.provider.manage"));
  });
  const initialPolicy = await stage("install-empty", async () => {
    await expect
      .poll(async () => (await agent(page)).controlChannelOnline, {
        timeout: 120_000,
        intervals: [2000],
      })
      .toBe(true);
    const before = await agent(page);
    assert.deepEqual(before.installedSpecs, []);
    assert.equal(before.installedCount, 0);
    assert.equal(before.effectivePolicy.trustedPublicAutoInstall, false);
    assert.equal(before.effectivePolicy.installMode, "explicit-install-grant");
    assert.deepEqual(before.effectivePolicy.preinstallList, []);
    assert.deepEqual(await history(page), []);
    // Refresh the actual view after the control channel has reconnected.
    await page.reload();
    await page
      .getByTestId(`cp-software-agent-${agentId}`)
      .getByRole("button", { name: cp.cp.software.agent.inspect, exact: true })
      .click();
    await expect(page.getByTestId("cp-software-agent-sheet")).toBeVisible();
    await expect(page.getByTestId(`cp-software-installed-load-${spec}`)).toHaveCount(0);
    return before.effectivePolicy;
  });
  const operationId = await stage("install-submit", async () => {
    const form = page.getByTestId("cp-software-operation-form");
    await form.getByTestId("cp-software-operation-action").selectOption("install");
    await form.getByTestId("cp-software-operation-spec").fill(spec);
    const submit = form.getByRole("button", {
      name: cp.cp.software.operations.submit,
      exact: true,
    });
    await expect(submit).toBeEnabled();
    const [response] = await Promise.all([
      page.waitForResponse((item) => isResponse(item, `${api}/operations`, "POST")),
      submit.click(),
    ]);
    assert.equal(response.status(), 202);
    assert.deepEqual(response.request().postDataJSON(), { agentId, action: "install", spec });
    assert(z.string().uuid().safeParse(response.request().headers()["idempotency-key"]).success);
    // Read back through Server instead of depending on browser protocol response-body capture.
    const items = await history(page);
    assert.equal(items.length, 1);
    const created = items[0];
    assert(created);
    return created.id;
  });
  await stage("install-terminal", async () => {
    const row = page.getByTestId(`cp-software-operation-${operationId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(spec);
    const status = page.getByTestId(`cp-software-operation-status-${operationId}`);
    const labels = cp.cp.software.operations.status;
    await expect
      .poll(
        async () => {
          const text = await status.innerText();
          return [labels.succeeded, labels.failed, labels.rejected].some((label) =>
            text.includes(label),
          );
        },
        { timeout: 900_000, intervals: [3000] },
      )
      .toBe(true);
    await expect(status).toHaveText(labels.succeeded);
    const items = await history(page);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, operationId);
    assert.equal(items[0]?.status, "succeeded");
  });
  await stage("install-inventory", async () => {
    await expect(page.getByTestId(`cp-software-installed-load-${spec}`)).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByTestId(`cp-software-installed-uninstall-${spec}`)).toBeVisible();
    const installed = await agent(page);
    assert(installed.controlChannelOnline);
    assert.deepEqual(installed.installedSpecs, [spec]);
    assert.equal(installed.installedCount, 1);
    assert.deepEqual(installed.effectivePolicy, initialPolicy);
  });
  await stage("install-receipt", async () => {
    // Session rotation is performed only by the application's normal auth transport.
    const mutations = writes.filter(
      (item) => !(item.path === "/platform/api/auth/session/refresh" && item.method === "POST"),
    );
    assert.deepEqual(mutations, [
      { path: "/platform/api/auth/login", method: "POST" },
      { path: `${api}/operations`, method: "POST" },
    ]);
    const receipt = {
      version: 1,
      agentId,
      action: "install",
      spec,
      status: "succeeded",
      operationId,
      binding: input.binding,
    };
    await writeFile(input.resultPath, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
  });
});

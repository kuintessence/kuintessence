import { createHash } from "node:crypto";
import type { workflowDsl } from "@kuintessence/shared";

export function hashSandboxScript(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface SandboxPromptInput {
  locale: "zh-CN" | "en-US";
  language: workflowDsl.SandboxLanguage;
  runtimeName: string;
  runtimeDependencies: ReadonlyArray<{ name: string; version: string }>;
  inputs: Readonly<Record<string, workflowDsl.ScriptInputSpec>>;
  outputs: Readonly<Record<string, workflowDsl.ScriptOutputSpec>>;
  sourceApp?: string;
  targetApp?: string;
  usecase?: string;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function renderSandboxPrompt(input: SandboxPromptInput): string {
  const dependencies = input.runtimeDependencies.map((item) => `${item.name}==${item.version}`);
  if (input.locale === "en-US") {
    return [
      `Write one ${input.language} entry file for the Kuintessence Sandbox.`,
      `Runtime: ${input.runtimeName}. Available dependencies: ${dependencies.join(", ") || "none"}.`,
      `Use /kq/context.json and descriptors under /kq/inputs. Write only declared outputs under /kq/outputs.`,
      "Network access and runtime package installation are forbidden. Do not access HOME, CWD, host paths, or undeclared files.",
      `Inputs: ${json(input.inputs)}`,
      `Required outputs: ${json(input.outputs)}`,
      `Source application: ${input.sourceApp ?? "unspecified"}. Target application: ${input.targetApp ?? "unspecified"}. Usecase: ${input.usecase ?? "unspecified"}.`,
      "Return code only. Validate input types, fail with a non-zero exit code on invalid data, and write outputs atomically.",
    ].join("\n\n");
  }
  return [
    `请为 Kuintessence Sandbox 编写单入口 ${input.language} 脚本。`,
    `Runtime：${input.runtimeName}。可用依赖：${dependencies.join("、") || "无"}。`,
    "通过 /kq/context.json 获取上下文，从 /kq/inputs 下按 descriptor 读取输入，只能向 /kq/outputs 写入已声明输出。",
    "禁止联网、运行时安装依赖、访问 HOME/CWD、host 路径或未声明文件。",
    `输入：${json(input.inputs)}`,
    `必需输出：${json(input.outputs)}`,
    `源应用：${input.sourceApp ?? "未指定"}。目标应用：${input.targetApp ?? "未指定"}。Usecase：${input.usecase ?? "未指定"}。`,
    "仅返回代码。校验输入类型，非法数据以非零退出码失败，并以原子方式写入输出。",
  ].join("\n\n");
}

export interface ScriptAttestationFact {
  scriptSha256: string;
  runtimeProfileId: string;
  scope: "platform" | "provider";
  providerOrgId: string | null;
  status: "active" | "revoked" | "expired";
  allowedIdentities: readonly workflowDsl.ExecutionIdentity[];
  expiresAt: Date | null;
}

export interface SharedServiceEligibilityInput {
  assetLifecycle: string;
  scriptSha256: string;
  runtimeProfileId: string;
  providerOrgId: string;
  now?: Date;
  attestations: readonly ScriptAttestationFact[];
}

export interface SharedServiceEligibility {
  allowed: boolean;
  reason: string;
}

export function evaluateSharedServiceEligibility(
  input: SharedServiceEligibilityInput,
): SharedServiceEligibility {
  if (input.assetLifecycle !== "published") {
    return { allowed: false, reason: "script revision is not published" };
  }
  const now = input.now ?? new Date();
  const attestation = input.attestations.find(
    (item) =>
      item.status === "active" &&
      (item.expiresAt == null || item.expiresAt > now) &&
      item.scriptSha256 === input.scriptSha256 &&
      item.runtimeProfileId === input.runtimeProfileId &&
      (item.scope === "platform" || item.providerOrgId === input.providerOrgId) &&
      item.allowedIdentities.some((identity) => identity.type === "SharedService"),
  );
  return attestation
    ? { allowed: true, reason: "matching active attestation" }
    : { allowed: false, reason: "no matching active attestation" };
}

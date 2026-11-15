import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = "packages/web/src";
const controls = new Set([
  "Input",
  "Textarea",
  "NativeSelect",
  "ResourceSelectField",
  "ResourceSelect",
  "input",
  "textarea",
  "select",
  "LabeledInput",
  "NumberField",
]);
const surfaces = new Set(["PageShell", "Card", "DialogContent", "SheetContent"]);
const excluded = /(?:\.test\.|__tests__|routeTree\.gen|\/ui\/)/;
function files(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory()
      ? files(path)
      : path.endsWith(".tsx") && !excluded.test(path)
        ? [path]
        : [];
  });
}

export function checkSource(text: string, file = "surface.tsx") {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: string[] = [];
  const fields: {
    line: number;
    component: string;
    field: string;
    status: string;
    reason: string;
  }[] = [];
  const sections: { line: number; component: string }[] = [];
  function walk(node: ts.Node, boundary: boolean) {
    let inside = boundary;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText(ast);
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      const attrs = opening.attributes.properties;
      const attribute = (name: string) =>
        attrs
          .find(
            (attr): attr is ts.JsxAttribute =>
              ts.isJsxAttribute(attr) && attr.name.getText(ast) === name,
          )
          ?.initializer?.getText(ast) ?? "";
      if (surfaces.has(tag)) sections.push({ line, component: tag });
      if (tag === "Card" && boundary)
        violations.push(`${file}:${line} 显式 Card 嵌套；改为透明 section。`);
      if (controls.has(tag)) {
        const field =
          attribute("id") ||
          attribute("data-testid") ||
          attribute("name") ||
          attribute("aria-label") ||
          attribute("value") ||
          tag;
        let status = "保留";
        let reason = "自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。";
        if (/ResourceSelect/.test(tag)) {
          status = "已替换";
          reason = "共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。";
        } else if (tag === "NativeSelect" || tag === "select")
          reason =
            "少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。";
        else if (attribute("type").includes("number") || tag === "NumberField")
          reason =
            "数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。";
        else if (/checkbox|radio|file|hidden/.test(attribute("type")))
          reason = "勾选、单选、文件上传或隐藏表单值，保留原生语义。";
        else if (attribute("disabled") || attribute("readOnly"))
          reason = "只读、受权限或状态约束的字段，保留原数据展示与禁用规则。";
        if (
          file.endsWith("PropertiesPanel.tsx") &&
          /version|runtime|from-loop|from-output|case-target|default-target/.test(field) &&
          !/ResourceSelect/.test(tag)
        )
          reason =
            "嵌入编辑器未提供候选目录时的兼容分支；平台 Shell 已提供资源目录及当前图候选，运行时使用 ResourceSelect。SubWorkflow ByVersion 没有可验证的 workflowVersionId 目录，保留原 ID 输入。";
        if (file.endsWith("CpQueuesPage.tsx") && /queue-id|qos|policy-tags/.test(field))
          reason =
            "创建或登记调度器队列的外部标识/QoS/标签；不是选择现有平台队列，没有权威枚举来源。";
        if (file.endsWith("AgentCertsPanel.tsx") && /agent-id|agentId/.test(field))
          reason =
            "证书审计可查询历史或已撤销 Agent；当前在线目录不能覆盖全部有效查询对象，保留 ID 查询。";
        if (file.endsWith("SshRecordingPlayer.tsx") && /agent/.test(field))
          reason = "录像按历史 Agent 标识查询；当前目录不能可靠枚举已移除节点，保留历史 ID 过滤。";
        if (
          file.endsWith("EcosystemGovernancePanels.tsx") &&
          /providerOrg|claimant/.test(field) &&
          tag === "Input"
        )
          reason =
            "授权声明可引用当前成员目录之外的组织或声明主体；没有完整且获授权的只读候选目录，保留原标识及服务端校验。";
        if (
          file.endsWith("EcosystemGovernancePanels.tsx") &&
          /materialVersion/.test(field) &&
          tag === "Input"
        )
          reason = "材料的外部版本标识，与平台软件版本目录语义不同，没有权威候选来源。";
        if (
          file.endsWith("SoftwarePolicyTable.tsx") &&
          /preview.*(?:Usecase|Version)|preview-(?:usecase|version)/i.test(field) &&
          tag === "Input"
        )
          reason =
            "策略预览接受用例或版本标识/匹配模式；当前目录不能完整枚举策略对象，保留原查询契约。";
        if (
          file.endsWith("AgentRegistrationPage.tsx") &&
          /agent-id|agentId|name/.test(field) &&
          tag === "Input"
        )
          reason = "登记新 Agent 的标识或名称，属于创建内容，不限制为已有资源。";
        if (file.endsWith("CostRatesForm.tsx") && /cost-rates-cluster/.test(field))
          reason =
            "费率配置按调度器 cluster 名称建键，可预设尚未接入的集群；在线 Agent/算网档案不是完整同义目录，保留合法自定义键。";
        if (
          (file.endsWith("CpDataPage.tsx") ||
            file.endsWith("DataMarketPage.tsx") ||
            file.endsWith("SoftwarePage.tsx") ||
            file.endsWith("SandboxScriptStudio.tsx")) &&
          /version/i.test(field) &&
          tag === "Input"
        )
          reason = "发布或登记新版本的版本号，属于创建内容；已有版本引用在独立资源选择控件中处理。";
        fields.push({ line, component: tag, field, status, reason });
      }
      const cls = attribute("className");
      if (
        boundary &&
        [
          "div",
          "section",
          "article",
          "fieldset",
          "form",
          "label",
          "details",
          "code",
          "TabsContent",
          "ul",
          "li",
        ].includes(tag)
      ) {
        // Inspect all string branches, including template expressions and cn(...).
        const classValues: string[] = [];
        const attr = attrs.find(
          (entry): entry is ts.JsxAttribute =>
            ts.isJsxAttribute(entry) && entry.name.getText(ast) === "className",
        );
        function strings(n: ts.Node) {
          if (
            ts.isStringLiteralLike(n) ||
            ts.isTemplateHead(n) ||
            ts.isTemplateMiddle(n) ||
            ts.isTemplateTail(n)
          )
            classValues.push(n.text);
          ts.forEachChild(n, strings);
        }
        if (attr) strings(attr);
        if (
          classValues.some((value) =>
            /(?:^|\s)(?:[\w-]+:)*(?:rounded(?:-\S+)?|shadow(?:-\S+)?|bg-(?!transparent)\S+|border(?:-[0248])?)(?:\s|$)/.test(
              value,
            ),
          )
        )
          violations.push(`${file}:${line} 内层结构容器含框线、底色、圆角或阴影：${cls}`);
      }
      inside = boundary || surfaces.has(tag);
      if (tag === "DialogContent" || tag === "SheetContent") inside = true;
    }
    ts.forEachChild(node, (child) => walk(child, inside));
  }
  walk(ast, false);
  return { fields, sections, violations };
}

if (import.meta.main) {
  const inventory = files(`${sourceRoot}/components`)
    .concat(files(`${sourceRoot}/routes`))
    .sort()
    .map((file) => ({ file, ...checkSource(readFileSync(resolve(root, file), "utf8"), file) }));
  const violations = inventory.flatMap((entry) => entry.violations);
  if (process.argv.includes("--write")) {
    writeFileSync(
      resolve(root, "docs/ui/migration-inventory.json"),
      `${JSON.stringify(inventory, null, 2)}\n`,
    );
    const lines = [
      "# 全平台组件迁移清单",
      "",
      "此清单按当前源码生成，包含所有路由与业务组件（排除测试、生成文件与 UI 基础组件）。每个表单控件单独列出；页签、弹窗、抽屉及编辑器通过所属组件覆盖。静态遍历不等于逐页浏览器验收，实际渲染范围见 verification.md。",
      "",
      "运行 `bun scripts/check-ui-surfaces.ts --write` 更新；不带参数执行静态回归。",
      "",
    ];
    for (const entry of inventory) {
      lines.push(
        `## ${entry.file}`,
        "",
        `容器：${entry.sections.map((section) => `${section.component}:${section.line}`).join("、") || "继承父容器 / 无独立容器"}。`,
        "",
      );
      if (!entry.fields.length)
        lines.push(
          "已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。",
          "",
        );
      else {
        lines.push("| 行 | 控件 / 字段 | 状态 | 原因 |", "| --- | --- | --- | --- |");
        for (const field of entry.fields)
          lines.push(
            `| ${field.line} | ${field.component} · ${field.field.replaceAll("|", "\\|").replaceAll("\n", " ")} | ${field.status} | ${field.reason} |`,
          );
        lines.push("");
      }
    }
    writeFileSync(
      resolve(root, "docs/ui/migration-inventory.md"),
      `${lines.join("\n").trimEnd()}\n`,
    );
  }
  console.log(
    `遍历 ${inventory.length} 个业务组件/路由，${inventory.reduce((count, entry) => count + entry.fields.length, 0)} 个控件；${violations.length} 个容器违规。`,
  );
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  }
}

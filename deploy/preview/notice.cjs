const { positiveInteger } = require("./gate.cjs");
const MARKER = "<!-- kq-k3s-preview -->";

async function notice({ github, context, core }, state, prValue, sha) {
  const pr = positiveInteger(prValue, "PR");
  const url = `https://pr-${pr}.preview.dev.kuintessence.com`;
  const inspection = state === "inspection" || state === "inspection-failed";
  const body = state === "success"
    ? `${MARKER}\n### Kuintessence PR Preview\n\n地址：${url}\n\n部署版本：\`${sha}\`\n\nHTTPS 和入口认证检查已通过。入口账号与口令由维护者私下提供（\`PREVIEW_USER\` / \`PREVIEW_PASSWORD\`），所有 PR 使用同一组固定凭据。仅使用演示数据。\n\n关闭 PR、转为草稿、添加 \`preview-paused\` 或移除 \`TRUST_PR_CREATOR\` 将清理环境及预览数据。`
    : inspection
      ? `${MARKER}\n### Kuintessence PR Preview\n\n待人工检查地址：${url}\n\n部署版本：\`${sha}\`\n\n${state === "inspection" ? "Helm 部署及 readiness 等待已完成。" : "Helm 部署失败或超时，保留现场供排查。"}HTTPS 和入口认证尚未验收，不能视为上线成功。\n\n环境位于 \`preview\` namespace，release 为 \`kq-pr-${pr}\`。资源及本次镜像 tag 保留，不因部署或 HTTPS 失败自动清理。入口账号与口令由维护者私下提供（\`PREVIEW_USER\` / \`PREVIEW_PASSWORD\`），所有 PR 使用同一组固定凭据。\n\n关闭 PR、转为草稿、添加 \`preview-paused\` 或移除 \`TRUST_PR_CREATOR\` 仍会触发安全撤销清理；检查期间请勿修改这些状态。`
      : `${MARKER}\n### Kuintessence PR Preview\n\n环境已清理，${url} 当前不可用。\n\n重新满足信任与测试门禁后可再次部署。`;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo, issue_number: pr, per_page: 100,
  });
  const previous = comments.find((comment) =>
    comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(MARKER));
  if (previous) {
    await github.rest.issues.updateComment({ ...context.repo, comment_id: previous.id, body });
  } else {
    await github.rest.issues.createComment({ ...context.repo, issue_number: pr, body });
  }
  if (state !== "success" && !inspection) {
    const deployments = await github.paginate(github.rest.repos.listDeployments, {
      ...context.repo, environment: `pr-${pr}`, per_page: 100,
    });
    for (const deployment of deployments) {
      await github.rest.repos.createDeploymentStatus({
        ...context.repo, deployment_id: deployment.id, state: "inactive",
        description: "Preview namespace removed",
      });
    }
  }
  await core.summary.addHeading(`PR #${pr} preview`).addRaw(
    inspection ? `${url}\n\nResources retained for manual inspection; HTTPS is unverified.` :
      state === "success" ? `${url}\n\nRevision: ${sha}` : "Preview removed.",
  ).write();
}

module.exports = { notice };

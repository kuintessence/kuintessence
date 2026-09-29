const { positiveInteger } = require("./gate.cjs");
const MARKER = "<!-- kq-k3s-preview -->";

async function notice({ github, context, core }, state, prValue, sha) {
  const pr = positiveInteger(prValue, "PR");
  const url = `https://pr-${pr}.preview.dev.kuintessence.com`;
  const body = state === "success"
    ? `${MARKER}\n### Kuintessence PR Preview\n\n地址：${url}\n\n部署版本：\`${sha}\`\n\nHTTPS 和入口认证检查已通过。入口用户为 \`preview\`，口令由维护者私下提供。仅使用演示数据。\n\n关闭 PR、转为草稿、添加 \`preview-paused\` 或移除 \`TRUST_PR_CREATOR\` 将清理环境及预览数据。`
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
  if (state !== "success") {
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
    state === "success" ? `${url}\n\nRevision: ${sha}` : "Preview removed.",
  ).write();
}

module.exports = { notice };

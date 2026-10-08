const { describe, expect, test } = require("bun:test");
const { notice } = require("./notice.cjs");

const MARKER = "<!-- kq-k3s-preview -->";
const sha = "a".repeat(40);
const url = "https://pr-17.preview.dev.kuintessence.com";

function fixture(comments = []) {
  const calls = [];
  const summary = [];
  const context = { repo: { owner: "example", repo: "project" } };
  const github = {
    rest: {
      issues: {
        listComments: "comments",
        createComment: async (options) => { calls.push(["create", options]); },
        updateComment: async (options) => { calls.push(["update", options]); },
      },
      repos: {
        listDeployments: "deployments",
        createDeploymentStatus: async (options) => { calls.push(["status", options]); },
      },
    },
    paginate: async (method, options) => {
      calls.push([method, options]);
      if (method === "comments") return comments;
      if (method === "deployments") return [{ id: 101 }, { id: 102 }];
      throw new Error(`Unexpected pagination method: ${method}`);
    },
  };
  const core = { summary: {
    addHeading(value) { summary.push(["heading", value]); return this; },
    addRaw(value) { summary.push(["raw", value]); return this; },
    async write() { summary.push(["write"]); },
  } };
  return { github, context, core, calls, summary };
}

describe("preview notices", () => {
  test.each(["inspection", "inspection-failed"])(
    "%s publishes an explicitly unverified URL without marking deployments inactive",
    async (state) => {
      const f = fixture();
      await notice(f, state, "17", sha);
      expect(f.calls.map(([kind]) => kind)).toEqual(["comments", "create"]);
      expect(f.calls[0][1]).toEqual({
        ...f.context.repo, issue_number: 17, per_page: 100,
      });
      const posted = f.calls[1][1];
      expect(posted).toMatchObject({ ...f.context.repo, issue_number: 17 });
      expect(posted.body.startsWith(MARKER)).toBe(true);
      expect(posted.body).toContain(`待人工检查地址：${url}`);
      expect(posted.body).toContain(`部署版本：\`${sha}\``);
      expect(posted.body).toContain("HTTPS 和入口认证尚未验收，不能视为上线成功");
      expect(posted.body).not.toContain("HTTPS 和入口认证检查已通过");
      expect(posted.body).toContain("`PREVIEW_USER` / `PREVIEW_PASSWORD`");
      expect(posted.body).not.toContain("入口用户为 `preview`");
      expect(posted.body).not.toContain("环境已清理");
      expect(posted.body).toContain("资源及本次镜像 tag 保留");
      expect(posted.body).toContain("不因部署或 HTTPS 失败自动清理");
      expect(posted.body).toContain("`preview` namespace");
      expect(posted.body).toContain("`kq-pr-17`");
      expect(posted.body).toContain("关闭 PR、转为草稿、添加 `preview-paused` 或移除 `TRUST_PR_CREATOR`");
      expect(posted.body).toContain("仍会触发安全撤销清理");
      if (state === "inspection") {
        expect(posted.body).toContain("Helm 部署及 readiness 等待已完成");
        expect(posted.body).not.toContain("Helm 部署失败或超时");
      } else {
        expect(posted.body).toContain("Helm 部署失败或超时，保留现场供排查");
        expect(posted.body).not.toContain("readiness 等待已完成");
      }
      expect(f.summary).toEqual([
        ["heading", "PR #17 preview"],
        ["raw", `${url}\n\nResources retained for manual inspection; HTTPS is unverified.`],
        ["write"],
      ]);
    },
  );

  test.each(["inspection", "inspection-failed"])(
    "%s replaces the existing bot notice rather than leaving stale success copy",
    async (state) => {
      const f = fixture([
        { id: 1, user: { login: "member" }, body: `${MARKER}\nHuman comment` },
        { id: 2, user: { login: "github-actions[bot]" }, body: "Unrelated bot comment" },
        { id: 3, user: { login: "github-actions[bot]" }, body: `${MARKER}\nHTTPS 和入口认证检查已通过。` },
      ]);
      await notice(f, state, 17, sha);
      expect(f.calls.map(([kind]) => kind)).toEqual(["comments", "update"]);
      expect(f.calls[1][1]).toMatchObject({ ...f.context.repo, comment_id: 3 });
      expect(f.calls[1][1].body).toContain(`待人工检查地址：${url}`);
      expect(f.calls[1][1].body).not.toContain("HTTPS 和入口认证检查已通过");
    },
  );

  test("automatic success retains its verified URL and never deactivates deployments", async () => {
    const f = fixture();
    await notice(f, "success", "17", sha);
    expect(f.calls.map(([kind]) => kind)).toEqual(["comments", "create"]);
    expect(f.calls[1][1].body).toContain(`地址：${url}`);
    expect(f.calls[1][1].body).toContain(`部署版本：\`${sha}\``);
    expect(f.calls[1][1].body).toContain("HTTPS 和入口认证检查已通过");
    expect(f.calls[1][1].body).toContain("`PREVIEW_USER` / `PREVIEW_PASSWORD`");
    expect(f.calls[1][1].body).not.toContain("入口用户为 `preview`");
    expect(f.calls[1][1].body).not.toContain("待人工检查地址");
    expect(f.summary).toEqual([
      ["heading", "PR #17 preview"], ["raw", `${url}\n\nRevision: ${sha}`], ["write"],
    ]);
  });

  test("explicit cleanup replaces inspection copy and marks every PR deployment inactive", async () => {
    const f = fixture([
      { id: 3, user: { login: "github-actions[bot]" }, body: `${MARKER}\n待人工检查地址：${url}` },
    ]);
    await notice(f, "inactive", "17");
    expect(f.calls.map(([kind]) => kind)).toEqual([
      "comments", "update", "deployments", "status", "status",
    ]);
    expect(f.calls[1][1]).toMatchObject({ ...f.context.repo, comment_id: 3 });
    expect(f.calls[1][1].body).toContain(`环境已清理，${url} 当前不可用`);
    expect(f.calls[1][1].body).not.toContain("待人工检查地址");
    expect(f.calls[2][1]).toEqual({
      ...f.context.repo, environment: "pr-17", per_page: 100,
    });
    expect(f.calls.slice(3)).toEqual([101, 102].map((id) => ["status", {
      ...f.context.repo, deployment_id: id, state: "inactive",
      description: "Preview namespace removed",
    }]));
    expect(f.summary).toEqual([
      ["heading", "PR #17 preview"], ["raw", "Preview removed."], ["write"],
    ]);
  });

  test.each(["0", "-1", "../17", "17\n18", "00017", "17;exit"])(
    "rejects invalid PR %s before touching comments, deployments or the summary",
    async (pr) => {
      const f = fixture();
      await expect(notice(f, "inspection", pr, sha)).rejects.toThrow("Invalid PR");
      expect(f.calls).toEqual([]);
      expect(f.summary).toEqual([]);
    },
  );
});

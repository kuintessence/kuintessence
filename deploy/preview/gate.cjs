const TRUST_LABEL = "TRUST_PR_CREATOR";
const WORKFLOW_PATH = ".github/workflows/preview-tests.yml";
const SHA = /^[a-f0-9]{40}$/;
const REQUIRED_JOBS = [
  "resolve",
  "ci / Static checks",
  "ci / Full typecheck + Helm validation",
  "ci / Spack artifact imports (hello) / export-and-import",
  "ci / Spack artifact imports (samtools) / export-and-import",
  "ci / Unit + integration tests",
  "ci / E2E slice (CLI -> Server -> Agent -> Slurm)",
  "ci / RustFS Compose + AIO",
  "ci / Spack lifecycle portal",
  "ci / Spack HTTP and SOCKS online imports",
  "schedulers / Spack GNU Hello managed installation",
  "schedulers / Spack samtools managed installation",
  "schedulers / Spack GNU Hello artifact bootstrap managed installation",
  "schedulers / Spack samtools artifact bootstrap managed installation",
  "schedulers / Spack GNU Hello Web import managed installation",
  "schedulers / Spack samtools Web import managed installation",
  "schedulers / Spack GNU Hello single-step case",
  "schedulers / Scheduler (slurm)",
  "schedulers / Scheduler (pbs)",
  "workflows / contracts",
  "workflows / Managed workflow (hello)",
  "workflows / Managed workflow (samtools)",
  "workflows / Managed workflow (samtools-file)",
  "all-required-tests",
];

function positiveInteger(value, field) {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]{0,14}$/.test(text)) throw new Error(`Invalid ${field}`);
  return Number(text);
}

function eligible(pr, repository, permission, defaultBranch = "main") {
  return (
    pr.state === "open" &&
    !pr.draft &&
    pr.base?.ref === defaultBranch &&
    pr.head?.repo?.full_name === repository &&
    SHA.test(pr.head?.sha ?? "") &&
    ["admin", "maintain", "write"].includes(permission) &&
    pr.labels.some((label) => label.name === TRUST_LABEL) &&
    !pr.labels.some((label) => label.name === "preview-paused")
  );
}

function testsPassed(jobs) {
  return (
    REQUIRED_JOBS.every((name) => jobs.filter((job) => job.name === name).length === 1) &&
    jobs.every((job) =>
      job.status === "completed" &&
      (job.conclusion === "success" ||
        (job.name === "ci / Generate database migrations" && job.conclusion === "skipped")),
    )
  );
}

async function getPermission(github, repo, username) {
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
      ...repo,
      username,
    });
    return data.permission;
  } catch (error) {
    if (error.status === 404) return "none";
    throw error;
  }
}

async function gate({ github, context, core }, options = {}) {
  core.setOutput("allowed", "false");
  const repo = context.repo;
  const repository = `${repo.owner}/${repo.repo}`;
  const inputs = context.payload.inputs ?? {};
  const runId = positiveInteger(
    options.runId ?? inputs.test_run_id ?? context.payload.workflow_run?.id,
    "test run",
  );
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: runId });
  if (
    run.path !== WORKFLOW_PATH ||
    !["pull_request", "workflow_dispatch"].includes(run.event) ||
    run.head_repository?.full_name !== repository ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    core.info("Preview refused: the full test run is not eligible.");
    return;
  }
  let candidateNumber = options.pr ?? inputs.pr_number ?? run.pull_requests?.[0]?.number;
  if (!candidateNumber && run.event === "workflow_dispatch") {
    const candidates = await github.paginate(github.rest.pulls.list, {
      ...repo,
      state: "open",
      head: `${repo.owner}:${run.head_branch}`,
      per_page: 100,
    });
    const matches = candidates.filter((pr) => pr.head.sha === run.head_sha);
    if (matches.length !== 1) {
      core.info("Preview refused: test run does not identify a unique open PR.");
      return;
    }
    candidateNumber = matches[0].number;
  }
  const prNumber = positiveInteger(candidateNumber, "PR number");
  if (
    run.event === "pull_request" &&
    !run.pull_requests.some((pr) => pr.number === prNumber)
  ) {
    core.info("Preview refused: test run belongs to a different PR.");
    return;
  }
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  const permission = await getPermission(github, repo, pr.user.login);
  const defaultBranch = context.payload.repository.default_branch;
  if (!eligible(pr, repository, permission, defaultBranch) || pr.head.sha !== run.head_sha) {
    core.info("Preview refused: trust, membership, state or tested revision changed.");
    return;
  }
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo,
    run_id: runId,
    filter: "latest",
    per_page: 100,
  });
  if (!testsPassed(jobs)) {
    core.info("Preview refused: a required test suite is missing, skipped or unsuccessful.");
    return;
  }
  // An earlier green run cannot supersede a newer failed or unfinished attempt.
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...repo,
    workflow_id: "preview-tests.yml",
    head_sha: pr.head.sha,
    per_page: 100,
  });
  for (const candidate of runs) {
    if (
      candidate.id <= run.id ||
      candidate.head_repository?.full_name !== repository ||
      !["pull_request", "workflow_dispatch"].includes(candidate.event)
    ) continue;
    if (candidate.event === "pull_request" &&
        candidate.display_title === "PR preview tests (ignored label event)") {
      const ignoredJobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        ...repo, run_id: candidate.id, filter: "latest", per_page: 100,
      });
      // A fixed workflow-generated marker is not enough if any test actually ran.
      if (ignoredJobs.every((job) =>
        job.conclusion === "skipped" ||
        (job.status === "queued" && !job.started_at && !job.conclusion),
      )) continue;
    }
    core.info("Preview refused: a newer test run exists for this revision.");
    return;
  }
  core.setOutput("allowed", "true");
  core.setOutput("pr", String(prNumber));
  core.setOutput("sha", pr.head.sha);
  core.setOutput("owner", repo.owner.toLowerCase());
  core.setOutput("run", String(runId));
  core.setOutput("url", `https://pr-${prNumber}.preview.dev.kuintessence.com`);
}

async function cleanupGate({ github, context, core }) {
  core.setOutput("allowed", "false");
  const prNumber = positiveInteger(
    context.payload.inputs?.pr_number ?? context.payload.pull_request?.number,
    "PR number",
  );
  const { data: pr } = await github.rest.pulls.get({
    ...context.repo,
    pull_number: prNumber,
  });
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (pr.head.repo?.full_name !== repository) return;
  const permission = await getPermission(github, context.repo, pr.user.login);
  if (eligible(pr, repository, permission, context.payload.repository.default_branch)) {
    core.info("PR is still eligible; ignoring stale cleanup request.");
    return;
  }
  core.setOutput("allowed", "true");
  core.setOutput("pr", String(prNumber));
}

module.exports = { gate, cleanupGate, eligible, positiveInteger, testsPassed, REQUIRED_JOBS };

const fs = require("node:fs");
const { positiveInteger } = require("./gate.cjs");
const { validateImages } = require("./images.cjs");

function publicationName(run, attempt) {
  return `kq-preview-publication-test-${positiveInteger(run, "test run")}-${positiveInteger(attempt, "test attempt")}`;
}

async function findPublication({ github, context, core }, { testRun, testAttempt }) {
  const name = publicationName(testRun, testAttempt);
  const artifacts = await github.paginate(github.rest.actions.listArtifactsForRepo, {
    ...context.repo, name, per_page: 100,
  });
  for (const artifact of artifacts) {
    if (artifact.name !== name || artifact.expired || !artifact.workflow_run?.id) continue;
    const { data: run } = await github.rest.actions.getWorkflowRun({
      ...context.repo, run_id: artifact.workflow_run.id,
    });
    // Only the default-branch controller may hand over a privileged publication.
    if (run.path !== ".github/workflows/preview.yml" || run.event !== "workflow_run" ||
        run.head_sha !== context.sha || run.head_branch !== context.payload.repository.default_branch ||
        run.head_repository?.full_name !== `${context.repo.owner}/${context.repo.repo}` ||
        run.status !== "completed" || run.conclusion !== "success") continue;
    core.setOutput("reuse_run", String(positiveInteger(run.id, "publish run")));
    core.setOutput("reuse_name", name);
    return;
  }
}

function handoff(source, target, env = process.env) {
  if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  publicationName(env.TEST_RUN_ID, env.TEST_ATTEMPT);
  const reused = Boolean(env.REUSE_RUN);
  const input = JSON.parse(fs.readFileSync(source, "utf8"));
  const run = reused ? input.publishRun : env.PREVIEW_RUN;
  const attempt = reused ? input.publishAttempt : env.PREVIEW_ATTEMPT;
  if (reused && (input.version !== 1 || String(input.testRun) !== env.TEST_RUN_ID ||
      String(input.testAttempt) !== env.TEST_ATTEMPT || input.toolingSha !== env.TOOLING_SHA ||
      String(run) !== env.REUSE_RUN)) throw new Error("Publication does not match this controller and test attempt");
  const images = validateImages(reused ? input.images : input, env.IMAGE_OWNER, env.PREVIEW_SHA, {
    pr: env.PREVIEW_PR, run, attempt,
  });
  const publication = {
    version: 1, testRun: env.TEST_RUN_ID, testAttempt: env.TEST_ATTEMPT,
    toolingSha: env.TOOLING_SHA, publishRun: String(run), publishAttempt: String(attempt), images,
  };
  fs.writeFileSync(target, JSON.stringify(images), { mode: 0o600 });
  fs.writeFileSync(`${target}.publication`, JSON.stringify(publication), { mode: 0o600 });
  fs.appendFileSync(env.GITHUB_OUTPUT, `run=${run}\nattempt=${attempt}\n`);
  return publication;
}

if (require.main === module) {
  try { handoff(...process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { publicationName, findPublication, handoff };

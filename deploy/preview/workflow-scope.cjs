const SHA = /^[a-f0-9]{40}$/;

async function workflowScope(github, repo, pr, { event, spack }) {
  if (!["pull_request", "workflow_dispatch"].includes(event) ||
      typeof spack !== "boolean" || !Number.isSafeInteger(pr?.number) || pr.number < 1 ||
      typeof pr.head?.sha !== "string" || !SHA.test(pr.head.sha)) {
    throw new Error("Invalid workflow scope request.");
  }
  if (event === "workflow_dispatch") return "full";
  // PR events have no reliable head_commit message; query the exact tested SHA.
  const { data: commit } = await github.rest.repos.getCommit({ ...repo, ref: pr.head.sha });
  if (commit?.sha !== pr.head.sha || typeof commit.commit?.message !== "string") {
    throw new Error("Unable to verify the tested commit message.");
  }
  const { data: current } = await github.rest.pulls.get({ ...repo, pull_number: pr.number });
  if (current?.head?.sha !== pr.head.sha || current?.base?.sha !== pr.base?.sha) {
    throw new Error("PR changed while resolving workflow scope.");
  }
  return commit.commit.message.includes("[full-workflows]") ? "full" : spack ? "quick" : "none";
}

module.exports = { workflowScope };

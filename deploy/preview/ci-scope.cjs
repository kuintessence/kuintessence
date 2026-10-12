const BOTH = { spack: true, schedulers: true };
const JOB_SCOPES = {
  "generate-db-migrations": [],
  "static-checks": [],
  "lint-and-typecheck": [],
  test: [],
  "rustfs-deployments": [],
  "spack-artifact-imports": ["spack"],
  "spack-lifecycle-portal": ["spack"],
  "spack-upstream": ["spack"],
  "e2e-slice": ["schedulers"],
};

// Only split the repository's canonical block layout. Unfamiliar YAML stays conservative;
// no parser dependency or execution of PR code is needed by the privileged preview gate.
function sections(source) {
  if (typeof source !== "string" || /\t|\r|(?:^|\s)[&*][A-Za-z_]|![A-Za-z_][\w-]*(?=\s)/m.test(source)) return null;
  const lines = source.split("\n");
  const start = lines.indexOf("jobs:");
  if (start < 0 || lines.lastIndexOf("jobs:") !== start) return null;
  const jobs = new Map();
  let current;
  for (const line of lines.slice(start + 1)) {
    const match = /^  ([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (match) {
      current = match[1];
      if (jobs.has(current)) return null;
      jobs.set(current, []);
    } else if (line.trim() && !line.trimStart().startsWith("#") &&
        (!current || !line.startsWith("    "))) {
      return null;
    } else if (current) {
      jobs.get(current).push(line);
    }
  }
  if (!jobs.size) return null;
  return { global: lines.slice(0, start).join("\n"), jobs };
}

function classifyCIChange(base, head) {
  const before = sections(base);
  const after = sections(head);
  if (!before || !after || before.global !== after.global) return { ...BOTH };
  const scope = { spack: false, schedulers: false };
  for (const name of new Set([...before.jobs.keys(), ...after.jobs.keys()])) {
    const oldJob = before.jobs.get(name)?.join("\n");
    const newJob = after.jobs.get(name)?.join("\n");
    if (oldJob === newJob) continue;
    // Added/removed jobs and outputs can change dependencies of other jobs.
    if (oldJob === undefined || newJob === undefined ||
        !Object.hasOwn(JOB_SCOPES, name) || /^    outputs:/m.test(`${oldJob}\n${newJob}`)) {
      return { ...BOTH };
    }
    for (const group of JOB_SCOPES[name]) scope[group] = true;
  }
  return scope;
}

module.exports = { classifyCIChange };

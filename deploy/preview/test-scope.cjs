const MAX_FILES = 3000;
const SHA = /^[a-f0-9]{40}$/;

const IGNORED = [
  /^(?:docs|plan|plans)\//,
  /(?:^|\/)README(?:[.-][^/]*)?$/i,
  /^deploy\/(?:preview|helm)\//,
  /^\.github\/workflows\/(?:preview|preview-tests|preview-cleanup)\.ya?ml$/,
];

const SHARED = [
  /^\.github\/workflows\/ci\.ya?ml$/,
  /^packages\/cli\/src\/(?:index\.|agent-serve\/|commands\/(?:agent|config|login|dsl|workflow)(?:[./])|lib\/(?:api-client|config|oidc-browser-flow|sse-client|local-scheduler)(?:[./]))/,
  /(?:^|\/)(?:package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /^(?:tsconfig(?:\.[^/]+)?\.json|bunfig\.toml|\.npmrc|\.dockerignore)$/,
  /^packages\/(?:shared|db|proto)\//,
  /^packages\/(?:agent|server|registry)\/(?:tsconfig[^/]*\.json|bunfig\.toml)$/,
  /^packages\/agent\/src\/(?:stream|config)(?:[-./])/,
  /^packages\/agent\/src\/sandbox\//,
  /^packages\/server\/src\/(?:index|config)(?:\.|\/)/,
  /^packages\/server\/src\/(?:workflow|grpc)\//,
  /^packages\/server\/src\/services\/(?:workflow|placement)(?:[-./])/,
  /^packages\/server\/src\/routes\/(?:workflows|dsl)(?:[-./])/,
  /^deploy\/pr-test\/(?:run\.sh|runtime\.ts|health\.sh|tsconfig\.json|workspace\.Dockerfile(?:\.dockerignore)?)$/,
  /^deploy\/compose\/docker-compose\.pr-test\.ya?ml$/,
  /^deploy\/schedulers\/(?:base|common|slurm)\//,
  /^deploy\/(?:dev|base|common)\//,
  /^(?:Dockerfile(?:[.-][^/]*)?|docker\/.*)$/,
  /^packages\/[^/]+\/Dockerfile(?:[.-][^/]*)?$/,
  /^\.github\/workflows\/pr-scheduler-tests\.ya?ml$/,
];

const SPACK = [
  /^packages\/cli\/src\/(?:commands\/software|lib\/local-spack)(?:[./])/,
  /^packages\/agent\/src\/spack\//,
  /^packages\/agent\/test\/(?:fixtures|integration)\/spack[.-]/,
  /^packages\/registry\/src\//,
  /^packages\/server\/src\/software-governance\//,
  /^packages\/server\/src\/services\/(?:software|usecase|license-runtime)(?:[-./])/,
  /^packages\/server\/src\/routes\/(?:software|agent-spack)(?:[-./])/,
  /^packages\/web\/src\/(?:components\/(?:software|material|recipe|spack|workflow)[^/]*\/|routes\/[^/]*(?:software|material|recipe|spack|workflow)|lib\/(?:use-cp-software|software|material|recipe|spack|workflow)[-./])/,
  /^packages\/web\/src\/components\/cp\/SoftwarePolicyTable(?:\.[^/]+)$/,
  /^packages\/web\/src\/(?:main|routeTree\.gen)(?:\.[^/]+)$/,
  /^packages\/web\/src\/routes\/-?(?:__root|login)(?:\.[^/]+)$/,
  /^packages\/web\/src\/components\/(?:AppShell|ProtectedRoute|GlobalErrorPage|ThemeProvider)(?:\.[^/]+)$/,
  /^packages\/web\/src\/lib\/(?:auth|auth-redirect|authenticated-fetch|api-client|query-client|local-mode|active-organization|platform-capabilities|platform-paths|mobile-management-policy|i18n|monaco-env)(?:\.[^/]+)$/,
  /^packages\/web\/src\/lib\/api-schemas\//,
  /^packages\/web\/src\/locales\/(?:software|materials?|recipes?|spack|workflow)[.-]/,
  /^packages\/web\/e2e\/(?:fixtures\/)?(?:software|material|recipe|spack|workflows?)[-./]/,
  /^packages\/web\/e2e\/cp-spack-install(?:\.[^/]+)$/,
  /^packages\/web\/(?:index\.html|nginx\.conf|tsconfig[^/]*\.json|bunfig\.toml|\.env(?:\.[^/]+)?|(?:vite\.config|playwright\.config)\.[^/]+)$/,
  /^scripts\/(?:spack|recipe|generate-spack)[^/]*$/,
  /^deploy\/pr-test\/spack-[^/]+(?:\/|$)/,
  /^deploy\/compose\/docker-compose\.pr-spack-[^/]+\.ya?ml$/,
  /^\.github\/workflows\/spack-[^/]+\.ya?ml$/,
];

const SCHEDULERS = [
  /^packages\/cli\/src\/commands\/(?:submit|cancel|list|status|logs|ssh)(?:[./])/,
  /^packages\/agent\/src\/(?:adapters|executor)\//,
  /^packages\/agent\/src\/executor(?:[-./])/,
  /^packages\/server\/src\/(?:scheduler|jobs)\//,
  /^packages\/server\/src\/routes\/(?:scheduler|jobs|queues)(?:[-./])/,
  /^packages\/server\/src\/services\/(?:job|queue|sandbox|agent)(?:[-./])/,
  /^test\/e2e\//,
  /^scripts\/pr-scheduler[^/]*$/,
  /^deploy\/pr-test\/(?:check\.sh|scheduler[^/]*|configs?\/.*)$/,
  /^deploy\/schedulers\//,
  /^deploy\/compose\/docker-compose\.schedulers\.ya?ml$/,
  /^\.github\/workflows\/scheduler-image-architecture\.ya?ml$/,
];

function matches(patterns, path) {
  return patterns.some((pattern) => pattern.test(path));
}

function validPath(path) {
  return typeof path === "string" && path.length > 0 &&
    !/[\x00-\x1f\x7f\\]/.test(path) && !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function classifyPaths(files) {
  if (!Array.isArray(files)) throw new Error("Invalid PR file list.");
  const scope = { spack: false, schedulers: false };
  const seen = new Set();
  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file) ||
        !validPath(file.filename) || seen.has(file.filename) ||
        (file.previous_filename !== undefined && !validPath(file.previous_filename)) ||
        (file.status === "renamed" && file.previous_filename === undefined)) {
      throw new Error("Invalid or duplicate PR file path.");
    }
    seen.add(file.filename);
    // Match both sides of a rename; deletions still carry their original filename.
    const paths = [file.filename];
    if (file.previous_filename !== undefined) paths.push(file.previous_filename);
    for (const path of paths) {
      if (matches(IGNORED, path)) continue;
      if (matches(SHARED, path)) {
        scope.spack = true;
        scope.schedulers = true;
        continue;
      }
      const spack = matches(SPACK, path);
      const schedulers = matches(SCHEDULERS, path);
      // Unknown Agent runtime files can be shared by both execution paths.
      const sharedAgent = path.startsWith("packages/agent/src/") && !spack && !schedulers;
      scope.spack ||= spack || sharedAgent;
      scope.schedulers ||= schedulers || sharedAgent;
    }
  }
  return scope;
}

function snapshot(pr) {
  if (!pr || !Number.isSafeInteger(pr.number) || pr.number < 1 ||
      typeof pr.head?.sha !== "string" || pr.head.sha.length !== 40 || !SHA.test(pr.head.sha) ||
      typeof pr.base?.sha !== "string" || pr.base.sha.length !== 40 || !SHA.test(pr.base.sha) ||
      !Number.isSafeInteger(pr.changed_files) || pr.changed_files < 0) {
    throw new Error("Invalid PR scope snapshot.");
  }
  if (pr.changed_files > MAX_FILES) {
    throw new Error("PR file list exceeds the 3000-file API limit.");
  }
  return {
    number: pr.number, head: pr.head.sha, base: pr.base.sha, count: pr.changed_files,
  };
}

async function pullRequestScope(github, repo, pr) {
  const before = snapshot(pr);
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...repo, pull_number: before.number, per_page: 100,
  });
  if (!Array.isArray(files) || files.length > MAX_FILES || files.length !== before.count) {
    throw new Error("Incomplete PR file list.");
  }
  const scope = classifyPaths(files);
  const { data } = await github.rest.pulls.get({ ...repo, pull_number: before.number });
  const after = snapshot(data);
  if (after.number !== before.number || after.head !== before.head ||
      after.base !== before.base || after.count !== before.count) {
    throw new Error("PR changed while resolving test scope.");
  }
  return scope;
}

module.exports = { classifyPaths, pullRequestScope };

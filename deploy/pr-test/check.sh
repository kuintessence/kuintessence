#!/usr/bin/env bash
set -euo pipefail

[[ "${KQ_PR_TEST:-}" == "1" ]] || { echo "PR test container only" >&2; exit 2; }
cd /workspace
test "$(spack --version)" = "1.0.0"
test "$(bun --version)" = "1.3.13"
bun node_modules/typescript/bin/tsc --project deploy/pr-test/tsconfig.json
bun deploy/pr-test/runtime.ts

# These are in-process regressions, not real offline Spack installation acceptance.
bun test \
  scripts/pr-scheduler-compose.test.ts \
  packages/shared/src/spack-lock.test.ts \
  packages/shared/src/spack-materials.test.ts \
  packages/shared/src/spack-material-import.test.ts \
  packages/shared/src/spack-material-catalog.test.ts \
  packages/registry/src/services/recipe-git-store.test.ts \
  packages/registry/src/services/recipe-diagnostics.test.ts \
  packages/registry/src/services/material-bootstrap.test.ts \
  packages/registry/src/routes/spack-materials.test.ts \
  packages/registry/src/routes/spack-material-catalog.test.ts \
  packages/agent/src/spack/material-client.test.ts \
  packages/agent/src/spack/material-preflight.test.ts \
  packages/agent/src/spack/managed.test.ts \
  packages/server/src/software-governance/spack-material-delivery.test.ts \
  packages/server/src/software-governance/spack-operation-gate.test.ts

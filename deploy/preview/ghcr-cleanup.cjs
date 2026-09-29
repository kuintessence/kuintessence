const { COMPONENTS, matchesPRTag } = require("./images.cjs");

const PACKAGES = Object.freeze(COMPONENTS.map((component) => `kq-dev-${component}`));
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const INCOMPLETE = "Preview image cleanup incomplete; inspect the fixed cleanup markers.";

function cleanupScope(context, options) {
  const { owner, repo } = context?.repo ?? {};
  const type = context?.payload?.repository?.owner?.type;
  const pr = String(options?.pr ?? "");
  const tag = options?.tag;
  if (
    typeof owner !== "string" ||
    owner.trim() !== owner ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) ||
    typeof repo !== "string" ||
    repo.trim() !== repo ||
    !/^[A-Za-z0-9_.-]+$/.test(repo) ||
    repo === "." || repo === ".." ||
    !["Organization", "User"].includes(type) ||
    !["string", "number"].includes(typeof options?.pr) ||
    !/^[1-9][0-9]{0,14}$/.test(pr) ||
    pr.trim() !== pr ||
    (tag !== undefined && !matchesPRTag(tag, pr))
  ) {
    throw new Error("Invalid preview image cleanup scope.");
  }
  const organization = type === "Organization";
  return {
    pr,
    tag,
    repository: `${owner}/${repo}`,
    path: organization
      ? "/orgs/{org}/packages/{package_type}/{package_name}"
      : "/users/{username}/packages/{package_type}/{package_name}",
    parameters: {
      ...(organization ? { org: owner } : { username: owner }),
      package_type: "container",
      headers: {
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  };
}

async function absentOn404(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.status === 404) return undefined;
    throw error;
  }
}

function versionSnapshot(value) {
  const tags = value?.metadata?.container?.tags;
  if (
    !Number.isSafeInteger(value?.id) || value.id <= 0 ||
    typeof value?.name !== "string" ||
    !DIGEST.test(value.name) || value.name.length !== 71 ||
    value?.metadata?.package_type !== "container" ||
    !Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")
  ) {
    return undefined;
  }
  return { id: value.id, digest: value.name, tags: [...tags].sort() };
}

function targeted(tags, scope) {
  return tags.some((tag) => scope.tag === undefined ? matchesPRTag(tag, scope.pr) : tag === scope.tag);
}

function exclusivelyOwned(tags, scope) {
  return tags.length > 0 && tags.every(
    (tag) => scope.tag === undefined ? matchesPRTag(tag, scope.pr) : tag === scope.tag,
  );
}

function unchanged(before, after) {
  return after &&
    before.id === after.id &&
    before.digest === after.digest &&
    before.tags.length === after.tags.length &&
    before.tags.every((tag, index) => tag === after.tags[index]);
}

async function cleanupVersion(github, scope, parameters, snapshot) {
  const path = `${scope.path}/versions/{package_version_id}`;
  const versionParameters = { ...parameters, package_version_id: snapshot.id };
  const response = await absentOn404(() => github.request(`GET ${path}`, versionParameters));
  if (!response) return "absent";
  const current = versionSnapshot(response.data);
  if (!unchanged(snapshot, current) || !exclusivelyOwned(current.tags, scope)) {
    return "changed";
  }
  // Unique per-publication tags and image labels isolate concurrent attempts.
  // Without conditional DELETE, operators must not change aliases between this GET and DELETE.
  const deleted = await absentOn404(() => github.request(`DELETE ${path}`, versionParameters));
  if (!deleted) return "absent";
  if (deleted.status !== 204) throw new Error("Unexpected version deletion response");
  return "deleted";
}

async function cleanupPackage(github, scope, packageName, result, report) {
  const parameters = { ...scope.parameters, package_name: packageName };
  const response = await absentOn404(() => github.request(`GET ${scope.path}`, parameters));
  if (!response) {
    result.absent++;
    return;
  }
  const pkg = response.data;
  if (
    pkg?.name !== packageName ||
    pkg.package_type !== "container" ||
    pkg.repository?.full_name !== scope.repository
  ) {
    report(packageName, "PACKAGE_OWNERSHIP_MISMATCH");
    return;
  }
  // Finish pagination before deleting: mutating pages mid-enumeration can skip versions.
  const versions = await absentOn404(() => github.paginate(`GET ${scope.path}/versions`, {
    ...parameters, state: "active", per_page: 100,
  }));
  if (!versions) {
    result.absent++;
    return;
  }
  if (!Array.isArray(versions)) throw new Error("Invalid version listing");
  for (const version of versions) {
    const snapshot = versionSnapshot(version);
    if (!snapshot) {
      report(packageName, "VERSION_INVALID");
      continue;
    }
    if (!targeted(snapshot.tags, scope)) {
      result.retained++;
      continue;
    }
    if (!exclusivelyOwned(snapshot.tags, scope)) {
      report(packageName, "VERSION_SHARED_OR_UNRECOGNIZED");
      continue;
    }
    try {
      const status = await cleanupVersion(github, scope, parameters, snapshot);
      if (status === "changed") report(packageName, "VERSION_CHANGED");
      else result[status]++;
    } catch {
      report(packageName, "VERSION_API_FAILED");
    }
  }
}

// Requires packages:write and package admin access, after successful namespace deletion.
// The only exception is exact-tag revocation cleanup of the current publish attempt
// that has never been handed off to k3s.
async function cleanupImages({ github, context, core }, options) {
  const scope = cleanupScope(context, options);
  const result = { deleted: 0, absent: 0, retained: 0, failed: 0 };
  const report = (packageName, code) => {
    result.failed++;
    core.warning(`KQ_PREVIEW_GHCR_CLEANUP package=${packageName} code=${code}`);
  };
  for (const packageName of PACKAGES) {
    try {
      await cleanupPackage(github, scope, packageName, result, report);
    } catch {
      report(packageName, "PACKAGE_API_FAILED");
    }
  }
  if (result.failed > 0) throw new Error(INCOMPLETE);
  core.info(
    `KQ_PREVIEW_GHCR_CLEANUP code=OK deleted=${result.deleted} absent=${result.absent} retained=${result.retained}`,
  );
  return result;
}

module.exports = { cleanupImages };

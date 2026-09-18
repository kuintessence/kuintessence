"""Online image-build preparation, never an Agent or managed-store operation.

Run only in the disposable Ubuntu 20.04 PR builder:
    spack python /workspace/deploy/pr-test/spack-case/prepare.py OUTPUT_DIR

Requires Spack 1.0.0, pip clingo 5.7.1, GCC, GNU make, git, and the official
spack-packages extraction at /opt/kq-case/upstream. No packages are installed.
Only metadata.json, recipes.bundle, spack.lock and sources/ are published.
The bundle HEAD identifies a fresh commit of the exact recipes used to solve.
"""

import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request


SPEC = "hello@2.12.1"
UPSTREAM_COMMIT = "32c54f0906004d7fd1f72fd1b5970bf2bf094e26"
UPSTREAM_TREE = "f117b6bf72ee6d9c2951922f4afd31f461b02b0d"
UPSTREAM = Path("/opt/kq-case/upstream")
ROOTS = ["repos/spack_repo/kq_case", "repos/spack_repo/builtin"]
LICENSES = ("COPYRIGHT", "LICENSE-APACHE", "LICENSE-MIT")
MIB = 1024 ** 2
MAX_FILES, MAX_RECIPE_BYTES, MAX_SOURCE_BYTES = 40_000, 128 * MIB, 64 * MIB


def require(condition: object, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def relative(value: str) -> str:
    require(
        0 < len(value) <= 512
        and all(re.fullmatch(r"[A-Za-z0-9_.+-]+", p) and p not in {".", "..", ".git"}
                for p in value.split("/")),
        "Unsupported material path: " + value,
    )
    return value


def files(root: Path) -> list:
    """Do not follow, ignore, or silently omit recipe symlinks/special files."""
    require(root.is_dir() and not root.is_symlink(), "Expected a real directory")
    result, count = [], 0
    for directory, directories, names in os.walk(root, followlinks=False):
        for name in sorted(directories + names):
            path = Path(directory) / name
            relative(path.relative_to(root).as_posix())
            mode = path.lstat().st_mode
            require(stat.S_ISDIR(mode) or stat.S_ISREG(mode), "Non-regular recipe: " + str(path))
            count += 1
            require(count <= MAX_FILES, "Recipe entry budget exceeded")
            if stat.S_ISREG(mode):
                result.append(path)
    return sorted(result)


def official_tree() -> dict:
    url = ("https://api.github.com/repos/spack/spack-packages/git/trees/"
           + UPSTREAM_TREE + "?recursive=1")
    request = urllib.request.Request(url, headers={"User-Agent": "kuintessence-pr-spack-case"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(16 * MIB + 1)
    require(len(data) <= 16 * MIB, "Upstream metadata budget exceeded")
    tree = json.loads(data)
    require(tree["sha"] == UPSTREAM_TREE and tree["truncated"] is False,
            "Incomplete or incorrectly pinned upstream tree")
    selected = {}
    for entry in tree["tree"]:
        path = entry["path"]
        if not (path.startswith("repos/") or path in LICENSES):
            continue
        relative(path)
        if entry["type"] == "tree":
            continue
        require(entry["type"] == "blob" and entry["mode"] in {"100644", "100755"},
                "Pinned upstream contains a symlink or unsupported entry: " + path)
        selected[path] = entry
    require(0 < len(selected) <= MAX_FILES, "Upstream file budget exceeded")
    require(all(name in selected for name in LICENSES), "Upstream licenses are missing")
    return selected


def copy_recipes(destination: Path) -> None:
    expected = official_tree()
    actual = {p.relative_to(UPSTREAM).as_posix(): p for p in files(UPSTREAM / "repos")}
    actual.update({name: UPSTREAM / name for name in LICENSES})
    require(set(actual) == set(expected), "Local recipes differ from the pinned upstream tree")
    total = 0
    for name, source in sorted(actual.items()):
        info = source.lstat()
        require(stat.S_ISREG(info.st_mode), "Upstream license/recipe is not a regular file")
        require(info.st_size == expected[name]["size"], "Upstream file size mismatch: " + name)
        total += info.st_size
        require(total <= MAX_RECIPE_BYTES, "Recipe byte budget exceeded")
        data = source.read_bytes()
        digest = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        require(digest == expected[name]["sha"], "Upstream Git blob mismatch: " + name)
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(int(expected[name]["mode"], 8) & 0o777)

    custom = destination / ROOTS[0]
    package = custom / "packages/hello"
    package.mkdir(parents=True)
    for source, target in (
        (Path(__file__).with_name("hello") / "package.py", package / "package.py"),
        (Path(__file__).with_name("hello") / "repo.yaml", custom / "repo.yaml"),
    ):
        require(stat.S_ISREG(source.lstat().st_mode), "Custom recipe must be a regular file")
        shutil.copyfile(source, target)
        target.chmod(0o644)
    (destination / "upstream.json").write_text(
        json.dumps({"repository": "spack/spack-packages", "commit": UPSTREAM_COMMIT}) + "\n"
    )


def bundle_recipes(tree: Path, output: Path) -> str:
    # A separate repository snapshots the current recipe files, including edits
    # not committed in /workspace. Never commit or alter the workspace itself.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({
        "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_AUTHOR_NAME": "Kuintessence PR", "GIT_AUTHOR_EMAIL": "pr@example.invalid",
        "GIT_COMMITTER_NAME": "Kuintessence PR", "GIT_COMMITTER_EMAIL": "pr@example.invalid",
    })

    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=tree, env=env, check=True, text=True,
            stdout=subprocess.PIPE, timeout=120,
        ).stdout.strip()

    # Ubuntu 20.04's Git predates `git init --initial-branch`.
    git("init")
    git("symbolic-ref", "HEAD", "refs/heads/case")
    git("add", "--all")
    git("-c", "commit.gpgsign=false", "commit", "-m", "GNU Hello PR recipe snapshot")
    commit = git("rev-parse", "HEAD")
    require(re.fullmatch(r"[a-f0-9]{40}", commit), "Expected SHA-1 bundle HEAD")
    git("bundle", "create", str(output / "recipes.bundle"), "HEAD", "refs/heads/case")
    git("bundle", "verify", str(output / "recipes.bundle"))
    require((output / "recipes.bundle").stat().st_size <= 128 * MIB, "Bundle budget exceeded")
    return commit


def configuration(work: Path) -> dict:
    return {
        "bootstrap:": {"enable": False, "root": str(work / "bootstrap"), "sources": []},
        "repos:": {}, "mirrors:": {}, "upstreams:": {},
        "config": {
            "checksum": True, "verify_ssl": True, "connect_timeout": 30,
            "url_fetch_method": "urllib", "build_jobs": 2,
            "build_stage": [str(work / "stage")],
            "source_cache": str(work / "source-cache"), "misc_cache": str(work / "misc-cache"),
            "install_tree": {"root": str(work / "store")},
            "concretization_cache": {"enable": False},
        },
        "concretizer": {
            "reuse": False, "unify": True, "timeout": 180, "error_on_timeout": True,
            "targets": {"host_compatible": True, "granularity": "generic"},
            "splice": {"automatic": False},
        },
        "packages:": {
            "all": {"target": ["x86_64"], "providers": {"c": ["gcc"]}},
            "gcc": {"buildable": False}, "gmake": {"buildable": False},
            "glibc": {"buildable": False},
        },
    }


def export_sources(mirror: Path, output: Path) -> list:
    sources, total = [], 0
    for directory, directories, names in os.walk(mirror, followlinks=False):
        require(not any((Path(directory) / p).is_symlink() for p in directories),
                "Mirror contains a directory symlink")
        for name in sorted(names):
            path = Path(directory) / name
            rel = relative(path.relative_to(mirror).as_posix())
            resolved = path.resolve(strict=True)
            require(mirror in resolved.parents and resolved.is_file(),
                    "Mirror alias escapes the mirror or is not a file")
            total += resolved.stat().st_size
            require(total <= MAX_SOURCE_BYTES and len(sources) < 128, "Source budget exceeded")
            target = output / "sources" / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(resolved, target)
            target.chmod(0o644)
            sources.append({"path": rel, "file": "sources/" + rel})
    require(sources, "Empty native source mirror")
    return sorted(sources, key=lambda s: s["path"])


def prepare(output: Path, work: Path) -> dict:
    import spack
    import spack.config
    import spack.detection
    import spack.environment
    import spack.fetch_strategy
    import spack.mirrors.utils
    import spack.paths
    import spack.repo
    import spack.store

    require(spack.__version__ == "1.0.0", "Requires exactly Spack 1.0.0")
    clingo = importlib.import_module("clingo")
    require(clingo.__version__ == "5.7.1", "Requires preinstalled clingo 5.7.1")
    importlib.import_module("clingo.ast")
    tree = work / "recipes"
    tree.mkdir()
    copy_recipes(tree)
    commit = bundle_recipes(tree, output)
    scope = spack.config.InternalConfigScope("kq-case", configuration(work))
    defaults = str(Path(spack.paths.etc_path) / "defaults")
    with spack.config.use_configuration(defaults, scope):
        with spack.repo.use_repositories(*(str(tree / p) for p in ROOTS), override=True):
            detected = spack.detection.by_path(
                ["builtin.gcc", "builtin.gmake"], path_hints=["/usr/bin"], max_workers=2
            )
            spack.detection.update_configuration(detected, scope=scope.name, buildable=False)
            for name in ("gcc", "gmake"):
                require(spack.config.get("packages:" + name + ":externals"),
                        "Required system external was not detected: " + name)
            env_path = work / "env"
            env_path.mkdir()
            (env_path / "spack.yaml").write_text(json.dumps({"spack": {"specs": [SPEC], "view": False}}))
            with spack.store.use_store(str(work / "store")):
                with spack.environment.Environment(str(env_path)) as environment:
                    environment.concretize(tests=False)
                    environment.write(regenerate=False)
                    roots = list(environment.concrete_roots())
                    require(len(roots) == 1, "Expected one native root")
                    root = roots[0]
                    require(root.name == "hello" and str(root.version) == "2.12.1"
                            and root.namespace == "kq_case" and not root.external,
                            "Unexpected native root")
                    require(str(root.architecture) == "linux-ubuntu20.04-x86_64",
                            "Run preparation in the Ubuntu 20.04 x86_64 scheduler builder")
                    nodes = list(root.traverse())
                    require(len(nodes) <= 16, "Unexpectedly large case DAG")
                    require(all(str(node.architecture) == str(root.architecture) for node in nodes),
                            "External/compiler architecture differs from the root target")
                    nonexternal = [node for node in nodes if not node.external]
                    require({node.name for node in nonexternal}
                            <= {"hello", "compiler-wrapper", "gcc-runtime"},
                            "Unexpected compiled dependency; refuse an unbounded build")
                    for node in nonexternal:
                        for stage in node.package.stage:
                            fetcher = stage.default_fetcher
                            require(isinstance(fetcher, spack.fetch_strategy.BundleFetchStrategy)
                                    or (isinstance(fetcher, spack.fetch_strategy.URLFetchStrategy)
                                        and fetcher.digest and not stage.skip_checksum_for_mirror),
                                    "Unchecksummed or unsupported source")
                    mirror = work / "mirror"
                    _, _, errors = spack.mirrors.utils.create(str(mirror), nonexternal)
                    require(not errors, "Native mirror creation failed")
                    lock_path = env_path / "spack.lock"
                    lock = json.loads(lock_path.read_text())
                    require(lock["_meta"] == {
                        "file-type": "spack-lockfile", "lockfile-version": 6, "specfile-version": 5,
                    }, "Unexpected native lock format")
                    require(lock["roots"] == [{"hash": root.dag_hash(), "spec": SPEC}],
                            "Native lock root changed")
                    for node in nonexternal:
                        require(lock["concrete_specs"][node.dag_hash()]["package_hash"]
                                == node.package.content_hash(), "Recipe hash changed after solving")
                    shutil.copyfile(lock_path, output / "spack.lock")
                    return {
                        "spec": SPEC, "target": str(root.architecture), "commit": commit,
                        "roots": ROOTS, "sources": export_sources(mirror, output),
                        "lockfile": "spack.lock",
                    }


def main() -> None:
    require(len(sys.argv) == 2, "Usage: spack python prepare.py OUTPUT_DIR")
    os.umask(0o022)
    sys.dont_write_bytecode = True
    output = Path(sys.argv[1]).absolute()
    require(not output.is_symlink(), "Output must not be a symlink")
    output.mkdir(parents=True, exist_ok=True)
    require(not list(output.iterdir()), "Output must be empty")
    output = output.resolve(strict=True)
    output.chmod(0o755)
    with tempfile.TemporaryDirectory(prefix=".prepare-", dir=output) as temporary:
        metadata = prepare(output, Path(temporary))
    # Publication marker is written only after all native preparation succeeds.
    (output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    for name in ("metadata.json", "spack.lock", "recipes.bundle"):
        (output / name).chmod(0o644)
    print(json.dumps(metadata, sort_keys=True))


if __name__ == "__main__":
    main()

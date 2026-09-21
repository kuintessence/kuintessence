"""Online image-build preparation, never an Agent or managed-store operation.

Run only in the disposable Ubuntu 20.04 PR builder:
    spack python /workspace/deploy/pr-test/spack-case/prepare.py OUTPUT_DIR [hello|samtools]

Requires Spack 1.0.0, pip clingo 5.7.1, GCC, GNU make, git, and the official
spack-packages checkout at /opt/kq-case/upstream. No packages are installed.
Only metadata.json, recipes.bundle, spack.lock and sources/ are published.
The bundle HEAD identifies a fresh commit of the exact recipes used to solve.
"""

import hashlib
import importlib
from itertools import islice
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile


SPEC = "hello@2.12.1"
TARGET = "linux-ubuntu20.04-x86_64"
UPSTREAM_COMMIT = "32c54f0906004d7fd1f72fd1b5970bf2bf094e26"
UPSTREAM_TREE = "f117b6bf72ee6d9c2951922f4afd31f461b02b0d"
UPSTREAM = Path("/opt/kq-case/upstream")
ROOTS = ["repos/spack_repo/kq_case", "repos/spack_repo/builtin"]
CASES = {
    "hello": {
        "spec": SPEC, "version": "2.12.1", "namespace": "kq_case",
        "roots": tuple(ROOTS), "externals": ("gcc", "gmake"),
        "compiled": {"hello": "2.12.1"},
    },
    "samtools": {
        "spec": ("samtools@1.19.2 ^htslib@1.19.1~libcurl~libdeflate"
                 " ^ncurses+symlinks %pkgconf ^zlib@1.3.1"),
        "version": "1.19.2", "namespace": "builtin",
        "roots": (ROOTS[1],), "externals": ("gcc", "gmake", "python", "perl"),
        # None leaves supporting versions to the native solver, pinned only in the lock.
        "compiled": {
            "samtools": "1.19.2", "htslib": "1.19.1", "zlib": "1.3.1",
            "ncurses": None, "bzip2": None, "xz": None,
            "pkgconf": None, "diffutils": None, "libiconv": None,
        },
    },
}
RUNTIME_PACKAGES = {"compiler-wrapper", "gcc-runtime"}
LICENSES = ("COPYRIGHT", "LICENSE-APACHE", "LICENSE-MIT")
MIB = 1024 ** 2
MAX_FILES, MAX_RECIPE_BYTES, MAX_SOURCE_BYTES = 40_000, 128 * MIB, 64 * MIB
MAX_TREE_BYTES = 16 * MIB
MAX_DAG_NODES, MAX_SOURCES = 16, 128


def require(condition: object, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def case_definition(name: str = "hello") -> dict:
    require(name in CASES, "Unsupported material case")
    return CASES[name]


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


def upstream_git(*args: str) -> bytes:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({
        "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_NO_REPLACE_OBJECTS": "1", "GIT_TERMINAL_PROMPT": "0",
    })
    # Bound in-memory metadata even if git produces an unexpectedly large tree.
    with tempfile.TemporaryFile() as output:
        subprocess.run(
            ["git", *args], cwd=UPSTREAM, env=env, check=True,
            stdout=output, timeout=120,
        )
        output.seek(0)
        data = output.read(MAX_TREE_BYTES + 1)
    require(len(data) <= MAX_TREE_BYTES, "Upstream metadata budget exceeded")
    return data


def parse_tree(data: bytes) -> dict:
    require(0 < len(data) <= MAX_TREE_BYTES, "Upstream metadata budget exceeded")
    require(data.endswith(b"\0"), "Incomplete upstream tree metadata")
    selected = {}
    for record in data[:-1].split(b"\0"):
        header, separator, raw_path = record.partition(b"\t")
        fields = header.split()
        require(separator and len(fields) == 4, "Malformed upstream tree record")
        mode, kind, digest, size = fields
        path = raw_path.decode("utf-8")
        if not (path.startswith("repos/") or path in LICENSES):
            continue
        relative(path)
        require(kind == b"blob" and mode in (b"100644", b"100755"),
                "Pinned upstream contains a symlink or unsupported entry: " + path)
        require(re.fullmatch(rb"[a-f0-9]{40}", digest)
                and re.fullmatch(rb"[0-9]{1,20}", size), "Invalid upstream blob metadata")
        require(path not in selected, "Duplicate upstream path: " + path)
        selected[path] = {
            "path": path, "type": "blob", "mode": mode.decode("ascii"),
            "sha": digest.decode("ascii"), "size": int(size),
        }
        require(len(selected) <= MAX_FILES, "Upstream file budget exceeded")
    require(0 < len(selected) <= MAX_FILES, "Upstream file budget exceeded")
    require(all(name in selected for name in LICENSES), "Upstream licenses are missing")
    return selected


def official_tree() -> dict:
    require(UPSTREAM.is_dir() and not UPSTREAM.is_symlink()
            and (UPSTREAM / ".git").is_dir() and not (UPSTREAM / ".git").is_symlink(),
            "Expected the upstream Git checkout")
    require(upstream_git("rev-parse", "--verify", "HEAD^{commit}").strip()
            == UPSTREAM_COMMIT.encode("ascii"), "Incorrectly pinned upstream commit")
    require(upstream_git("rev-parse", "--verify", UPSTREAM_COMMIT + "^{tree}").strip()
            == UPSTREAM_TREE.encode("ascii"), "Incorrectly pinned upstream tree")
    return parse_tree(upstream_git("ls-tree", "-r", "-l", "-z", UPSTREAM_TREE))


def copy_recipes(destination: Path, case: str = "hello") -> None:
    case_definition(case)
    expected = official_tree()
    actual = {p.relative_to(UPSTREAM).as_posix(): p for p in files(UPSTREAM / "repos")}
    actual.update({name: UPSTREAM / name for name in LICENSES})
    require(set(actual) == set(expected), "Local recipes differ from the pinned upstream tree")
    total = 0
    for name, source in sorted(actual.items()):
        info = source.lstat()
        require(stat.S_ISREG(info.st_mode), "Upstream license/recipe is not a regular file")
        require(stat.S_IMODE(info.st_mode) == (int(expected[name]["mode"], 8) & 0o777),
                "Upstream file mode mismatch: " + name)
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

    if case == "hello":
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
    git("-c", "commit.gpgsign=false", "commit", "-m", "PR case recipe snapshot")
    commit = git("rev-parse", "HEAD")
    require(re.fullmatch(r"[a-f0-9]{40}", commit), "Expected SHA-1 bundle HEAD")
    git("bundle", "create", str(output / "recipes.bundle"), "HEAD", "refs/heads/case")
    git("bundle", "verify", str(output / "recipes.bundle"))
    require((output / "recipes.bundle").stat().st_size <= 128 * MIB, "Bundle budget exceeded")
    return commit


def configuration(work: Path, case: str = "hello") -> dict:
    selected = case_definition(case)
    packages = {
        "all": {"require": ["arch=" + TARGET]},
        **{name: {"buildable": False} for name in (*selected["externals"], "glibc")},
    }
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
        "packages:": packages,
    }


def validate_dag(root, case: str = "hello") -> list:
    selected = case_definition(case)
    require(root.name == case and str(root.version) == selected["version"]
            and root.namespace == selected["namespace"] and not root.external,
            "Unexpected native root")
    require(str(root.architecture) == TARGET,
            "Run preparation in the Ubuntu 20.04 x86_64 scheduler builder")
    nodes = list(islice(root.traverse(), MAX_DAG_NODES + 1))
    require(len(nodes) <= MAX_DAG_NODES, "Unexpectedly large case DAG")
    require(all(str(node.architecture) == str(root.architecture) for node in nodes),
            "External/compiler architecture differs from the root target")
    nonexternal = [node for node in nodes if not node.external]
    expected = selected["compiled"]
    names = {node.name for node in nonexternal}
    pinned = {name for name, version in expected.items() if version is not None}
    require(pinned <= names <= set(expected) | RUNTIME_PACKAGES,
            "Unexpected compiled dependency; refuse an unbounded build")
    for node in nonexternal:
        require(node.namespace == (selected["namespace"] if node.name == case else "builtin"),
                "Unexpected dependency namespace")
        if expected.get(node.name) is not None:
            require(str(node.version) == expected[node.name], "Unexpected dependency version")
    external_names = {node.name for node in nodes if node.external}
    require(set(selected["externals"]) <= external_names
            <= set(selected["externals"]) | {"glibc"}, "Unexpected system external")
    for node in nodes:
        if node.external and node.name in {"python", "perl"}:
            require(node.namespace == "builtin" and str(node.external_path) == "/usr"
                    and not node.external_modules, "Runtime external must come from /usr/bin")
    if case == "samtools":
        require({"pkgconf", "ncurses"} <= names, "Required samtools dependency is missing")
        require(all(node.satisfies("+symlinks %pkgconf")
                    for node in nonexternal if node.name == "ncurses"),
                "Unexpected ncurses features or build provider")
        htslib = next(node for node in nonexternal if node.name == "htslib")
        require(htslib.satisfies("~libcurl~libdeflate"), "Unexpected htslib features")
    return nonexternal


def fetch_sources(mirror: Path, nodes: list, strategies, create) -> None:
    count = 0
    for node in nodes:
        stages = list(islice(node.package.stage, MAX_SOURCES + 1))
        count += len(stages)
        require(stages and count <= MAX_SOURCES, "Source stage budget exceeded")
        for stage in stages:
            fetcher = stage.default_fetcher
            bundle = isinstance(fetcher, strategies.BundleFetchStrategy)
            require(
                (bundle and node.name in RUNTIME_PACKAGES)
                or (isinstance(fetcher, strategies.URLFetchStrategy)
                    and not isinstance(fetcher, strategies.FetchAndVerifyExpandedFile)
                    and fetcher.digest and not stage.skip_checksum_for_mirror),
                "Unchecksummed or unsupported source",
            )
    _, _, errors = create(str(mirror), nodes)
    require(not errors, "Native mirror creation failed")


def export_sources(mirror: Path, output: Path) -> list:
    require(mirror.is_dir() and not mirror.is_symlink(), "Expected a real source mirror")
    mirror = mirror.resolve(strict=True)
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
            require(total <= MAX_SOURCE_BYTES and len(sources) < MAX_SOURCES,
                    "Source budget exceeded")
            target = output / "sources" / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(resolved, target)
            target.chmod(0o644)
            sources.append({"path": rel, "file": "sources/" + rel})
    require(sources, "Empty native source mirror")
    return sorted(sources, key=lambda s: s["path"])


def material_metadata(case: str, target: str, commit: str, sources: list) -> dict:
    selected = case_definition(case)
    return {
        "case": case, "spec": selected["spec"], "target": target, "commit": commit,
        "roots": list(selected["roots"]), "sources": sources, "lockfile": "spack.lock",
    }


def prepare(output: Path, work: Path, case: str = "hello") -> dict:
    selected = case_definition(case)
    import spack
    import spack.config
    import spack.detection
    import spack.environment
    import spack.fetch_strategy
    import spack.mirrors.utils
    import spack.repo
    import spack.spec
    import spack.store

    require(spack.__version__ == "1.0.0", "Requires exactly Spack 1.0.0")
    clingo = importlib.import_module("clingo")
    require(clingo.__version__ == "5.7.1", "Requires preinstalled clingo 5.7.1")
    importlib.import_module("clingo.ast")
    tree = work / "recipes"
    tree.mkdir()
    copy_recipes(tree, case)
    commit = bundle_recipes(tree, output)
    scope = spack.config.InternalConfigScope("kq-case", configuration(work, case))
    with spack.config.use_configuration(scope):
        with spack.repo.use_repositories(*(str(tree / p) for p in selected["roots"]), override=True):
            detected = spack.detection.by_path(
                ["builtin." + name for name in selected["externals"]],
                path_hints=["/usr/bin"], max_workers=2,
            )
            for name in ("python", "perl"):
                if name in selected["externals"]:
                    detected[name] = [
                        spec for spec in detected.get(name, [])
                        if str(spec.external_path) == "/usr"
                    ]
            spack.detection.update_configuration(detected, scope=scope.name, buildable=False)
            for name in selected["externals"]:
                require(spack.config.get("packages:" + name + ":externals"),
                        "Required system external was not detected: " + name)
            spec = selected["spec"]
            require(str(spack.spec.Spec(spec)) == spec, "Material spec is not canonical")
            env_path = work / "env"
            env_path.mkdir()
            (env_path / "spack.yaml").write_text(json.dumps({"spack": {"specs": [spec], "view": False}}))
            with spack.store.use_store(str(work / "store")):
                with spack.environment.Environment(str(env_path)) as environment:
                    environment.concretize(tests=False)
                    environment.write(regenerate=False)
                    roots = list(environment.concrete_roots())
                    require(len(roots) == 1, "Expected one native root")
                    root = roots[0]
                    nonexternal = validate_dag(root, case)
                    mirror = work / "mirror"
                    fetch_sources(mirror, nonexternal, spack.fetch_strategy,
                                  spack.mirrors.utils.create)
                    lock_path = env_path / "spack.lock"
                    lock = json.loads(lock_path.read_text())
                    require(lock["_meta"] == {
                        "file-type": "spack-lockfile", "lockfile-version": 6, "specfile-version": 5,
                    }, "Unexpected native lock format")
                    require(lock["roots"] == [{"hash": root.dag_hash(), "spec": spec}],
                            "Native lock root changed")
                    for node in nonexternal:
                        require(lock["concrete_specs"][node.dag_hash()]["package_hash"]
                                == node.package.content_hash(), "Recipe hash changed after solving")
                    shutil.copyfile(lock_path, output / "spack.lock")
                    return material_metadata(case, str(root.architecture), commit,
                                             export_sources(mirror, output))


def main() -> None:
    require(len(sys.argv) in (2, 3), "Usage: spack python prepare.py OUTPUT_DIR [hello|samtools]")
    case = sys.argv[2] if len(sys.argv) == 3 else "hello"
    case_definition(case)
    os.umask(0o022)
    sys.dont_write_bytecode = True
    output = Path(sys.argv[1]).absolute()
    require(not output.is_symlink(), "Output must not be a symlink")
    output.mkdir(parents=True, exist_ok=True)
    require(not list(output.iterdir()), "Output must be empty")
    output = output.resolve(strict=True)
    output.chmod(0o755)
    with tempfile.TemporaryDirectory(prefix=".prepare-", dir=output) as temporary:
        metadata = prepare(output, Path(temporary), case)
    # Publication marker is written only after all native preparation succeeds.
    (output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    for name in ("metadata.json", "spack.lock", "recipes.bundle"):
        (output / name).chmod(0o644)
    print(json.dumps(metadata, sort_keys=True))


if __name__ == "__main__":
    main()

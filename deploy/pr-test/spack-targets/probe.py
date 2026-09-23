"""Actions-only native userspace baseline, not the managed worker or a publisher."""

import contextlib
import hashlib
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile


SPACK_COMMIT = "73eaea13f381e3495299284856fd02a64e1d154c"
SPEC = "hello@2.12.1"
PROFILES = {
    "centos7": ("centos", "7", "centos7"),
    "ubuntu24": ("ubuntu", "24.04", "ubuntu24.04"),
    "ubuntu26": ("ubuntu", "26.04", "ubuntu26.04"),
}
MAX_FILE_BYTES = 128 * 1024 ** 2
MAX_DELIVERY_BYTES = 192 * 1024 ** 2
ROOTS = ["repos/spack_repo/kq_case", "repos/spack_repo/builtin"]


class ProbeError(Exception):
    pass


def require(condition, message="invalid-input"):
    if not condition:
        raise ProbeError(message)


def target(profile):
    require(profile in PROFILES, "unsupported-profile")
    return "linux-" + PROFILES[profile][2] + "-x86_64"


def baseline():
    path = Path(__file__).with_name("baseline") / "prepare.py"
    module_spec = importlib.util.spec_from_file_location("target_baseline", path)
    require(module_spec is not None and module_spec.loader is not None)
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module


def json_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate-json-key")
        result[key] = value
    return result


def file_facts(path):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1)
    require(0 < before.st_size <= MAX_FILE_BYTES)
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(64 * 1024), b""):
            digest.update(chunk)
    after = path.lstat()
    require((before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            == (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns))
    return {"sha256": digest.hexdigest(), "bytes": before.st_size}


def inventory(root):
    require(root.is_dir() and not root.is_symlink())
    found = {}
    count = 0
    total = 0
    for path in sorted(root.rglob("*")):
        count += 1
        require(count <= 512)
        mode = path.lstat().st_mode
        require(stat.S_ISDIR(mode) or stat.S_ISREG(mode))
        name = path.relative_to(root).as_posix()
        require(all(re.fullmatch(r"[A-Za-z0-9_.+-]+", part) and part not in {".", ".."}
                    for part in name.split("/")))
        if stat.S_ISREG(mode) and name != "metadata.json":
            found[name] = file_facts(path)
            total += found[name]["bytes"]
            require(total <= MAX_DELIVERY_BYTES and len(found) <= 130)
    return found


def validate_delivery(root, profile):
    expected_target = target(profile)
    require(root.is_dir() and not root.is_symlink())
    metadata_path = root / "metadata.json"
    require(not metadata_path.is_symlink())
    facts = file_facts(metadata_path)
    require(facts["bytes"] <= 1024 ** 2)
    metadata = json.loads(metadata_path.read_text(), object_pairs_hook=json_object)
    require(isinstance(metadata, dict) and set(metadata) == {
        "version", "profile", "target", "spec", "rootHash", "recipeCommit",
        "spackCommit", "files",
    })
    require(type(metadata["version"]) is int and metadata["version"] == 1)
    require(metadata["profile"] == profile and metadata["target"] == expected_target)
    require(metadata["spec"] == SPEC and metadata["spackCommit"] == SPACK_COMMIT)
    require(isinstance(metadata["rootHash"], str)
            and re.fullmatch(r"[a-z2-7]{32}", metadata["rootHash"]))
    require(isinstance(metadata["recipeCommit"], str)
            and re.fullmatch(r"[0-9a-f]{40}", metadata["recipeCommit"]))
    files = metadata["files"]
    require(isinstance(files, dict) and 3 <= len(files) <= 130)
    require({"recipes.bundle", "spack.lock"} <= set(files))
    for name, entry in files.items():
        require(isinstance(name, str) and (
            name in {"recipes.bundle", "spack.lock"} or name.startswith("sources/")
        ))
        require(all(re.fullmatch(r"[A-Za-z0-9_.+-]+", part) and part not in {".", ".."}
                    for part in name.split("/")))
        require(isinstance(entry, dict) and set(entry) == {"sha256", "bytes"})
        require(type(entry["bytes"]) is int and 0 < entry["bytes"] <= MAX_FILE_BYTES)
        require(isinstance(entry["sha256"], str)
                and re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]))
    require(inventory(root) == files, "inventory-mismatch")
    require(file_facts(metadata_path) == facts, "metadata-changed")
    return metadata


def missing_source_check(root, profile, metadata, work):
    omitted = next(name for name in metadata["files"] if name.startswith("sources/"))
    with tempfile.TemporaryDirectory(prefix="missing-source-", dir=work) as directory:
        broken = Path(directory)
        shutil.copyfile(root / "metadata.json", broken / "metadata.json")
        for name in metadata["files"]:
            if name == omitted:
                continue
            destination = broken / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / name, destination)
        try:
            validate_delivery(broken, profile)
        except ProbeError as error:
            require(str(error) == "inventory-mismatch")
        else:
            raise ProbeError("missing-source-accepted")
    require(validate_delivery(root, profile) == metadata)


def check_platform(profile):
    import clingo
    import clingo.ast
    import spack
    import spack.platforms
    import spack.vendor.archspec.cpu as cpu
    import ssl

    target(profile)
    require(os.getuid() == 1000 and os.getgid() == 1000, "expected-unprivileged-user")
    require(os.environ.get("KQ_TARGET_PROFILE") == profile)
    require(sys.version_info[:3] == (3, 11, 16))
    require(ssl.OPENSSL_VERSION.startswith("OpenSSL 3.5.8 "))
    require(spack.__version__ == "1.0.0" and clingo.__version__ == "5.7.1")
    release = platform.freedesktop_os_release()
    require((release["ID"], release["VERSION_ID"]) == PROFILES[profile][:2])
    if profile == "centos7":
        require("7.9.2009" in Path("/etc/centos-release").read_text())
    host = spack.platforms.host()
    require(host.name == "linux" and str(host.default_operating_system()) == PROFILES[profile][2])
    require(platform.machine() == "x86_64" and cpu.host().family.name == "x86_64")
    gcc = subprocess.check_output(["/usr/bin/gcc", "-dumpversion"], text=True, timeout=15).strip()
    require(re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", gcc))
    print("Target identity: profile={} target={} gcc={} python=3.11.16 spack=1.0.0 code=OK"
          .format(profile, target(profile), gcc), flush=True)


def configuration(work, profile, mirror=None):
    data = baseline().configuration(work)
    data["packages:"]["all"]["require"] = ["arch=" + target(profile)]
    data["config"].update({
        "dirty": False, "build_jobs": 2, "concurrent_packages": 1,
        "locks": True, "allow_sgid": False, "build_language": "C",
        "license_dir": str(work / "licenses"), "test_stage": str(work / "test-stage"),
        "shared_linking": {"type": "rpath", "bind": False, "missing_library_policy": "error"},
        "flags": {"keep_werror": "none"},
    })
    data["modules"] = {"default": {"enable": []}}
    if mirror is not None:
        data["mirrors:"] = {"target": {"url": mirror.as_uri(), "binary": False, "source": True}}
    return data


def detect_externals(scope):
    import spack.config
    import spack.detection

    detected = spack.detection.by_path(
        ["builtin.gcc", "builtin.gmake"], path_hints=["/usr/bin"], max_workers=2,
    )
    spack.detection.update_configuration(detected, scope=scope.name, buildable=False)
    for name in ("gcc", "gmake"):
        require(spack.config.get("packages:" + name + ":externals"), "missing-external")


def validate_root(root, profile):
    import spack.hash_types

    require(root.name == "hello" and str(root.version) == "2.12.1"
            and root.namespace == "kq_case" and not root.external)
    nodes = list(root.traverse())
    require(len(nodes) <= 16)
    external_names = {node.name for node in nodes if node.external}
    require({"gcc", "gmake"} <= external_names <= {"gcc", "gmake", "glibc"})
    for node in nodes:
        require(str(node.architecture) == target(profile), "node-target-mismatch")
        require(node.spec_hash(spack.hash_types.dag_hash) == node.dag_hash())
        if node.external:
            prefix = str(node.external_path)
            require(not node.external_modules and (
                prefix == "/usr" or prefix.startswith("/usr/")
                or (node.name == "glibc" and prefix == "/")
            ))
        else:
            require(node.name in {"hello", "compiler-wrapper", "gcc-runtime"})
            require(node.namespace == ("kq_case" if node.name == "hello" else "builtin"))
    return [node for node in nodes if not node.external]


def create_environment(work):
    import spack.environment

    env_path = work / "env"
    env_path.mkdir()
    (env_path / "spack.yaml").write_text(json.dumps({"spack": {"specs": [SPEC], "view": False}}))
    return spack.environment.Environment(str(env_path))


def prepare(root, profile, work):
    import spack.config
    import spack.fetch_strategy
    import spack.mirrors.utils
    import spack.repo
    import spack.store

    require(not list(root.iterdir()), "delivery-not-empty")
    helper = baseline()
    recipes = work / "recipes"
    recipes.mkdir()
    helper.copy_recipes(recipes)
    commit = helper.bundle_recipes(recipes, root)
    scope = spack.config.InternalConfigScope("kq-target", configuration(work, profile))
    with spack.config.use_configuration(scope):
        with spack.repo.use_repositories(*(str(recipes / name) for name in ROOTS), override=True):
            detect_externals(scope)
            with spack.store.use_store(str(work / "store")):
                with create_environment(work) as environment:
                    environment.concretize(tests=False)
                    environment.write(regenerate=False)
                    roots = list(environment.concrete_roots())
                    require(len(roots) == 1)
                    native_root = roots[0]
                    nodes = validate_root(native_root, profile)
                    mirror = work / "mirror"
                    helper.fetch_sources(mirror, nodes, spack.fetch_strategy, spack.mirrors.utils.create)
                    shutil.copyfile(work / "env/spack.lock", root / "spack.lock")
                    helper.export_sources(mirror, root)
                    metadata = {
                        "version": 1, "profile": profile, "target": target(profile), "spec": SPEC,
                        "rootHash": native_root.dag_hash(), "recipeCommit": commit,
                        "spackCommit": SPACK_COMMIT, "files": inventory(root),
                    }
    (root / "metadata.json").write_text(json.dumps(metadata, sort_keys=True) + "\n")
    require(validate_delivery(root, profile) == metadata)


@contextlib.contextmanager
def mirror_only_fetch():
    import spack.stage

    original = spack.stage.Stage.fetch

    def fetch(stage, mirror_only=False, err_msg=None):
        return original(stage, mirror_only=True, err_msg=err_msg)

    multiprocessing.set_start_method("fork", force=True)
    spack.stage.Stage.fetch = fetch
    try:
        yield
    finally:
        spack.stage.Stage.fetch = original


def offline(root, profile, work, progress):
    import spack.config
    import spack.installer
    import spack.repo
    import spack.store

    metadata = validate_delivery(root, profile)
    progress("metadata")
    progress("missing-source", "RUNNING")
    missing_source_check(root, profile, metadata, work)
    progress("missing-source")
    progress("resolve", "RUNNING")
    recipes = work / "recipes"
    subprocess.run(["git", "clone", "--quiet", str(root / "recipes.bundle"), str(recipes)],
                   check=True, timeout=120)
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=recipes, text=True, timeout=15,
    ).strip()
    require(commit == metadata["recipeCommit"])
    lock = json.loads((root / "spack.lock").read_text(), object_pairs_hook=json_object)
    require(lock["_meta"] == {
        "file-type": "spack-lockfile", "lockfile-version": 6, "specfile-version": 5,
    })
    require(lock["roots"] == [{"hash": metadata["rootHash"], "spec": SPEC}])
    scope = spack.config.InternalConfigScope(
        "kq-target", configuration(work, profile, root / "sources"),
    )
    with spack.config.use_configuration(scope):
        with spack.repo.use_repositories(*(str(recipes / name) for name in ROOTS), override=True):
            detect_externals(scope)
            with spack.store.use_store(str(work / "store")) as store:
                require(not store.db.query(), "nonempty-offline-store")
                with create_environment(work) as environment:
                    environment.concretize(tests=False)
                    roots = list(environment.concrete_roots())
                    require(len(roots) == 1 and roots[0].dag_hash() == metadata["rootHash"],
                            "offline-solve-mismatch")
                    native_root = roots[0]
                    nodes = validate_root(native_root, profile)
                    require({node.dag_hash() for node in native_root.traverse()}
                            == set(lock["concrete_specs"]))
                    for node in nodes:
                        require(lock["concrete_specs"][node.dag_hash()]["package_hash"]
                                == node.package.content_hash(), "recipe-hash-mismatch")
                    progress("resolve")
                    progress("install", "RUNNING")
                    with mirror_only_fetch():
                        spack.installer.PackageInstaller(
                            [native_root.package], use_cache=False, fail_fast=True,
                            package_use_cache=False, dependencies_use_cache=False,
                            explicit=True, include_build_deps=True,
                            install_deps=True, install_package=True, tests=False,
                        ).install()
                    for node in nodes:
                        upstream, record = store.db.query_by_spec_hash(node.dag_hash())
                        require(not upstream and record is not None and record.installed)
                    progress("install")
                    progress("execute", "RUNNING")
                    executable = Path(str(native_root.prefix)) / "bin/hello"
                    require((work / "store") in executable.resolve(strict=True).parents)
                    with executable.open("rb") as stream:
                        require(stream.read(4) == b"\x7fELF")
                    for args, expected in (([], "Hello, world!\n"),
                                           (["--version"], "hello (GNU Hello) 2.12.1\n")):
                        output = subprocess.check_output(
                            [str(executable), *args], text=True, timeout=15,
                        )
                        require(output.startswith(expected) if args else output == expected)
                    progress("execute")
    progress("readback", "RUNNING")
    require(validate_delivery(root, profile) == metadata, "delivery-changed")
    progress("readback")


def main():
    phase, profile, stage = "unknown", "unknown", "guard"
    try:
        require(len(sys.argv) == 4)
        phase, profile = sys.argv[1:3]
        require(phase in {"prepare", "offline"} and profile in PROFILES)
        root = Path(sys.argv[3])
        require(root == Path("/delivery") and root.is_dir() and not root.is_symlink())
        os.umask(0o022)
        sys.dont_write_bytecode = True
        Path("/work/home").mkdir(exist_ok=True)

        def progress(value, code="OK"):
            nonlocal stage
            stage = value
            print("Target probe: phase={} profile={} stage={} code={}"
                  .format(phase, profile, stage, code), flush=True)

        stage = "platform"
        check_platform(profile)
        progress("platform")
        work = Path("/work/operation")
        work.mkdir()
        if phase == "prepare":
            stage = "prepare"
            prepare(root, profile, work)
            progress("prepare")
        else:
            stage = "metadata"
            offline(root, profile, work, progress)
        progress("complete")
    except Exception as error:
        # Recipes, solver messages and raw subprocess errors are never public evidence.
        safe_phase = phase if phase in {"prepare", "offline"} else "unknown"
        safe_profile = profile if profile in PROFILES else "unknown"
        allowed_errors = (
            ProbeError, OSError, ImportError, ValueError, KeyError, TypeError,
            AttributeError, RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired,
        )
        kind = next((entry.__name__ for entry in allowed_errors if isinstance(error, entry)), "other")
        trace, line = error.__traceback__, 0
        while trace:
            if (trace.tb_frame.f_code.co_filename == __file__
                    and trace.tb_frame.f_code.co_name != "require"):
                line = trace.tb_lineno
            trace = trace.tb_next
        print("Target diagnostic: phase={} profile={} error={} line={}"
              .format(safe_phase, safe_profile, kind, line), file=sys.stderr, flush=True)
        print("Target probe: phase={} profile={} stage={} code=FAILED"
              .format(safe_phase, safe_profile, stage), file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

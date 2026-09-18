"""Manual native baseline, NOT the managed Apptainer worker or isolation proof.

    spack python /workspace/deploy/pr-test/spack-case/offline.py INPUT_DIR DIGEST OUTPUT_DIR

INPUT_DIR is the Agent-exported manifest.json + blobs/<sha256 hex> layout.
The caller must provide a disposable Ubuntu 20.04 scheduler container with
no upstream network, trusted recipes, read-only input, and a fresh output.
Before installation, a real audit of a temporary input missing one source blob
must fail. The original input is never edited, even on a negative-check failure.
"""

import contextlib
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def require(condition: object, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def source_audit() -> object:
    worker = Path(__file__).resolve().parents[3] / "packages/agent/src/spack/worker/source_audit.py"
    module_spec = importlib.util.spec_from_file_location("_kq_case_source_audit", worker)
    require(module_spec is not None and module_spec.loader is not None, "Source audit is unavailable")
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def mirror_only_fetch():
    import spack.stage

    original = spack.stage.Stage.fetch

    def fetch(stage, mirror_only=False, err_msg=None):
        return original(stage, mirror_only=True, err_msg=err_msg)

    # Installer build children must inherit this guard.
    multiprocessing.set_start_method("fork", force=True)
    spack.stage.Stage.fetch = fetch
    try:
        yield
    finally:
        spack.stage.Stage.fetch = original


def native_configuration(audit: object, work: Path, output: Path) -> dict:
    data = audit.configuration(work)
    data["config"].update({
        "install_tree": {"root": str(output / "store")},
        "concretization_cache": {"enable": False},
        "verify_ssl": True, "dirty": False, "build_jobs": 2, "concurrent_packages": 1,
        "locks": True, "allow_sgid": False, "build_language": "C",
        "license_dir": str(work / "licenses"), "test_stage": str(work / "test-stage"),
        "shared_linking": {"type": "rpath", "bind": False, "missing_library_policy": "error"},
        "flags": {"keep_werror": "none"}, "url_fetch_method": "urllib",
    })
    data["modules"] = {"default": {"enable": []}}
    data["packages"] = {"all": {"permissions": {"read": "world", "write": "user"}}}
    return data


def check_missing_source(
    audit: object, input_dir: Path, digest: str, manifest: dict, output: Path
) -> None:
    refs = audit.validate_manifest(manifest)
    protected = {
        manifest["lockfile"]["digest"],
        *(recipe["archive"]["digest"] for recipe in manifest["recipes"]),
    }
    candidates = [source["blob"]["digest"] for source in manifest["sources"]
                  if source["blob"]["digest"] not in protected]
    require(candidates, "No independent source blob for the negative check")
    missing = candidates[0]
    with tempfile.TemporaryDirectory(prefix=".missing-source-", dir=output) as temporary:
        root = Path(temporary)
        broken_input, work = root / "input", root / "work"
        (broken_input / "blobs").mkdir(parents=True, mode=0o700)
        work.mkdir(mode=0o700)
        (broken_input / "manifest.json").write_bytes((input_dir / "manifest.json").read_bytes())
        for blob_digest in refs:
            if blob_digest != missing:
                # Real copies also work across read-only bind mounts/filesystems.
                shutil.copyfile(input_dir / "blobs" / blob_digest[7:],
                                broken_input / "blobs" / blob_digest[7:])
        require(not (broken_input / "blobs" / missing[7:]).exists(),
                "Negative input unexpectedly contains the omitted source")
        try:
            audit.audit(broken_input, work, digest)
        except audit.AuditError as error:
            require(str(error) == "invalid-input" and not list(work.iterdir()),
                    "Missing-source check failed at an unexpected verification step")
        else:
            raise RuntimeError("Native source audit accepted a missing source blob")
    print("Native missing-source check passed (before installation)")


def run(input_dir: Path, digest: str, output: Path) -> dict:
    audit = source_audit()
    audit_work = output / "audit"
    audit_work.mkdir(mode=0o700)
    # audit() calls production prepare_input(), then native lock loading,
    # DAG/package hashing and mirror-only checksum checks. It does NOT call
    # verify_runtime_boundary(); the PR orchestrator owns container isolation.
    # Spack caches its stage root globally; audit in another process so install
    # cannot reuse previously fetched stages despite switching configuration.
    subprocess.run(
        ["/opt/spack/bin/spack", "python", str(Path(__file__).resolve()),
         "--audit", str(input_dir), digest, str(audit_work)],
        check=True, timeout=180,
    )
    report = json.loads((audit_work / "report.json").read_text())
    require(report.get("passed") is True, "Native source audit failed: " + json.dumps(report["issues"]))

    # A separate, freshly verified input tree avoids reusing audit-stage bytes
    # or accidentally reusing the audit store/prefix during installation.
    work = output / "install"
    work.mkdir(mode=0o700)
    manifest, lock, recipes = audit.prepare_input(input_dir, work, digest)
    root_hash = lock["roots"][0]["hash"]
    require(manifest["spec"] == "hello@2.12.1", "Only the bounded GNU Hello case is supported")
    require(manifest["target"] == "linux-ubuntu20.04-x86_64", "Unexpected case target")
    require(report["rootHash"] == root_hash and report["manifestDigest"] == digest,
            "Audit root binding changed")
    check_missing_source(audit, input_dir, digest, manifest, output)

    import spack
    import spack.config
    import spack.environment
    import spack.hash_types
    import spack.installer
    import spack.platforms
    import spack.repo
    import spack.store
    import spack.user_environment
    import spack.vendor.archspec.cpu as cpu

    require(spack.__version__ == "1.0.0", "Requires exactly Spack 1.0.0")
    host = spack.platforms.host()
    require(host.name == "linux" and str(host.default_operating_system()) == "ubuntu20.04"
            and cpu.host().family.name == "x86_64", "Scheduler platform differs from preparation")
    scope = spack.config.InternalConfigScope("kq-case", native_configuration(audit, work, output))
    with spack.config.use_configuration(scope):
        with spack.repo.use_repositories(*recipes, override=True):
            with spack.store.use_store(str(output / "store")) as store:
                with spack.environment.Environment(str(work / "env")) as environment:
                    roots = list(environment.concrete_roots())
                    require(len(roots) == 1 and roots[0].dag_hash() == root_hash,
                            "Native root mismatch")
                    root = roots[0]
                    require(root.name == "hello" and str(root.version) == "2.12.1"
                            and root.namespace == "kq_case" and not root.external,
                            "Expected reviewed GNU Hello recipe")
                    nodes = list(root.traverse())
                    require(len(nodes) <= 16 and {n.dag_hash() for n in nodes}
                            == set(lock["concrete_specs"]), "Unexpected native DAG")
                    require({n.name for n in nodes if not n.external}
                            <= {"hello", "compiler-wrapper", "gcc-runtime"},
                            "Unexpected compiled dependency")
                    for node in nodes:
                        require(node.spec_hash(spack.hash_types.dag_hash) == node.dag_hash(),
                                "Native hash mismatch")
                        require(str(node.architecture) == manifest["target"], "Node target mismatch")
                        if node.external:
                            prefix = Path(str(node.external_path))
                            system_prefix = (str(prefix) == "/usr"
                                             or str(prefix).startswith("/usr/")
                                             or (node.name == "glibc" and str(prefix) == "/"))
                            require(node.name in {"gcc", "gmake", "glibc"} and not node.external_modules
                                    and prefix.is_absolute() and prefix.is_dir()
                                    and system_prefix,
                                    "Unexpected system external")
                    with mirror_only_fetch():
                        spack.installer.PackageInstaller(
                            [root.package], use_cache=False, fail_fast=True,
                            package_use_cache=False, dependencies_use_cache=False,
                            explicit=True, include_build_deps=True,
                            install_deps=True, install_package=True, tests=False,
                        ).install()
                    with store.db.read_transaction():
                        for node in nodes:
                            if node.external:
                                continue
                            upstream, record = store.db.query_by_spec_hash(node.dag_hash())
                            require(not upstream and record is not None and record.installed,
                                    "Package missing from independent store")
                            require(record.spec.dag_hash() == node.dag_hash()
                                    and record.path == str(node.prefix), "Installed binding mismatch")
                    prefix = Path(str(root.prefix)).resolve(strict=True)
                    require((output / "store") in prefix.parents, "Prefix escaped independent store")
                    for parent in (prefix, *prefix.parents):
                        require(parent.stat().st_mode & 0o005 == 0o005,
                                "Installed prefix ancestor must be readable/traversable by Slurm")
                    executable = prefix / "bin/hello"
                    require(executable.is_file() and os.access(executable, os.X_OK),
                            "Installed hello is not executable")
                    with executable.open("rb") as stream:
                        require(stream.read(4) == b"\x7fELF", "Expected a real native ELF executable")
                    modifications = spack.user_environment.environment_modifications_for_specs(root)
                    environment_vars = dict(os.environ)
                    modifications.apply_modifications(environment_vars)
                    environment_vars.update({"LC_ALL": "C", "LANG": "C"})
                    for arguments, expected in (
                        ([], "Hello, world!\n"), (["--version"], "hello (GNU Hello) 2.12.1\n"),
                    ):
                        result = subprocess.run(
                            [str(executable), *arguments], env=environment_vars, check=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15,
                        )
                        require(result.stdout == expected if not arguments
                                else result.stdout.startswith(expected), "GNU Hello output mismatch")
                    return {
                        "prefix": str(prefix), "rootHash": root_hash,
                        "target": manifest["target"], "spec": manifest["spec"],
                    }


def main() -> None:
    if len(sys.argv) == 5 and sys.argv[1] == "--audit":
        sys.dont_write_bytecode = True
        work = Path(sys.argv[4])
        report = source_audit().audit(Path(sys.argv[2]), work, sys.argv[3])
        (work / "report.json").write_text(json.dumps(report) + "\n")
        return
    require(len(sys.argv) == 4, "Usage: spack python offline.py INPUT_DIR DIGEST OUTPUT_DIR")
    require(sys.platform == "linux", "Only the disposable Linux PR container is supported")
    os.umask(0o022)
    sys.dont_write_bytecode = True
    input_dir = Path(sys.argv[1]).absolute()
    output = Path(sys.argv[3]).absolute()
    require(not input_dir.is_symlink() and not output.is_symlink(), "Symlink directory argument")
    input_dir = input_dir.resolve(strict=True)
    output.mkdir(parents=True, exist_ok=True)
    output = output.resolve(strict=True)
    require(not list(output.iterdir()), "Output must be empty; never reuse an Agent store")
    require(input_dir != output and input_dir not in output.parents and output not in input_dir.parents,
            "Input and output must not overlap")
    output.chmod(0o755)
    result = run(input_dir, sys.argv[2], output)
    (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    (output / "result.json").chmod(0o644)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()

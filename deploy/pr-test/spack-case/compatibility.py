"""Bounded GNU Hello native API check, not managed runtime or site acceptance.

Run install, verify and load in separate disposable, offline, resource-limited
containers. Mount the store read-only for verify/load. No signatures, profiles
or institutional confirmations are created. The caller records image identity.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


BASE = Path(__file__).resolve().parent
baseline = module("_native_baseline", BASE / "offline.py")
worker = module("_native_worker", BASE.parents[2] / "packages/agent/src/spack/worker/install_worker.py")
require = baseline.require


def run(action, input_dir, digest, work, store):
    require(os.getuid() != 0, "Use a non-root disposable container")
    require(all(path.is_absolute() and path.resolve() == path for path in (input_dir, work, store)),
            "Use canonical absolute paths")
    require(not any(left == right or left in right.parents or right in left.parents
                    for left, right in ((input_dir, work), (input_dir, store), (work, store))),
            "Input, work and store must be independent")
    require(not work.exists(), "Work must be new; preserve failed attempts")
    require(store.exists() != (action == "install"), "Install requires an absent store; verify/load reuse it")
    if action != "install":
        require(os.statvfs(store).f_flag & os.ST_RDONLY, "Verify/load require an actually read-only store")
    work.mkdir(mode=0o700)
    audit = worker.audit
    manifest = audit.document(audit.read_regular(input_dir / "manifest.json", 2 * audit.MIB))
    audit.validate_manifest(manifest)
    require(manifest["spec"] == "hello@2.12.1", "Only reviewed GNU Hello 2.12.1 is supported")
    require(manifest["target"] in {"linux-ubuntu20.04-x86_64", "linux-ubuntu24.04-x86_64", "linux-ubuntu24.04-x86_64_v2"},
            "Unexpected compatibility target")
    if action == "install":
        baseline.check_missing_source(audit, input_dir, digest, manifest, work)
    audit_work = work / "audit"
    audit_work.mkdir(mode=0o700)
    subprocess.run(["/opt/spack/bin/spack", "python", str(BASE / "offline.py"),
                    "--audit", str(input_dir), digest, str(audit_work)], check=True, timeout=180)
    report = json.loads((audit_work / "report.json").read_text())
    require(report.get("passed") is True and report["manifestDigest"] == digest and
            report["spackVersion"] == manifest["spackVersion"], "Native audit did not pass")
    install_work = work / "native"
    install_work.mkdir(mode=0o700)
    manifest, lock, recipes = audit.prepare_input(input_dir, install_work, digest)

    import spack
    import spack.config
    import spack.environment
    import spack.installer
    import spack.paths
    import spack.repo
    import spack.store
    import spack.user_environment

    require(spack.__version__ == manifest["spackVersion"], "Runtime/material version mismatch")
    # Only native helpers use this observation; it is deliberately not a site profile.
    observed = {"target": manifest["target"], "hostFiles": [], "externals": []}
    for key, node in lock["concrete_specs"].items():
        if "external" in node:
            external = node["external"]
            require(node["name"] in {"gcc", "glibc", "gmake"} and
                    external.get("path") == "/usr" and not external.get("module"),
                    "Unexpected system external")
            observed["externals"].append({"hash": key, "prefix": external["path"]})
    worker.verify_platform(observed)
    initial = spack.config.InternalConfigScope("kq-native-input", audit.configuration(install_work))
    with spack.config.use_configuration(initial), spack.repo.use_repositories(*recipes, override=True):
        with spack.environment.Environment(str(install_work / "env")) as environment:
            roots = list(environment.concrete_roots())
            require(len(roots) == 1, "Expected one concrete root")
            nodes = worker.bind_native(roots[0], lock, observed)
            require({node.name for node in nodes.values() if not node.external}
                    <= {"hello", "compiler-wrapper", "gcc-runtime"}, "Unexpected build dependency")
    configuration = worker.configuration(install_work, nodes, manifest["target"])
    configuration["config"]["install_tree"] = {"root": str(store)}
    scope = spack.config.InternalConfigScope("kq-native-check", configuration)
    with spack.config.use_configuration(scope), spack.repo.use_repositories(*recipes, override=True):
        with spack.store.use_store(install_work / "solver-store"):
            worker.solve_lock(manifest, lock, observed)
        if action == "install":
            store.mkdir(mode=0o755)
        with spack.store.use_store(store) as native_store:
            with spack.environment.Environment(str(install_work / "env")) as environment:
                roots = list(environment.concrete_roots())
                require(len(roots) == 1, "Expected one installed root")
                root = roots[0]
                nodes = worker.bind_native(root, lock, observed)
                if action == "install":
                    with baseline.mirror_only_fetch():
                        spack.installer.PackageInstaller(
                            [root.package], use_cache=False, fail_fast=True,
                            package_use_cache=False, dependencies_use_cache=False,
                            explicit=True, include_build_deps=True,
                            install_deps=True, install_package=True,
                        ).install()
                worker.verify_tree(store, observed)
                worker.database_metadata(store)
                installed = worker.verify_installed(native_store, root, nodes, store)
                worker.bind_native(installed, lock, observed)
                executable = Path(str(installed.prefix)) / "bin/hello"
                with executable.open("rb") as stream:
                    require(stream.read(4) == b"\x7fELF", "Expected a real ELF executable")
                result = {"validation": "native-api-compatibility", "action": action,
                          "manifestDigest": digest, "spackVersion": spack.__version__,
                          "rootHash": root.dag_hash(), "target": str(root.architecture),
                          "prefix": str(installed.prefix), "nodeCount": len(nodes),
                          "executableSha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
                          "managedRuntimeAccepted": False, "siteAccepted": False}
                result["engineFiles"] = {
                    name: hashlib.sha256((Path(spack.paths.prefix) / name).read_bytes()).hexdigest()
                    for name in ("lib/spack/spack/__init__.py", "lib/spack/spack/installer.py",
                                 "lib/spack/spack/spec.py", "lib/spack/spack/solver/asp.py")
                }
                if action == "load":
                    modifications = spack.user_environment.environment_modifications_for_specs(installed)
                    shell = worker.validate_load_shell(modifications.shell_modifications("sh"), store)
                    env = dict(os.environ)
                    env.update(LC_ALL="C", LANG="C")
                    # Resolve by name after applying the exact Spack load shell.
                    completed = subprocess.run(["/bin/sh", "-ec", shell + "\ncommand -v hello; hello"],
                                               env=env, capture_output=True, text=True, check=True, timeout=15)
                    require(completed.stdout == str(executable) + "\nHello, world!\n", "Spack load/output mismatch")
                    result["stdout"] = completed.stdout
                    result["loadShell"] = shell
    (work / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "verify", "load"))
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--digest", required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--store", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o022)
    sys.dont_write_bytecode = True
    print(json.dumps(run(args.action, args.input, args.digest, args.work, args.store), sort_keys=True))

"""Managed Spack 1.0.0 worker. Entrypoint: spack python /kq/input/install_worker.py.

Only the parent authenticates the runtime SIF and supplies its read-only binds.
Site confirmations are administrator promises, not compute-node measurements.
Recipes remain trusted arbitrary Python inside the parent's isolation boundary.
All native API usage below is pinned to spack/spack tag v1.0.0.
"""

import contextlib
import copy
import hashlib
import importlib
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import re
import stat
import sys
import threading

try:
    # Spack's python command uses runpy.run_path, not python's script-path setup.
    sibling = Path(__file__).with_name("source_audit.py")
    audit = sys.modules.get("source_audit")
    if audit is None or Path(audit.__file__).resolve() != sibling.resolve():
        module_spec = importlib.util.spec_from_file_location("_kq_source_audit", sibling)
        audit = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(audit)
except (Exception, SystemExit):
    print("install-worker-failed", file=sys.stderr)
    raise SystemExit(1) from None

require = audit.require
MAX_ENTRIES = 200_000
MAX_METADATA_BYTES = 64 * audit.MIB
MAX_DB_BYTES = 32 * audit.MIB
MAX_SPEC_BYTES = 16 * audit.MIB
MAX_PIN_BYTES = 256 * audit.MIB
SHA256 = re.compile(r"[a-f0-9]{64}")
FORBIDDEN_STORE = (
    "/bin", "/sbin", "/usr", "/lib", "/lib64", "/etc", "/proc", "/sys",
    "/dev", "/run", "/kq", "/opt/spack",
)
CONFIRMATIONS = {
    "sharedStoreConfirmed", "compatibleComputeNodesConfirmed",
    "trustedRecipesConfirmed", "quotaEnforcedBySite",
}


def within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def resolved_path(path: Path) -> Path:
    try:
        return path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise audit.AuditError("invalid-path") from error


def canonical(value: object) -> Path:
    require(audit.matches(r"/[A-Za-z0-9_+./-]+", value) and len(value) <= 1024)
    require(all(p not in {"", ".", ".."} for p in value.split("/")[1:]))
    return Path(value)


def store_path(value: object) -> Path:
    path = canonical(value)
    require(len(path.parts) >= 4 and
            not any(within(path, Path(root)) for root in FORBIDDEN_STORE), "store-path")
    return path


def read_request(input_dir: Path) -> dict:
    request = audit.document(audit.read_regular(input_dir / "request.json", 2 * audit.MIB))
    require(set(request) == {
        "version", "action", "manifestDigest", "siteProfileDigest", "storePath", "siteProfile",
    })
    require(type(request["version"]) is int and request["version"] == 1)
    require(request["action"] in ("install", "verify", "load"))
    require(all(audit.matches(audit.DIGEST, request[k])
                for k in ("manifestDigest", "siteProfileDigest")))
    data = audit.read_regular(input_dir / "site-profile.json", 2 * audit.MIB)
    require("sha256:" + hashlib.sha256(data).hexdigest() == request["siteProfileDigest"])
    profile = audit.document(data)
    # JSON bool and integer are equal in Python, but are not interchangeable in Zod.
    require(json.dumps(profile, sort_keys=True) ==
            json.dumps(request["siteProfile"], sort_keys=True))
    require(set(profile) == {
        "version", "storeRoot", "target", "runtimeSifSha256", "osReleaseSha256",
        "hostFiles", "externals", *CONFIRMATIONS,
    })
    require(type(profile["version"]) is int and profile["version"] == 1)
    require(all(profile[key] is True for key in CONFIRMATIONS))
    require(audit.matches(r"linux-[A-Za-z0-9_.-]+-[A-Za-z0-9_.-]+", profile["target"])
            and len(profile["target"]) <= 256)
    require(all(audit.matches(SHA256, profile[k])
                for k in ("runtimeSifSha256", "osReleaseSha256")))
    root, store = store_path(profile["storeRoot"]), store_path(request["storePath"])
    require(store != root and within(store, root), "store-path")
    pins, externals = profile["hostFiles"], profile["externals"]
    require(isinstance(pins, list) and 1 <= len(pins) <= 256)
    require(isinstance(externals, list) and len(externals) <= 256)
    for item in pins:
        require(isinstance(item, dict) and set(item) == {"path", "sha256"})
        canonical(item["path"])
        require(audit.matches(SHA256, item["sha256"]))
    for item in externals:
        require(isinstance(item, dict) and set(item) == {"hash", "prefix"})
        canonical(item["prefix"])
        require(audit.matches(audit.HASH, item["hash"]))
    require(len({p["path"] for p in pins}) == len(pins))
    require(len({e["hash"] for e in externals}) == len(externals))
    return request


def mount_table() -> list:
    # VFS (pre-separator) flags, not superblock flags, govern read-only bind mounts.
    with Path("/proc/self/mountinfo").open("rb") as stream:
        data = stream.read(4 * audit.MIB + 1)
    require(len(data) <= 4 * audit.MIB, "mount-boundary")
    result = []
    for line in data.decode("utf-8").splitlines():
        left, separator, right = line.partition(" - ")
        fields, filesystem = left.split(), right.split()
        require(separator and len(fields) >= 6 and len(filesystem) >= 3, "mount-boundary")
        mount = re.sub(r"\\(040|011|012|134)", lambda m: chr(int(m[1], 8)), fields[4])
        require(mount.startswith("/"), "mount-boundary")
        result.append((Path(mount), set(fields[5].split(",")), filesystem[0]))
        require(len(result) <= 4096, "mount-boundary")
    return result


def readonly(path: Path, mounts: list, subtree: bool = False) -> None:
    candidates = [m for m in mounts if within(path, m[0])]
    require(candidates, "readonly-pin")
    longest = max(len(m[0].parts) for m in candidates)
    active = [m for m in candidates if len(m[0].parts) == longest]
    require(len(active) == 1 and "ro" in active[0][1] and "rw" not in active[0][1],
            "readonly-pin")
    if subtree:
        for mount, options, _ in mounts:
            if within(mount, path):
                require("ro" in options and "rw" not in options, "readonly-pin")


def verify_store(request: dict, mounts: list) -> None:
    store = store_path(request["storePath"])
    root = store_path(request["siteProfile"]["storeRoot"])
    require(store != root and within(store, root), "store-path")
    require(store.resolve(strict=True) == store and store.is_dir() and not store.is_symlink(),
            "store-path")
    require(store.stat().st_uid == os.getuid(), "store-owner")
    exact = [m for m in mounts if m[0] == store]
    require(len(exact) == 1, "store-mount")
    required = "rw" if request["action"] == "install" else "ro"
    require(exact[0][1].intersection({"ro", "rw"}) == {required}, "store-mount")
    require(not any(m[0] != store and within(m[0], store) for m in mounts), "store-mount")


def verify_scratch(input_dir: Path, work: Path, store: Path, mounts: list) -> None:
    require(input_dir.resolve(strict=True) == input_dir and input_dir.is_dir())
    readonly(input_dir, mounts, subtree=True)
    selected = [m for m in mounts if m[0] == work]
    require(len(selected) == 1 and selected[0][2] == "tmpfs" and
            selected[0][1].intersection({"rw", "ro"}) == {"rw"}, "scratch-boundary")
    require(not any(m[0] != work and within(m[0], work) for m in mounts), "scratch-boundary")
    for mount, options, filesystem in mounts:
        # Other writable filesystems must be container-local kernel/tmpfs mounts.
        if "rw" in options and mount != store:
            require(filesystem in {"tmpfs", "proc", "sysfs", "devpts", "mqueue"},
                    "writable-host-mount")
    # v1.4.3 --scratch without --workdir bind-mounts a session tmpfs directory
    # created 0755. Tighten only after every mount check, never on a host workdir.
    require(resolved_path(work) == work, "scratch-boundary")
    try:
        fd = os.open(work, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            mode = stat.S_IMODE(info.st_mode)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and
                    mode & 0o700 == 0o700 and not mode & 0o7022, "scratch-boundary")
            with os.scandir(fd) as entries:
                require(next(entries, None) is None, "scratch-boundary")
            current = work.lstat()
            require((current.st_dev, current.st_ino) == (info.st_dev, info.st_ino),
                    "scratch-boundary")
            if mode != 0o700:
                os.fchmod(fd, 0o700)
            current = work.lstat()
            require((current.st_dev, current.st_ino) == (info.st_dev, info.st_ino) and
                    stat.S_IMODE(os.fstat(fd).st_mode) == 0o700, "scratch-boundary")
        finally:
            os.close(fd)
    except OSError as error:
        raise audit.AuditError("scratch-boundary") from error


def pinned_file(path: Path, digest: str, mounts: list) -> None:
    readonly(path, mounts)
    resolved = path.resolve(strict=True)
    readonly(resolved, mounts)
    info = resolved.stat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= MAX_PIN_BYTES, "host-pin")
    audit.read_regular(resolved, MAX_PIN_BYTES, {
        "size": info.st_size, "digest": "sha256:" + digest,
    })


def verify_site(profile: dict, store: Path, mounts: list) -> None:
    readonly(Path("/etc/os-release"), mounts)
    os_path = Path("/etc/os-release")
    # /etc/os-release commonly is a symlink supplied by the runtime image.
    if os_path.is_symlink():
        os_path = os_path.resolve(strict=True)
        readonly(os_path, mounts)
    data = audit.read_regular(os_path, audit.CHUNK)
    require(hashlib.sha256(data).hexdigest() == profile["osReleaseSha256"], "os-pin")
    for pin in profile["hostFiles"]:
        path = canonical(pin["path"])
        require(not within(path, store) and not within(path, Path("/kq")), "host-pin")
        pinned_file(path, pin["sha256"], mounts)
    for external in profile["externals"]:
        path = canonical(external["prefix"])
        require(not within(path, store) and not within(store, path) and
                not within(path, Path("/kq")), "external-prefix")
        require(path.resolve(strict=True) == path and path.is_dir() and
                os.access(path, os.R_OK | os.X_OK), "external-prefix")
        readonly(path, mounts, subtree=True)


def verify_platform(profile: dict) -> None:
    import spack
    import spack.platforms
    import spack.vendor.archspec.cpu as cpu

    require(spack.__version__ == "1.0.0", "unsupported-spack-version")
    platform, operating_system, target = profile["target"].split("-")
    host = spack.platforms.host()
    require(host.name == platform and str(host.default_operating_system()) == operating_system,
            "platform-mismatch")
    current = cpu.host()
    require(target in cpu.TARGETS and
            target in {current.name, *(p.name for p in current.ancestors)}, "cpu-mismatch")


def verify_extra_attributes(attributes: object, pins: set) -> None:
    require(isinstance(attributes, dict), "external-attributes")
    compilers = attributes.get("compilers", {})
    require(isinstance(compilers, dict), "compiler-pin")
    for value in compilers.values():
        if value is not None:
            require(isinstance(value, str) and value in pins, "compiler-pin")
            require(os.access(value, os.R_OK | os.X_OK), "compiler-pin")
    pending, count = [attributes], 0
    while pending:
        value = pending.pop()
        count += 1
        require(count <= 4096, "external-attributes")
        if isinstance(value, dict):
            require(not any(k in {"module", "modules"} for k in value), "module-external")
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, str) and "/" in value:
            # Conservatively reject embedded paths/flags not individually pinned.
            require(value in pins, "compiler-pin")


def material_binding(input_dir: Path, request: dict) -> tuple:
    data = audit.read_regular(input_dir / "manifest.json", 2 * audit.MIB)
    require("sha256:" + hashlib.sha256(data).hexdigest() == request["manifestDigest"])
    manifest = audit.document(data)
    audit.validate_manifest(manifest)
    ref = manifest["lockfile"]
    data = audit.read_regular(input_dir / "blobs" / ref["digest"][7:], MAX_SPEC_BYTES)
    require(len(data) == ref["size"] and "sha256:" + hashlib.sha256(data).hexdigest() == ref["digest"])
    lock = audit.document(data)
    audit.validate_lock(lock, manifest)
    profile = request["siteProfile"]
    require(manifest["target"] == profile["target"], "target-mismatch")
    root_hash = lock["roots"][0]["hash"]
    require("external" not in lock["concrete_specs"][root_hash], "root-external")
    allowed = {e["hash"]: e["prefix"] for e in profile["externals"]}
    pins = {p["path"] for p in profile["hostFiles"]}
    for key, node in lock["concrete_specs"].items():
        arch = node["arch"]
        target = arch.get("target")
        if isinstance(target, dict):
            target = target.get("name")
        require("-".join(str(arch.get(k)) for k in ("platform", "platform_os")) +
                "-" + str(target) == profile["target"], "target-mismatch")
        if "external" in node:
            external = node["external"]
            require(isinstance(external, dict) and
                    set(external) <= {"path", "module", "extra_attributes"}, "external-binding")
            require(external.get("module") in (None, []), "module-external")
            require(key in allowed and external.get("path") == allowed[key], "external-binding")
            verify_extra_attributes(external.get("extra_attributes", {}), pins)
    return manifest, lock


def native_nodes(root: object) -> dict:
    import spack.hash_types

    nodes, pending = {}, [root]
    while pending:
        node = pending.pop()
        key = node.dag_hash()
        require(node.concrete and audit.matches(audit.HASH, key), "native-binding")
        require(node.spec_hash(spack.hash_types.dag_hash) == key, "native-hash")
        if key in nodes:
            continue
        nodes[key] = node
        require(len(nodes) <= 10_000, "native-binding")
        pending.extend(node.dependencies())
        if node.build_spec is not node:
            pending.append(node.build_spec)
    return nodes


def bind_native(root: object, lock: dict, profile: dict) -> dict:
    require(root.dag_hash() == lock["roots"][0]["hash"], "native-root")
    nodes = native_nodes(root)
    require(set(nodes) == set(lock["concrete_specs"]), "native-dag")
    for key, spec in nodes.items():
        node = lock["concrete_specs"][key]
        require(spec.name == node["name"] and str(spec.version) == node["version"] and
                spec.namespace == node["namespace"] and str(spec.architecture) == profile["target"],
                "native-binding")
        require(bool(spec.external) == ("external" in node), "native-external")
        if spec.external:
            external = node["external"]
            require(not spec.external_modules and str(spec.external_path) == external["path"] and
                    spec.extra_attributes == external.get("extra_attributes", {}),
                    "native-external")
    return nodes


def configuration(work: Path, nodes: dict, target_arch: str) -> dict:
    import spack.vendor.archspec.cpu as cpu

    _, _, cpu_name = target_arch.split("-")
    require(cpu_name in cpu.TARGETS, "cpu-mismatch")
    # Spack 1.0 filters generic targets by vendor, not by architecture family.
    granularity = "generic" if cpu.TARGETS[cpu_name].vendor == "generic" else "microarchitectures"
    data = audit.configuration(work)
    data["config"].update({
        "install_tree": {"root": str(work / "solver-store")},
        "concretization_cache": {"enable": False},
        "verify_ssl": True, "dirty": False, "build_jobs": 2,
        "locks": True, "allow_sgid": False, "build_language": "C",
        "license_dir": str(work / "licenses"), "test_stage": str(work / "test-stage"),
        "shared_linking": {"type": "rpath", "bind": False, "missing_library_policy": "error"},
        "flags": {"keep_werror": "none"}, "url_fetch_method": "urllib",
    })
    data["concretizer"] = {
        "reuse": False, "unify": True, "splice": {"automatic": False},
        "targets": {"host_compatible": True, "granularity": granularity},
    }
    data["modules"] = {"default": {"enable": []}}
    data["packages"]["all"] = {
        "permissions": {"read": "world", "write": "user"},
        # Pure build dependencies do not inherit the root architecture in Spack 1.0.
        "require": ["arch=" + target_arch],
    }
    for spec in nodes.values():
        if spec.external:
            entry = data["packages"].setdefault(spec.name, {"buildable": False, "externals": []})
            external = spec.copy(deps=False)
            # Native patch ordering is solver output, not a packages.yaml input variant.
            external.variants.pop("patches", None)
            # str(concrete_spec) includes /hash and would shortcut the solver.
            # Spack 1.0 external namespace conditions can self-cycle; bind_native checks it.
            entry["externals"].append({
                "spec": external.format("{name}{@version}{variants}{compiler_flags}"
                                        " arch={architecture}"),
                "prefix": str(spec.external_path),
                "extra_attributes": copy.deepcopy(spec.extra_attributes),
            })
    return data


@contextlib.contextmanager
def replace_attribute(owner: object, name: str, replacement: object):
    original = getattr(owner, name)
    setattr(owner, name, replacement)
    try:
        yield original
    finally:
        setattr(owner, name, original)


def solve_lock(manifest: dict, lock: dict, profile: dict) -> None:
    import spack.compilers.config
    import spack.concretize
    import spack.solver.core
    import spack.spec

    # Do not let the lazy native solver bootstrap a missing clingo installation.
    clingo = importlib.import_module("clingo")
    require(hasattr(clingo, "Symbol"), "solver-unavailable")
    importlib.import_module("clingo.ast")

    def no_bootstrap():
        raise audit.AuditError("solver-unavailable")

    original = spack.compilers.config.all_compilers

    def pinned_compilers(scope=None, init_config=True):
        return original(scope=scope, init_config=False)

    abstract = spack.spec.Spec(manifest["spec"])
    require(all(not n.concrete and not n.abstract_hash for n in abstract.traverse()),
            "solver-hash-shortcut")
    abstract.constrain(spack.spec.Spec("arch=" + profile["target"]))
    with replace_attribute(spack.compilers.config, "all_compilers", pinned_compilers):
        with replace_attribute(spack.solver.core, "_bootstrap_clingo", no_bootstrap):
            solved = spack.concretize.concretize_one(abstract, tests=False)
    # No lock writes, relaxed comparison, reuse of concrete inputs, or fallback.
    bind_native(solved, lock, profile)


def approved_path(path: Path, profile: dict) -> bool:
    if any(path == Path(pin["path"]).resolve(strict=True) for pin in profile["hostFiles"]):
        return True
    return any(within(path, Path(e["prefix"])) for e in profile["externals"])


def verify_tree(store: Path, profile: dict) -> None:
    require(store.resolve(strict=True) == store and store.is_dir(), "output-tree")
    pending, entries, metadata = [(store, 0)], 0, 0
    while pending:
        directory, depth = pending.pop()
        require(depth <= 64, "output-budget")
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o022, "output-mode")
        with os.scandir(directory) as children:
            for child in children:
                entries += 1
                require(entries <= MAX_ENTRIES, "output-budget")
                path = Path(child.path)
                metadata += len(os.fsencode(path)) + 256
                require(len(os.fsencode(path)) <= 4096 and metadata <= MAX_METADATA_BYTES,
                        "output-budget")
                info = child.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    require(not within(path, store / ".spack-db"), "database-path")
                    target = os.readlink(path)
                    require(len(os.fsencode(target)) <= 4096, "output-budget")
                    metadata += len(os.fsencode(target))
                    require(metadata <= MAX_METADATA_BYTES, "output-budget")
                    resolved = resolved_path(path)
                    require(not within(resolved, Path("/kq")), "output-symlink")
                    require(approved_path(resolved, profile) or
                            within(resolved, store), "output-symlink")
                    continue
                require(not info.st_mode & (0o022 | stat.S_ISUID | stat.S_ISGID), "output-mode")
                if stat.S_ISDIR(info.st_mode):
                    pending.append((path, depth + 1))
                else:
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "output-file")
                    if child.name in {"spec.json", "spec.yaml", "index.json", "index.json.backup"}:
                        maximum = MAX_DB_BYTES if child.name.startswith("index.") else MAX_SPEC_BYTES
                        require(info.st_size <= maximum, "metadata-budget")
                        metadata += info.st_size
                        require(metadata <= MAX_METADATA_BYTES, "metadata-budget")
                    elif within(path, store / ".spack-db"):
                        require(info.st_size <= audit.CHUNK, "metadata-budget")
                        metadata += info.st_size
                        require(metadata <= MAX_METADATA_BYTES, "metadata-budget")


def database_metadata(store: Path) -> None:
    directory = store / ".spack-db"
    require(directory.resolve(strict=True) == directory and directory.is_dir(), "database-path")
    audit.read_regular(directory / "index.json", MAX_DB_BYTES)


def verify_installed(store: object, root: object, nodes: dict, store_path: Path) -> object:
    import spack.hash_types
    import spack.spec

    result = None
    with store.db.read_transaction():
        for key, node in nodes.items():
            if node.external:
                continue
            upstream, record = store.db.query_by_spec_hash(key)
            require(not upstream and record is not None and record.installed is True and
                    not record.deprecated_for, "not-installed")
            spec = record.spec
            require(spec.concrete and not spec.external and spec.dag_hash() == key and
                    spec.spec_hash(spack.hash_types.dag_hash) == key, "installed-hash")
            require(spec.name == node.name and str(spec.version) == str(node.version) and
                    str(spec.architecture) == str(node.architecture), "installed-binding")
            prefix = canonical(record.path)
            require(prefix != store_path and within(prefix, store_path) and
                    prefix.resolve(strict=True) == prefix and prefix.is_dir(), "installed-prefix")
            require(str(spec.prefix) == str(prefix) == str(node.prefix), "installed-prefix")
            metadata = prefix / ".spack/spec.json"
            require(metadata.parent.resolve(strict=True) == metadata.parent, "installed-prefix")
            data = audit.read_regular(metadata, MAX_SPEC_BYTES)
            disk_spec = spack.spec.Spec.from_json(data.decode("utf-8"))
            disk_nodes = native_nodes(disk_spec)
            require(disk_spec.dag_hash() == key and set(disk_nodes) == set(native_nodes(node)),
                    "installed-spec")
            require(all(k in nodes for k in disk_nodes), "installed-spec")
            if key == root.dag_hash():
                result = spec
    require(result is not None, "not-installed")
    return result


def run(input_dir: Path, work: Path) -> dict:
    audit.verify_runtime_boundary(input_dir, memory_limit=4294967296)
    request = read_request(input_dir)
    profile, store_path_value = request["siteProfile"], Path(request["storePath"])
    mounts = mount_table()
    verify_store(request, mounts)
    verify_scratch(input_dir, work, store_path_value, mounts)
    verify_site(profile, store_path_value, mounts)
    verify_platform(profile)
    manifest, lock = material_binding(input_dir, request)
    verify_tree(store_path_value, profile)
    if request["action"] != "install" or (store_path_value / ".spack-db").exists():
        database_metadata(store_path_value)

    previous_umask = os.umask(0o022)
    try:
        report = audit.audit(input_dir, work, request["manifestDigest"])
        require(report.get("passed") is True, "source-audit-failed")
        require(report.get("manifestDigest") == request["manifestDigest"] and
                report.get("rootHash") == lock["roots"][0]["hash"], "source-audit-binding")
        import spack.config
        import spack.environment
        import spack.installer
        import spack.repo
        import spack.stage
        import spack.store
        import spack.user_environment

        recipes = [str(work / ("recipe-" + str(i)) / root)
                   for i, recipe in enumerate(manifest["recipes"]) for root in recipe["roots"]]
        initial = spack.config.InternalConfigScope("kq", audit.configuration(work))
        with spack.config.use_configuration(initial):
            with spack.repo.use_repositories(*recipes, override=True):
                with spack.environment.Environment(str(work / "env")) as env:
                    roots = list(env.concrete_roots())
                    require(len(roots) == 1, "native-root")
                    nodes = bind_native(roots[0], lock, profile)
        scope = spack.config.InternalConfigScope("kq", configuration(work, nodes, profile["target"]))
        with spack.config.use_configuration(scope):
            with spack.repo.use_repositories(*recipes, override=True):
                with spack.store.use_store(work / "solver-store"):
                    solve_lock(manifest, lock, profile)
                with spack.store.use_store(store_path_value) as store:
                    # Reload specs under the real store, never keep audit/scratch prefixes.
                    with spack.environment.Environment(str(work / "env")) as env:
                        roots = list(env.concrete_roots())
                        require(len(roots) == 1, "native-root")
                        root = roots[0]
                        nodes = bind_native(root, lock, profile)
                        if request["action"] == "install":
                            # Fork is required for the Stage.fetch guard to reach build children.
                            multiprocessing.set_start_method("fork", force=True)
                            fetch = spack.stage.Stage.fetch

                            def mirror_fetch(stage, mirror_only=False, err_msg=None):
                                return fetch(stage, mirror_only=True, err_msg=err_msg)

                            with replace_attribute(spack.stage.Stage, "fetch", mirror_fetch):
                                spack.installer.PackageInstaller(
                                    [root.package], use_cache=False, fail_fast=True,
                                    package_use_cache=False, dependencies_use_cache=False,
                                    explicit=True, include_build_deps=True,
                                    install_deps=True, install_package=True,
                                ).install()
                        verify_tree(store_path_value, profile)
                        database_metadata(store_path_value)
                        installed = verify_installed(store, root, nodes, store_path_value)
                        bind_native(installed, lock, profile)
                        result = {
                            "version": 1, "validation": "isolated-install",
                            "action": request["action"],
                            "manifestDigest": request["manifestDigest"],
                            "siteProfileDigest": request["siteProfileDigest"],
                            "storePath": str(store_path_value),
                            "root": {"name": root.name, "version": str(root.version),
                                     "hash": root.dag_hash(), "arch": str(root.architecture),
                                     "spec": manifest["spec"]},
                            "prefix": str(installed.prefix),
                            "installedHashes": sorted(k for k, n in nodes.items() if not n.external),
                        }
                        if request["action"] == "load":
                            modifications = spack.user_environment.environment_modifications_for_specs(
                                installed
                            )
                            shell = modifications.shell_modifications("sh")
                            require(isinstance(shell, str) and len(shell) <= 256 * 1024 and
                                    "\x00" not in shell and "/kq/" not in shell, "load-shell")
                            result["loadShell"] = shell
                        return result
    finally:
        os.umask(previous_umask)


@contextlib.contextmanager
def native_output():
    """Drain fd 1/2 without buffering secrets, then emit only a fixed log code."""
    read_fd, write_fd = os.pipe()
    saved_out, saved_err = os.dup(1), os.dup(2)
    observed = []

    def drain():
        with os.fdopen(read_fd, "rb", buffering=0) as stream:
            while stream.read(audit.CHUNK):
                if not observed:
                    observed.append(True)

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        os.dup2(write_fd, 1)
        os.dup2(write_fd, 2)
        with os.fdopen(write_fd, "w", buffering=1) as output:
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                yield
    finally:
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        os.close(saved_out)
        os.close(saved_err)
        reader.join()
        if observed:
            print("spack-native-output", file=sys.stderr)


def main(input_dir: Path = Path("/kq/input"), work_dir: Path = Path("/kq/work")) -> int:
    try:
        require(len(sys.argv) == 1)
        with native_output():
            result = run(Path(input_dir), Path(work_dir))
        print("KQ_SPACK_INSTALL_RESULT:" + json.dumps(result, separators=(",", ":")))
        return 0
    except (Exception, SystemExit):
        print("install-worker-failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

"""Container-only Spack 1.0.0 source audit; never a recipe trust certificate.

Entrypoint: spack python /kq/input/source_audit.py sha256:<manifest digest>.
The parent owns isolation, timeout and report validation. Recipes are arbitrary
Python and can forge output inside that boundary. No install/concretize/expand.
"""

import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import stat
import sys
import tarfile

CHUNK = 64 * 1024
MIB = 1024 ** 2
TAR_BYTES, TAR_ENTRIES, TAR_EXPANDED = 128 * MIB, 50_000, 256 * MIB
RECIPE_TOTAL = 512 * MIB
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
HASH = re.compile(r"[a-z2-7]{32}")


class AuditError(Exception):
    """Only fixed, non-sensitive codes may cross the report boundary."""


def require(condition: object, code: str = "invalid-input") -> None:
    if not condition:
        raise AuditError(code)


def matches(pattern: object, value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def document(data: bytes) -> dict:
    def pairs(items: list) -> dict:
        result = {}
        for key, value in items:
            require(key not in result and key not in {"include_concrete", "develop", "dev_path"})
            result[key] = value
        return result
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=pairs,
                           parse_constant=lambda _: require(False))
        require(isinstance(value, dict))
        return value
    except (ValueError, RecursionError) as error:
        raise AuditError("invalid-input") from error


def relative(value: object, allow_root: bool = False) -> str:
    require(isinstance(value, str) and 0 < len(value) <= 512)
    if allow_root and value == ".":
        return value
    require(all(matches(r"[A-Za-z0-9_.+-]+", p) and p not in {".", "..", ".git"}
                for p in value.split("/")))
    return value


def read_regular(path: Path, maximum: int, expected: dict = None) -> bytes:
    """Hash large blobs without buffering; buffer only bounded metadata."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= maximum)
            if expected is not None:
                require(info.st_size == expected["size"])
            size, hasher, chunks = 0, hashlib.sha256(), []
            while chunk := stream.read(CHUNK):
                size += len(chunk)
                require(size <= maximum)
                hasher.update(chunk)
                if expected is None:
                    chunks.append(chunk)
            require(size == info.st_size)
            if expected is not None:
                require("sha256:" + hasher.hexdigest() == expected["digest"])
            return b"".join(chunks)
    except OSError as error:
        raise AuditError("invalid-input") from error


def verify_runtime_boundary(input_dir: Path) -> None:
    """Fail closed on missing namespace/cgroup evidence; never probe a runtime."""
    try:
        require(sys.platform == "linux" and os.getuid() > 0, "runtime-boundary")
        metadata = document(read_regular(Path(input_dir) / "runtime.json", CHUNK))
        require(set(metadata) == {"hostNetworkNamespace", "hostPidNamespace"})
        for kind, key in (("net", "hostNetworkNamespace"), ("pid", "hostPidNamespace")):
            current = os.readlink("/proc/self/ns/" + kind)
            require(matches(kind + r":\[[0-9]+\]", metadata[key]))
            require(matches(kind + r":\[[0-9]+\]", current) and current != metadata[key])
        require(sorted(name for _, name in socket.if_nameindex()) == ["lo"])
        require(re.search(r"^NoNewPrivs:\s+1\s*$",
                          Path("/proc/self/status").read_text(), re.MULTILINE))
        groups = Path("/proc/self/cgroup").read_text().splitlines()
        require(len(groups) == 1 and groups[0].startswith("0::/"))
        group = groups[0][3:]
        require(group == "/" or all(p not in {"", ".", ".."} for p in group[1:].split("/")))
        mounts = []
        for line in Path("/proc/self/mountinfo").read_text().splitlines():
            before, separator, after = line.partition(" - ")
            fields = before.split()
            filesystem = after.split()
            require(separator and len(fields) >= 6 and len(filesystem) >= 3)
            decode = lambda s: re.sub(r"\\(040|011|012|134)",
                                      lambda m: chr(int(m[1], 8)), s)
            root, mount = decode(fields[3]), decode(fields[4])
            require(not mount.startswith("/sys/fs/cgroup/"))
            if mount == "/sys/fs/cgroup":
                # Bind read-only is a VFS property; its superblock may remain rw.
                options = fields[5].split(",")
                require(filesystem[0] == "cgroup2" and "ro" in options and "rw" not in options)
                require(root.startswith("/") and ".." not in root.split("/"))
                mounts.append((root, mount))
            else:
                require(filesystem[0] != "cgroup2")
        require(len(mounts) == 1)
        root, mount = mounts[0]
        # relative_to rejects mismatched roots; do not substitute the mount root.
        cgroup = Path(mount) / PurePosixPath(group).relative_to(root)
        for name, limit in (("memory.max", 2147483648), ("pids.max", 128)):
            text = (cgroup / name).read_text().strip()
            require(matches(r"[0-9]+", text) and 0 < int(text) <= limit)
        require((cgroup / "memory.swap.max").read_text().strip() == "0")
        cpu = (cgroup / "cpu.max").read_text().split()
        require(len(cpu) == 2 and all(matches(r"[0-9]+", n) for n in cpu))
        quota, period = map(int, cpu)
        require(quota > 0 and period > 0 and quota <= 2 * period)
    except (AuditError, OSError, ValueError, IndexError) as error:
        raise AuditError("runtime-boundary") from error


def validate_manifest(manifest: dict) -> dict:
    require(set(manifest) == {"version", "repository", "spec", "spackVersion", "target",
                              "redistribution", "recipes", "sources", "lockfile"})
    require(type(manifest["version"]) is int and manifest["version"] == 1)
    require(manifest["spackVersion"] == "1.0.0" and manifest["redistribution"] == "unrestricted")
    for field, limit in (("spec", 4096), ("target", 256), ("repository", 400)):
        require(isinstance(manifest[field], str) and 0 < len(manifest[field]) <= limit)
    require(manifest["spec"].strip() == manifest["spec"])
    require(matches(r"(public/[a-z0-9][a-z0-9._-]*|(?:org|user)/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*)",
                    manifest["repository"]))
    refs, paths = {}, set()

    def blob(ref: dict, maximum: int = 16 * 1024 ** 3) -> None:
        require(isinstance(ref, dict) and set(ref) == {"digest", "size"})
        require(matches(DIGEST, ref["digest"]))
        require(type(ref["size"]) is int and 0 < ref["size"] <= maximum)
        require(ref["digest"] not in refs or refs[ref["digest"]] == ref)
        refs[ref["digest"]] = ref

    blob(manifest["lockfile"], 16 * MIB)
    require(isinstance(manifest["sources"], list) and 1 <= len(manifest["sources"]) <= 10_000)
    for source in manifest["sources"]:
        require(isinstance(source, dict) and set(source) == {"path", "blob"})
        path = relative(source["path"])
        require(path not in paths)
        paths.add(path)
        blob(source["blob"])
    for path in paths:
        require(not any(str(parent) in paths for parent in PurePosixPath(path).parents))
    require(sum(s["blob"]["size"] for s in manifest["sources"]) <= 512 * 1024 ** 3)
    require(isinstance(manifest["recipes"], list) and 1 <= len(manifest["recipes"]) <= 32)
    for recipe in manifest["recipes"]:
        require(isinstance(recipe, dict) and set(recipe) == {"repositoryId", "commit", "roots", "archive"})
        require(matches(r"[a-f0-9]{64}", recipe["repositoryId"]) and matches(r"[a-f0-9]{40}", recipe["commit"]))
        roots = recipe["roots"]
        require(isinstance(roots, list) and 1 <= len(roots) <= 32)
        for root in roots:
            relative(root, allow_root=True)
        require(len(set(roots)) == len(roots))
        blob(recipe["archive"], TAR_BYTES)
    require(sum(ref["size"] for ref in refs.values()) <= 512 * 1024 ** 3)
    return refs


class BoundedTarInfo(tarfile.TarInfo):
    def _proc_member(self, archive: tarfile.TarFile):
        # Guard before tarfile allocates PAX payloads or recursively parses them.
        archive.kq_headers = getattr(archive, "kq_headers", 0) + 1
        depth = getattr(archive, "kq_depth", 0)
        require(archive.kq_headers <= TAR_ENTRIES and depth < 8)
        require(self.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE,
                             tarfile.XHDTYPE, tarfile.XGLTYPE))
        require(0 <= self.size <= (CHUNK if self.type in (tarfile.XHDTYPE, tarfile.XGLTYPE)
                                  else TAR_EXPANDED))
        archive.kq_depth = depth + 1
        try:
            return super()._proc_member(archive)
        finally:
            archive.kq_depth = depth


def extract_recipe(path: Path, destination: Path, remaining_budget: int) -> int:
    total, seen, files, directories = 0, set(), set(), set()
    destination.mkdir(mode=0o700)
    try:
        with tarfile.open(path, mode="r|*", tarinfo=BoundedTarInfo) as archive:
            for member in archive:
                require(not member.sparse and set(member.pax_headers) <=
                        {"path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "comment"})
                require(member.isdir() or member.isreg())
                name = relative(member.name.rstrip("/") if member.isdir() else member.name)
                require(name not in seen and 0 <= member.size <= TAR_EXPANDED)
                seen.add(name)
                parents = {str(p) for p in PurePosixPath(name).parents if str(p) != "."}
                require(not parents.intersection(files))
                if member.isdir():
                    require(name not in files and member.size == 0)
                    directories.add(name)
                else:
                    require(name not in directories)
                    files.add(name)
                directories.update(parents)
                total += member.size
                require(total <= min(TAR_EXPANDED, remaining_budget))
                target = destination / name
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if member.isdir():
                    target.mkdir(exist_ok=True, mode=0o700)
                    continue
                with archive.extractfile(member) as source, target.open("xb") as output:
                    remaining = member.size
                    while remaining:
                        chunk = source.read(min(CHUNK, remaining))
                        require(chunk)
                        output.write(chunk)
                        remaining -= len(chunk)
                target.chmod(0o400)
    except (OSError, tarfile.TarError, ValueError, OverflowError) as error:
        raise AuditError("invalid-input") from error
    return total


def validate_lock(lock: dict, manifest: dict) -> None:
    require(lock.get("_meta") == {"file-type": "spack-lockfile", "lockfile-version": 6,
                                 "specfile-version": 5})
    require(isinstance(lock.get("spack"), dict) and lock["spack"].get("version") == "1.0.0")
    nodes, roots = lock.get("concrete_specs"), lock.get("roots")
    require(isinstance(nodes, dict) and 1 <= len(nodes) <= 10_000)
    require(isinstance(roots, list) and len(roots) == 1 and isinstance(roots[0], dict))
    require(roots[0].get("spec") == manifest["spec"] and matches(HASH, roots[0].get("hash")))
    require(roots[0]["hash"] in nodes)
    graph, count = {}, 0
    for key, node in nodes.items():
        require(matches(HASH, key) and isinstance(node, dict) and node.get("hash") == key)
        require(all(isinstance(node.get(f), str) and node[f] for f in ("name", "version", "namespace")))
        require(isinstance(node.get("parameters"), dict) and isinstance(node.get("arch"), dict))
        require(node.get("concrete", True) is True and "compiler" not in node)
        refs = node.get("dependencies", [])
        require(isinstance(refs, list))
        refs = refs + ([node["build_spec"]] if "build_spec" in node else [])
        graph[key] = []
        for ref in refs:
            require(isinstance(ref, dict) and matches(HASH, ref.get("hash")) and ref["hash"] in nodes)
            require(ref.get("name") == nodes[ref["hash"]].get("name"))
            graph[key].append(ref["hash"])
        count += len(refs)
        require(count <= 100_000)
    colors, stack = {}, [(roots[0]["hash"], False)]
    while stack:
        key, exiting = stack.pop()
        if exiting:
            colors[key] = 2
            continue
        require(colors.get(key) != 1)
        if colors.get(key) == 2:
            continue
        colors[key] = 1
        stack.append((key, True))
        stack.extend((child, False) for child in reversed(graph[key]))
    require(set(colors) == set(nodes))


def prepare_input(input_dir: Path, work_dir: Path, expected_digest: str) -> tuple:
    input_dir, work_dir = Path(input_dir), Path(work_dir)
    require(matches(DIGEST, expected_digest))
    for directory in (input_dir, input_dir / "blobs", work_dir):
        require(directory.is_absolute() and not directory.is_symlink() and directory.is_dir())
    require(not list(work_dir.iterdir()) and work_dir.stat().st_mode & 0o077 == 0)
    data = read_regular(input_dir / "manifest.json", 2 * MIB)
    require("sha256:" + hashlib.sha256(data).hexdigest() == expected_digest)
    manifest = document(data)
    refs = validate_manifest(manifest)
    for ref in refs.values():
        read_regular(input_dir / "blobs" / ref["digest"][7:], ref["size"], ref)
    lock_bytes = read_regular(input_dir / "blobs" / manifest["lockfile"]["digest"][7:], 16 * MIB)
    require("sha256:" + hashlib.sha256(lock_bytes).hexdigest() == manifest["lockfile"]["digest"])
    lock = document(lock_bytes)
    validate_lock(lock, manifest)
    roots, expanded = [], 0
    for index, recipe in enumerate(manifest["recipes"]):
        destination = work_dir / ("recipe-" + str(index))
        expanded += extract_recipe(input_dir / "blobs" / recipe["archive"]["digest"][7:],
                                   destination, RECIPE_TOTAL - expanded)
        require(expanded <= RECIPE_TOTAL)
        for root in recipe["roots"]:
            selected = destination / root
            require((selected / "repo.yaml").is_file())
            roots.append(str(selected))
    (work_dir / "mirror").mkdir(mode=0o700)
    for source in manifest["sources"]:
        target = work_dir / "mirror" / source["path"]
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # These are the only generated symlinks; archives can never create links.
        target.symlink_to(input_dir / "blobs" / source["blob"]["digest"][7:])
    (work_dir / "env").mkdir(mode=0o700)
    (work_dir / "env/spack.yaml").write_text(json.dumps({"spack": {"specs": [manifest["spec"]], "view": False}}))
    (work_dir / "env/spack.lock").write_bytes(lock_bytes)
    return manifest, lock, roots


def configuration(work: Path) -> dict:
    return {
        "bootstrap": {"enable": False, "root": str(work / "bootstrap"), "sources": []},
        "config": {"checksum": True, "build_stage": [str(work / "stage")],
                   "source_cache": str(work / "source-cache"), "misc_cache": str(work / "misc-cache"),
                   "install_tree": {"root": str(work / "store")}},
        "mirrors": {"kq": (work / "mirror").as_uri()},
        "upstreams": {}, "repos": {}, "packages": {},
    }


def audit(input_dir: Path, work_dir: Path, expected_digest: str) -> dict:
    manifest, lock, roots = prepare_input(input_dir, work_dir, expected_digest)
    # Imports and all recipe loading are deferred until every input is verified.
    import spack
    import spack.config
    import spack.environment
    import spack.fetch_strategy as fetch
    import spack.hash_types
    import spack.repo
    import spack.spec

    require(spack.__version__ == "1.0.0", "unsupported-spack-version")
    nodes, root_hash = lock["concrete_specs"], lock["roots"][0]["hash"]
    report = {"version": 1, "validation": "isolated-source-audit", "manifestDigest": expected_digest,
              "spackVersion": "1.0.0", "rootHash": root_hash, "nodeCount": len(nodes),
              "externalCount": sum("external" in n for n in nodes.values()),
              "verifiedNodeCount": 0, "passed": True, "issues": []}

    def issue(code: str, key: str = None, severity: str = "error") -> None:
        if severity == "error":
            report["passed"] = False
        if len(report["issues"]) >= 100:
            report["passed"] = False
            report["issues"][-1] = {"severity": "error", "code": "issue-limit"}
        else:
            report["issues"].append({"severity": severity, "code": code, **({"hash": key} if key else {})})

    issue("host-target-unverified", severity="warning")
    issue("solver-unverified", severity="warning")
    scope = spack.config.InternalConfigScope("kq", configuration(Path(work_dir)))
    with spack.config.use_configuration(scope), spack.repo.use_repositories(*roots, override=True) as repos:
        require(len(repos.repos) == len(roots), "invalid-repository")
        namespaces = [r.namespace for r in repos.repos]
        require(len(set(namespaces)) == len(namespaces), "duplicate-namespace")
        with spack.environment.Environment(str(Path(work_dir) / "env")) as env:
            concrete_roots = list(env.concrete_roots())
            require(len(concrete_roots) == 1, "native-root-mismatch")
            root = concrete_roots[0]
            require(root.dag_hash() == root_hash, "native-root-mismatch")
            if not root.satisfies(spack.spec.Spec(manifest["spec"])):
                issue("root-spec-mismatch", root_hash)
                return report
            if str(root.version) != nodes[root_hash]["version"] or str(root.architecture) != manifest["target"]:
                issue("root-binding-mismatch", root_hash)
                return report
            declared, pending = {}, [root]
            while pending:
                node = pending.pop()
                key = node.dag_hash()
                require(key in nodes, "native-node-mismatch")
                if key in declared:
                    continue
                declared[key] = node
                pending.extend(node.dependencies())
                if node.build_spec is not node:
                    pending.append(node.build_spec)
            require(set(declared) == set(nodes), "native-node-mismatch")
            for key, spec in declared.items():
                code = "node-verification-failed"
                try:
                    require(spec.concrete and spec.name == nodes[key]["name"] and
                            spec.namespace == nodes[key]["namespace"] and str(spec.version) == nodes[key]["version"])
                    require(bool(spec.external) == ("external" in nodes[key]))
                    code = "dag-hash-mismatch"
                    require(spec.spec_hash(spack.hash_types.dag_hash) == key)
                    if spec.external:
                        issue("external-unverified", key, "warning")
                        continue
                    code = "package-hash-unsupported"
                    require(isinstance(nodes[key].get("package_hash"), str) and nodes[key]["package_hash"])
                    code = "source-verification-failed"
                    pkg = spec.package
                    list(spec.patches)  # Native FilePatch lookup verifies its recorded SHA-256.
                    stages = list(pkg.stage)
                    require(stages)
                    for stage in stages:
                        if isinstance(stage.default_fetcher, fetch.BundleFetchStrategy):
                            continue
                        code = "unsupported-fetcher"
                        require(isinstance(stage.default_fetcher, fetch.URLFetchStrategy) and
                                not isinstance(stage.default_fetcher, fetch.FetchAndVerifyExpandedFile) and
                                stage.default_fetcher.digest and not stage.skip_checksum_for_mirror)
                        code = "source-verification-failed"
                        require(spack.config.get("config:checksum") is True)
                        stage.create()
                        stage.fetch(mirror_only=True)
                        code = "unsupported-fetcher"
                        require(not stage.skip_checksum_for_mirror and
                                isinstance(stage.fetcher, fetch.URLFetchStrategy) and
                                not isinstance(stage.fetcher, fetch.FetchAndVerifyExpandedFile) and stage.fetcher.digest)
                        code = "source-verification-failed"
                        require(spack.config.get("config:checksum") is True)
                        stage.check()
                    code = "package-hash-mismatch"
                    require(pkg.content_hash() == nodes[key]["package_hash"])
                    report["verifiedNodeCount"] += 1
                except (Exception, SystemExit):
                    issue(code, key)
    return report


def main(input_dir: Path = Path("/kq/input"), work_dir: Path = Path("/kq/work")) -> int:
    try:
        require(len(sys.argv) == 2 and matches(DIGEST, sys.argv[1]))
        # Capture native subprocess stdout too; only the final record uses fd 1.
        saved = os.dup(1)
        try:
            os.dup2(2, 1)
            with contextlib.redirect_stdout(sys.stderr):
                verify_runtime_boundary(Path(input_dir))
                result = audit(Path(input_dir), Path(work_dir), sys.argv[1])
        finally:
            os.dup2(saved, 1)
            os.close(saved)
        print("KQ_SPACK_AUDIT_RESULT:" + json.dumps(result, separators=(",", ":")))
        return 0 if result["passed"] else 1
    except (Exception, SystemExit):
        print("source-audit-failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

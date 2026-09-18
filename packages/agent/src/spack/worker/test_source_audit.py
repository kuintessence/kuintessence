"""Offline fixtures only: no installed Spack, executable recipes, or network."""

import contextlib
import copy
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

import source_audit as audit


ROOT_HASH = "a" * 32
DEP_HASH = "b" * 32
PACKAGE_HASH = "c" * 52 + "===="


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def archive(entries, **kwargs):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", **kwargs) as stream:
        for name, data, kind in entries:
            item = tarfile.TarInfo(name)
            item.type = kind
            item.size = len(data) if kind == tarfile.REGTYPE else 0
            item.linkname = "/outside" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""
            stream.addfile(item, io.BytesIO(data))
    return output.getvalue()


def recipe(root=".", namespace="fixture"):
    prefix = "" if root == "." else root + "/"
    return [
        (prefix + "repo.yaml", ("repo:\n  namespace: " + namespace).encode(), tarfile.REGTYPE),
        (prefix + "packages/hello/package.py", b"raise RuntimeError('NEVER EXECUTE')", tarfile.REGTYPE),
    ]


class URLFetcher:
    def __init__(self, value="e" * 64):
        self.digest = value


class BundleFetcher:
    pass


class ExpandedFileFetcher(URLFetcher):
    def expand(self):
        raise AssertionError("Source archives must never be expanded")


class FakeStage:
    def __init__(self, native, path, fetcher=None):
        self.native = native
        self.material = path
        self.default_fetcher = fetcher or URLFetcher()
        self.fetcher = self.default_fetcher
        self.skip_checksum_for_mirror = False

    def create(self):
        self.native.calls.append(("create", self.material))

    def fetch(self, *, mirror_only):
        self.native.calls.append(("fetch", self.material, mirror_only))
        assert mirror_only is True
        assert self.native.config["config"]["checksum"] is True
        mirror = self.native.work / "mirror" / self.material
        if not mirror.is_file():
            raise RuntimeError("SECRET https://private.example/missing")

    def check(self):
        self.native.calls.append(("check", self.material))
        assert self.native.config["config"]["checksum"] is True
        if self.native.check_error:
            raise RuntimeError("SECRET CHECKSUM")


class FakeSpec:
    def __init__(self, native, key, node):
        self.native, self.key, self.node = native, key, node
        self.name = node["name"]
        self.namespace = node["namespace"]
        self.version = node["version"]
        self.architecture = "linux-ubuntu24.04-x86_64"
        self.concrete = True
        self.external = "external" in node
        self.package = types.SimpleNamespace(
            stage=native.stages, content_hash=lambda: native.package_hash
        )

    def dag_hash(self):
        return self.key

    def spec_hash(self, descriptor):
        assert descriptor is self.native.hash_descriptor
        return self.native.recomputed_hash or self.key

    def satisfies(self, constraint):
        self.native.calls.append(("satisfies", constraint))
        return self.native.satisfies

    def dependencies(self):
        return [self.native.nodes[d["hash"]] for d in self.node.get("dependencies", [])]

    @property
    def build_spec(self):
        ref = self.node.get("build_spec")
        return self.native.nodes[ref["hash"]] if ref else self

    @property
    def patches(self):
        self.native.calls.append(("patches", self.key))
        if self.native.patch_error:
            raise RuntimeError("SECRET local FilePatch checksum mismatch")
        return []


class Native:
    def __init__(self, work, lock):
        self.work, self.calls = work, []
        self.config = None
        self.package_hash = PACKAGE_HASH
        self.recomputed_hash = None
        self.satisfies = True
        self.patch_error = self.check_error = False
        self.hash_descriptor = object()
        self.stages = [FakeStage(self, name) for name in ("source.tar", "resource.tar", "patch.diff")]
        self.nodes = {key: FakeSpec(self, key, node) for key, node in lock["concrete_specs"].items()}
        self.roots = [self.nodes[lock["roots"][0]["hash"]]]
        self.modules = {"spack": types.ModuleType("spack")}
        self.modules["spack"].__version__ = "1.0.0"
        for name in ("config", "repo", "environment", "spec", "fetch_strategy", "hash_types"):
            module = types.ModuleType("spack." + name)
            self.modules["spack." + name] = module
            setattr(self.modules["spack"], name, module)
        self.modules["spack.config"].InternalConfigScope = (
            lambda name, data: types.SimpleNamespace(name=name, data=data)
        )
        self.modules["spack.config"].use_configuration = self.configuration
        self.modules["spack.config"].get = self.get_config
        self.modules["spack.repo"].use_repositories = self.repositories
        self.modules["spack.environment"].Environment = self.environment
        self.modules["spack.spec"].Spec = lambda text: text
        self.modules["spack.fetch_strategy"].URLFetchStrategy = URLFetcher
        self.modules["spack.fetch_strategy"].BundleFetchStrategy = BundleFetcher
        self.modules["spack.fetch_strategy"].FetchAndVerifyExpandedFile = ExpandedFileFetcher
        self.modules["spack.hash_types"].dag_hash = self.hash_descriptor

    def get_config(self, path):
        section, key = path.split(":")
        return self.config[section][key]

    @contextlib.contextmanager
    def configuration(self, scope):
        assert scope.name == "kq"
        self.config = scope.data
        yield

    @contextlib.contextmanager
    def repositories(self, *roots, override):
        assert override is True
        self.calls.append(("repositories", roots))
        repos = []
        for root in roots:
            # Parse just the synthetic fixture data, never load recipe Python.
            text = (Path(root) / "repo.yaml").read_text()
            repos.append(types.SimpleNamespace(namespace=text.split("namespace: ")[1].strip()))
        yield types.SimpleNamespace(repos=repos)

    @contextlib.contextmanager
    def environment(self, path):
        self.calls.append(("environment", path))
        env = json.loads((Path(path) / "spack.yaml").read_text())
        assert env == {"spack": {"specs": ["hello@1.0"], "view": False}}
        yield types.SimpleNamespace(concrete_roots=lambda: self.roots)


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.input = self.base / "input"
        self.input.mkdir()
        (self.input / "blobs").mkdir()
        self.work = self.base / "work"
        self.work.mkdir(mode=0o700)
        self.lock = {
            "_meta": {"file-type": "spack-lockfile", "lockfile-version": 6, "specfile-version": 5},
            "spack": {"version": "1.0.0"},
            "roots": [{"spec": "hello@1.0", "hash": ROOT_HASH}],
            "concrete_specs": {ROOT_HASH: {
                "hash": ROOT_HASH, "name": "hello", "version": "1.0", "namespace": "fixture",
                "arch": {"platform": "linux", "platform_os": "ubuntu24.04", "target": "x86_64"},
                "parameters": {}, "package_hash": PACKAGE_HASH,
            }},
        }
        self.manifest = {
            "version": 1, "repository": "public/fixture", "spec": "hello@1.0",
            "spackVersion": "1.0.0", "target": "linux-ubuntu24.04-x86_64",
            "redistribution": "unrestricted",
            "recipes": [{
                "repositoryId": "f" * 64, "commit": "e" * 40, "roots": ["."],
                "archive": self.blob(archive(recipe())),
            }],
            "sources": [
                {"path": name, "blob": self.blob(name.encode())}
                for name in ("source.tar", "resource.tar", "patch.diff")
            ],
        }

    def blob(self, data):
        ref = {"digest": digest(data), "size": len(data)}
        (self.input / "blobs" / ref["digest"][7:]).write_bytes(data)
        return ref

    def save(self):
        self.manifest["lockfile"] = self.blob(json.dumps(self.lock).encode())
        data = json.dumps(self.manifest, indent=2).encode()
        (self.input / "manifest.json").write_bytes(data)
        return digest(data)

    def run_audit(self, native=None):
        expected = self.save()
        native = native or Native(self.work, self.lock)
        with patch.dict(sys.modules, native.modules):
            result = audit.audit(self.input, self.work, expected)
        return result, native

    def codes(self, report):
        return {issue["code"] for issue in report["issues"]}

    def test_native_sources_resources_patches_and_exact_contract(self):
        report, native = self.run_audit()
        self.assertEqual(set(report), {
            "version", "validation", "manifestDigest", "spackVersion", "rootHash",
            "nodeCount", "externalCount", "verifiedNodeCount", "passed", "issues",
        })
        self.assertTrue(report["passed"])
        self.assertEqual(report["verifiedNodeCount"], 1)
        self.assertEqual(report["manifestDigest"], digest((self.input / "manifest.json").read_bytes()))
        for name in ("source.tar", "resource.tar", "patch.diff"):
            self.assertIn(("fetch", name, True), native.calls)
            self.assertIn(("check", name), native.calls)
            self.assertTrue((self.work / "mirror" / name).is_symlink())
        self.assertIn(("patches", ROOT_HASH), native.calls)
        self.assertFalse(native.config["bootstrap"]["enable"])
        self.assertEqual(native.config["upstreams"], {})
        self.assertEqual(native.config["mirrors"], {"kq": (self.work / "mirror").as_uri()})
        for field in ("source_cache", "misc_cache"):
            self.assertTrue(native.config["config"][field].startswith(str(self.work) + "/"))
        self.assertIn("host-target-unverified", self.codes(report))
        self.assertIn("solver-unverified", self.codes(report))
        self.assertEqual((self.work / "env/spack.lock").read_bytes(), json.dumps(self.lock).encode())

    def test_missing_native_material_path_fails_sanitized(self):
        self.manifest["sources"] = self.manifest["sources"][:1]
        report, _ = self.run_audit()
        self.assertFalse(report["passed"])
        self.assertEqual(report["verifiedNodeCount"], 0)
        self.assertIn("source-verification-failed", self.codes(report))
        self.assertNotIn("SECRET", json.dumps(report))
        self.assertNotIn("https:", json.dumps(report))

    def test_bundle_is_verified_without_fetching_but_resources_still_checked(self):
        native = Native(self.work, self.lock)
        native.stages[0].default_fetcher = BundleFetcher()
        report, _ = self.run_audit(native)
        self.assertTrue(report["passed"])
        self.assertNotIn(("fetch", "source.tar", True), native.calls)
        self.assertIn(("check", "resource.tar"), native.calls)

    def test_expanded_file_fetchers_are_rejected_for_sources_resources_and_patches(self):
        for index in range(3):
            with self.subTest(stage=index), tempfile.TemporaryDirectory(dir=self.base) as work:
                self.work = Path(work)
                native = Native(self.work, self.lock)
                stage = native.stages[index]
                stage.default_fetcher = ExpandedFileFetcher()
                stage.fetcher = URLFetcher()  # Mirror fetchers only check the archive digest.
                report, _ = self.run_audit(native)
                self.assertFalse(report["passed"])
                self.assertEqual(report["verifiedNodeCount"], 0)
                self.assertIn("unsupported-fetcher", self.codes(report))
                self.assertNotIn(("fetch", stage.material, True), native.calls)
                self.assertNotIn(("check", stage.material), native.calls)

    def test_expanded_file_fetcher_after_fetch_is_also_rejected(self):
        native = Native(self.work, self.lock)
        native.stages[0].fetcher = ExpandedFileFetcher()
        report, _ = self.run_audit(native)
        self.assertFalse(report["passed"])
        self.assertEqual(report["verifiedNodeCount"], 0)
        self.assertIn("unsupported-fetcher", self.codes(report))
        self.assertNotIn(("check", "source.tar"), native.calls)

    def test_native_failures(self):
        for failure in ("semantic", "dag", "package", "patch", "checksum", "fetcher", "skip", "digest"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(dir=self.base) as work:
                self.work = Path(work)
                native = Native(self.work, self.lock)
                if failure == "semantic":
                    native.satisfies = False
                elif failure == "dag":
                    native.recomputed_hash = DEP_HASH
                elif failure == "package":
                    native.package_hash = "different"
                elif failure == "patch":
                    native.patch_error = True
                elif failure == "checksum":
                    native.check_error = True
                elif failure == "fetcher":
                    native.stages[0].default_fetcher = object()
                elif failure == "skip":
                    native.stages[0].skip_checksum_for_mirror = True
                else:
                    native.stages[0].default_fetcher.digest = None
                report, _ = self.run_audit(native)
                self.assertFalse(report["passed"])
                if failure in ("semantic", "fetcher", "skip", "digest"):
                    self.assertFalse(any(call[0] == "fetch" for call in native.calls))

    def test_external_and_build_spec_declared_nodes(self):
        other = copy.deepcopy(self.lock["concrete_specs"][ROOT_HASH])
        other.update(hash=DEP_HASH, external={"path": "/unverified"})
        self.lock["concrete_specs"][DEP_HASH] = other
        self.lock["concrete_specs"][ROOT_HASH]["build_spec"] = {"name": "hello", "hash": DEP_HASH}
        report, _ = self.run_audit()
        self.assertTrue(report["passed"])
        self.assertEqual((report["nodeCount"], report["externalCount"], report["verifiedNodeCount"]), (2, 1, 1))
        self.assertIn("external-unverified", self.codes(report))

    def test_manifest_binding_blob_rehash_and_size(self):
        expected = self.save()
        source = self.input / "blobs" / self.manifest["sources"][0]["blob"]["digest"][7:]
        source.write_bytes(b"x" * source.stat().st_size)
        with self.assertRaises(audit.AuditError):
            audit.prepare_input(self.input, self.work, expected)
        with self.assertRaises(audit.AuditError):
            audit.prepare_input(self.input, self.work, "sha256:" + "0" * 64)
        self.assertEqual(list(self.work.iterdir()), [])

    def test_exact_manifest_bytes_duplicate_json_and_blob_size(self):
        expected = self.save()
        path = self.input / "manifest.json"
        path.write_bytes(path.read_bytes() + b"\n")
        with self.assertRaises(audit.AuditError):
            audit.prepare_input(self.input, self.work, expected)
        for text in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}', b'{"x":"\xff"}'):
            with self.subTest(text=text), self.assertRaises(audit.AuditError):
                audit.document(text)
        self.manifest["sources"][0]["blob"]["size"] += 1
        with self.assertRaises(audit.AuditError):
            audit.prepare_input(self.input, self.work, self.save())
        self.assertEqual(list(self.work.iterdir()), [])

    def test_invalid_source_paths_sizes_and_root_refs(self):
        for change in ("path", "overlap", "size", "root", "duplicate-root", "missing-blob", "symlink"):
            with self.subTest(change=change):
                original = copy.deepcopy(self.manifest)
                if change == "path":
                    self.manifest["sources"][0]["path"] = "../outside"
                elif change == "overlap":
                    self.manifest["sources"][1]["path"] = "source.tar/nested"
                elif change == "size":
                    self.manifest["sources"][0]["blob"]["size"] = float("inf")
                elif change == "root":
                    self.manifest["recipes"][0]["roots"] = ["../outside"]
                elif change == "duplicate-root":
                    self.manifest["recipes"][0]["roots"] = [".", "."]
                else:
                    path = self.input / "blobs" / self.manifest["sources"][0]["blob"]["digest"][7:]
                    contents = path.read_bytes()
                    path.unlink()
                    if change == "symlink":
                        path.symlink_to("/etc/passwd")
                with self.assertRaises((audit.AuditError, ValueError)):
                    audit.prepare_input(self.input, self.work, self.save())
                self.manifest = original
                if change in ("missing-blob", "symlink"):
                    path.unlink(missing_ok=True)
                    path.write_bytes(contents)

    def test_archive_unsafe_members(self):
        for entries in (
            [("../outside", b"x", tarfile.REGTYPE)],
            [("/absolute", b"x", tarfile.REGTYPE)],
            [("link", b"", tarfile.SYMTYPE)],
            [("hard", b"", tarfile.LNKTYPE)],
            [("device", b"", tarfile.CHRTYPE)],
            [("fifo", b"", tarfile.FIFOTYPE)],
            [(".git/config", b"x", tarfile.REGTYPE)],
            [("windows\\path", b"x", tarfile.REGTYPE)],
            [("gnu", b"", tarfile.GNUTYPE_SPARSE)],
            [("same", b"a", tarfile.REGTYPE), ("same", b"b", tarfile.REGTYPE)],
            [("a/b", b"a", tarfile.REGTYPE), ("a", b"b", tarfile.REGTYPE)],
            [("a", b"a", tarfile.REGTYPE), ("a/b", b"b", tarfile.REGTYPE)],
        ):
            with self.subTest(entries=entries), tempfile.TemporaryDirectory(dir=self.base) as work:
                self.work = Path(work)
                self.manifest["recipes"][0]["archive"] = self.blob(archive(entries))
                with self.assertRaises(audit.AuditError):
                    audit.prepare_input(self.input, self.work, self.save())
        self.assertFalse((self.base / "outside").exists())

    def test_valid_compressed_recipe_with_small_pax_and_directories(self):
        entries = [("packages/", b"", tarfile.DIRTYPE)] + recipe()
        self.manifest["recipes"][0]["archive"] = self.blob(
            gzip.compress(archive(entries, pax_headers={"comment": "fixture"}))
        )
        report, _ = self.run_audit()
        self.assertTrue(report["passed"])
        self.assertEqual((self.work / "recipe-0/packages/hello/package.py").read_bytes(),
                         b"raise RuntimeError('NEVER EXECUTE')")

    def test_native_root_version_architecture_and_node_set(self):
        for field in ("version", "architecture", "extra-node", "missing-node"):
            with self.subTest(field=field), tempfile.TemporaryDirectory(dir=self.base) as work:
                self.work = Path(work)
                native = Native(self.work, self.lock)
                if field in ("version", "architecture"):
                    setattr(native.roots[0], field, "mismatch")
                    report, _ = self.run_audit(native)
                    self.assertIn("root-binding-mismatch", self.codes(report))
                elif field == "extra-node":
                    other = FakeSpec(native, DEP_HASH, self.lock["concrete_specs"][ROOT_HASH])
                    native.roots[0].dependencies = lambda: [other]
                    with self.assertRaises(audit.AuditError):
                        self.run_audit(native)
                else:
                    other = copy.deepcopy(self.lock["concrete_specs"][ROOT_HASH])
                    other["hash"] = DEP_HASH
                    self.lock["concrete_specs"][DEP_HASH] = other
                    self.lock["concrete_specs"][ROOT_HASH]["dependencies"] = [{"name": "hello", "hash": DEP_HASH}]
                    native.roots[0].dependencies = lambda: []
                    with self.assertRaises(audit.AuditError):
                        self.run_audit(native)
                self.assertFalse(any(call[0] == "fetch" for call in native.calls))

    def test_selected_multi_roots_only_and_duplicate_namespaces(self):
        self.manifest["recipes"][0]["roots"] = ["one", "two"]
        entries = recipe("one", "first") + recipe("two", "second") + recipe("unused", "first")
        self.manifest["recipes"][0]["archive"] = self.blob(archive(entries))
        self.lock["concrete_specs"][ROOT_HASH]["namespace"] = "first"
        report, native = self.run_audit()
        self.assertTrue(report["passed"])
        roots = next(call[1] for call in native.calls if call[0] == "repositories")
        self.assertEqual([Path(root).name for root in roots], ["one", "two"])

    def test_duplicate_namespace_missing_root_and_malformed_tar(self):
        for kind in ("duplicate", "missing", "malformed", "pax"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.base) as work:
                self.work = Path(work)
                self.manifest["recipes"][0]["roots"] = ["one", "two"]
                data = archive(recipe("one") + recipe("two"))
                if kind == "missing":
                    self.manifest["recipes"][0]["roots"] = ["absent"]
                elif kind == "malformed":
                    data = b"not a tar"
                elif kind == "pax":
                    data = archive(recipe(), pax_headers={"comment": "x" * 70000})
                self.manifest["recipes"][0]["archive"] = self.blob(data)
                native = Native(self.work, self.lock)
                with patch.dict(sys.modules, native.modules), self.assertRaises(audit.AuditError):
                    audit.audit(self.input, self.work, self.save())
                self.assertFalse(any(call[0] == "fetch" for call in native.calls))

    def test_main_stdout_is_one_result_line_and_errors_do_not_leak(self):
        expected = self.save()
        native = Native(self.work, self.lock)
        output, errors = io.StringIO(), io.StringIO()
        original_environment = native.environment

        @contextlib.contextmanager
        def noisy_environment(path):
            print("native routine log")
            with original_environment(path) as env:
                yield env

        native.modules["spack.environment"].Environment = noisy_environment
        with patch.dict(sys.modules, native.modules), patch.object(sys, "argv", ["worker", expected]):
            with patch.object(audit, "verify_runtime_boundary") as boundary:
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    result = audit.main(self.input, self.work)
                boundary.assert_called_once_with(self.input)
        self.assertEqual(result, 0)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertTrue(output.getvalue().startswith("KQ_SPACK_AUDIT_RESULT:"))
        self.assertIn("native routine log", errors.getvalue())
        output = io.StringIO()
        with patch.object(sys, "argv", ["worker", "invalid-secret"]):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                self.assertEqual(audit.main(self.input, self.work), 1)
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn("invalid-secret", errors.getvalue())

    def test_runtime_boundary_mock_files_only(self):
        (self.input / "runtime.json").write_text(json.dumps({
            "hostNetworkNamespace": "net:[1]", "hostPidNamespace": "pid:[2]",
        }))
        files = {
            "/proc/self/status": "Name:\tpython\nNoNewPrivs:\t1\n",
            "/proc/self/cgroup": "0::/job/worker\n",
            "/proc/self/mountinfo": "20 19 0:1 /job /sys/fs/cgroup ro,nosuid,nodev - cgroup2 cgroup rw\n",
            "/sys/fs/cgroup/worker/memory.max": "2147483648\n",
            "/sys/fs/cgroup/worker/memory.swap.max": "0\n",
            "/sys/fs/cgroup/worker/pids.max": "128\n",
            "/sys/fs/cgroup/worker/cpu.max": "200000 100000\n",
        }
        original_read_text = Path.read_text

        def read_text(path, *args, **kwargs):
            if str(path) in files:
                if files[str(path)] is None:
                    raise FileNotFoundError("mock missing cgroup controller file")
                return files[str(path)]
            if str(path).startswith(("/proc/", "/sys/")):
                raise FileNotFoundError("mock refuses host system reads")
            return original_read_text(path, *args, **kwargs)

        with patch.object(sys, "platform", "linux"), patch.object(os, "getuid", return_value=1000):
            with patch.object(Path, "read_text", read_text), patch.object(Path, "iterdir", return_value=iter([Path("lo")])), patch.object(socket, "if_nameindex", return_value=[(1, "lo")]):
                with patch.object(os, "readlink", side_effect=lambda p: "net:[3]" if str(p).endswith("/net") else "pid:[4]"):
                    audit.verify_runtime_boundary(self.input)

        for key, value in (
            ("/proc/self/status", "NoNewPrivs:\t0\n"),
            ("/proc/self/cgroup", "0::/missing\n"),
            ("/proc/self/cgroup", "0::/job/missing\n"),
            ("/proc/self/cgroup", "0::/job/../worker\n"),
            ("/proc/self/cgroup", "2:cpu:/job/worker\n"),
            ("/proc/self/mountinfo", "20 19 0:1 /other /sys/fs/cgroup ro - cgroup2 cgroup rw\n"),
            ("/proc/self/mountinfo", "20 19 0:1 /job /sys/fs/cgroup rw - cgroup2 cgroup rw\n"),
            ("/proc/self/mountinfo", "20 19 0:1 /job /sys/fs/cgroup rw - cgroup2 cgroup ro\n"),
            ("/proc/self/mountinfo", "20 19 0:1 /job /sys/fs/cgroup ro,rw - cgroup2 cgroup rw\n"),
            ("/proc/self/mountinfo", "20 19 0:1 /job /sys/fs/cgroup nosuid,nodev - cgroup2 cgroup ro\n"),
            ("/proc/self/mountinfo", "20 19 0:1 /job /sys/fs/cgroup ro - tmpfs tmpfs ro\n"),
            *(
                ("/proc/self/mountinfo", files["/proc/self/mountinfo"] + extra)
                for extra in (
                    "21 20 0:2 / /sys/fs/cgroup/worker rw - tmpfs tmpfs rw\n",
                    "21 20 0:2 / /sys/fs/cgroup/worker ro - tmpfs tmpfs rw\n",
                    "21 20 0:1 /job/worker /sys/fs/cgroup/worker rw - cgroup2 cgroup rw\n",
                    "21 20 0:1 /job/worker /sys/fs/cgroup/worker ro - cgroup2 cgroup rw\n",
                    "21 20 0:2 / /sys/fs/cgroup/worker\\040hidden ro - tmpfs tmpfs rw\n",
                    "21 19 0:1 /job /sys/fs/cgroup ro - cgroup2 cgroup rw\n",
                    "21 19 0:2 / /sys/fs/cgroup ro - tmpfs tmpfs rw\n",
                    "21 19 0:1 / /alternate-cgroup rw - cgroup2 cgroup rw\n",
                )
            ),
            ("/sys/fs/cgroup/worker/memory.max", "max\n"),
            ("/sys/fs/cgroup/worker/memory.max", "2147483649\n"),
            ("/sys/fs/cgroup/worker/memory.swap.max", "1\n"),
            ("/sys/fs/cgroup/worker/memory.swap.max", "2147483648\n"),
            ("/sys/fs/cgroup/worker/memory.swap.max", "max\n"),
            ("/sys/fs/cgroup/worker/memory.swap.max", "-1\n"),
            ("/sys/fs/cgroup/worker/memory.swap.max", ""),
            ("/sys/fs/cgroup/worker/memory.swap.max", None),
            ("/sys/fs/cgroup/worker/pids.max", "129\n"),
            ("/sys/fs/cgroup/worker/cpu.max", "200001 100000\n"),
            ("/sys/fs/cgroup/worker/cpu.max", "max 100000\n"),
            ("/sys/fs/cgroup/worker/cpu.max", "1 0\n"),
        ):
            with self.subTest(key=key, value=value):
                original = files[key]
                files[key] = value
                with patch.object(sys, "platform", "linux"), patch.object(os, "getuid", return_value=1000):
                    with patch.object(Path, "read_text", read_text), patch.object(Path, "iterdir", return_value=iter([Path("lo")])), patch.object(socket, "if_nameindex", return_value=[(1, "lo")]):
                        with patch.object(os, "readlink", side_effect=lambda p: "net:[3]" if str(p).endswith("/net") else "pid:[4]"):
                            with self.assertRaises(audit.AuditError):
                                audit.verify_runtime_boundary(self.input)
                files[key] = original
        for platform, uid, net, pid, interfaces in (
            ("darwin", 1000, "net:[3]", "pid:[4]", ["lo"]),
            ("linux", 0, "net:[3]", "pid:[4]", ["lo"]),
            ("linux", 1000, "net:[1]", "pid:[4]", ["lo"]),
            ("linux", 1000, "net:[3]", "pid:[2]", ["lo"]),
            ("linux", 1000, "net:[3]", "pid:[4]", ["lo", "eth0"]),
            ("linux", 1000, "net:[3]", "pid:[4]", []),
            ("linux", 1000, "invalid", "pid:[4]", ["lo"]),
        ):
            with self.subTest(platform=platform, uid=uid, net=net, pid=pid, interfaces=interfaces):
                with patch.object(sys, "platform", platform), patch.object(os, "getuid", return_value=uid):
                    with patch.object(Path, "read_text", read_text), patch.object(Path, "iterdir", return_value=iter([Path("lo")])), patch.object(socket, "if_nameindex", return_value=list(enumerate(interfaces, 1))):
                        with patch.object(os, "readlink", side_effect=lambda p: net if str(p).endswith("/net") else pid):
                            with self.assertRaises(audit.AuditError):
                                audit.verify_runtime_boundary(self.input)
        with patch.object(sys, "platform", "linux"), patch.object(os, "getuid", return_value=1000):
            with patch.object(Path, "read_text", read_text), patch.object(Path, "iterdir", side_effect=AssertionError("Host sysfs network view must not be read")):
                with patch.object(os, "readlink", side_effect=lambda p: "net:[3]" if str(p).endswith("/net") else "pid:[4]"):
                    with patch.object(socket, "if_nameindex", return_value=[(1, "lo")]) as interfaces:
                        audit.verify_runtime_boundary(self.input)
                        interfaces.assert_called_once_with()
                        interfaces.side_effect = OSError("fixture interface lookup failed")
                        with self.assertRaisesRegex(audit.AuditError, "^runtime-boundary$"):
                            audit.verify_runtime_boundary(self.input)

    def test_archive_budgets_and_pax_overrides(self):
        for limit, value in (("TAR_BYTES", 100), ("TAR_ENTRIES", 1), ("TAR_EXPANDED", 10), ("RECIPE_TOTAL", 10)):
            with self.subTest(limit=limit), tempfile.TemporaryDirectory(dir=self.base) as work:
                self.work = Path(work)
                with patch.object(audit, limit, value), self.assertRaises(audit.AuditError):
                    audit.prepare_input(self.input, self.work, self.save())
                if limit == "RECIPE_TOTAL":
                    self.assertFalse((self.work / "recipe-0/repo.yaml").exists())
        for headers in ({"path": "../outside"}, {"size": str(257 * 1024 ** 2)}, {"GNU.sparse.size": "1"}):
            with self.subTest(headers=headers), tempfile.TemporaryDirectory(dir=self.base) as work:
                self.work = Path(work)
                self.manifest["recipes"][0]["archive"] = self.blob(archive(recipe(), pax_headers=headers))
                with self.assertRaises(audit.AuditError):
                    audit.prepare_input(self.input, self.work, self.save())

    def test_lock_validation_and_native_declared_node_binding(self):
        valid = copy.deepcopy(self.lock)
        mutations = [
            lambda lock: lock.update(roots=[]),
            lambda lock: lock["roots"][0].update(hash=DEP_HASH),
            lambda lock: lock["concrete_specs"][ROOT_HASH].update(hash=DEP_HASH),
            lambda lock: lock["concrete_specs"][ROOT_HASH].update(dependencies=[{"name": "hello", "hash": DEP_HASH}]),
            lambda lock: lock["concrete_specs"][ROOT_HASH].update(build_spec={"name": "hello", "hash": ROOT_HASH}),
            lambda lock: lock["concrete_specs"].update({DEP_HASH: {**lock["concrete_specs"][ROOT_HASH], "hash": DEP_HASH}}),
            lambda lock: lock["concrete_specs"][ROOT_HASH].update(parameters={"dev_path": "/outside"}),
        ]
        for mutate in mutations:
            self.lock = copy.deepcopy(valid)
            mutate(self.lock)
            with self.assertRaises(audit.AuditError):
                audit.prepare_input(self.input, self.work, self.save())
            self.assertEqual(list(self.work.iterdir()), [])
        self.lock = valid
        native = Native(self.work, self.lock)
        native.roots[0].key = DEP_HASH
        with self.assertRaises(audit.AuditError):
            self.run_audit(native)
        self.assertFalse(any(call[0] == "fetch" for call in native.calls))

    def test_issue_limit_external_warnings_and_no_source_bundle(self):
        alphabet = "abcdefghijklmnopqrstuvwxyz234567"
        self.lock["concrete_specs"][ROOT_HASH]["dependencies"] = []
        for index in range(101):
            key = "b" * 30 + alphabet[index // 32] + alphabet[index % 32]
            other = copy.deepcopy(self.lock["concrete_specs"][ROOT_HASH])
            other.update(hash=key, dependencies=[], external={"path": "/unverified"})
            self.lock["concrete_specs"][key] = other
            self.lock["concrete_specs"][ROOT_HASH]["dependencies"].append({"name": "hello", "hash": key})
        native = Native(self.work, self.lock)
        native.stages[:] = [FakeStage(native, "no-source", BundleFetcher())]
        report, _ = self.run_audit(native)
        self.assertEqual(len(report["issues"]), 100)
        self.assertFalse(report["passed"])
        self.assertEqual(report["verifiedNodeCount"], 1)
        self.assertEqual(report["issues"][-1]["code"], "issue-limit")
        self.assertFalse(any(call[0] in ("fetch", "check") for call in native.calls))

    def test_missing_package_hash_and_failed_main_exit(self):
        del self.lock["concrete_specs"][ROOT_HASH]["package_hash"]
        expected = self.save()
        native = Native(self.work, self.lock)
        output = io.StringIO()
        with patch.dict(sys.modules, native.modules), patch.object(sys, "argv", ["worker", expected]):
            with patch.object(audit, "verify_runtime_boundary"):
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(audit.main(self.input, self.work), 1)
        report = json.loads(output.getvalue().split(":", 1)[1])
        self.assertIn("package-hash-unsupported", self.codes(report))

    def test_runtime_failure_precedes_all_material_or_native_work(self):
        with patch.object(audit, "verify_runtime_boundary", side_effect=audit.AuditError("runtime-boundary")):
            with patch.object(audit, "audit") as native, patch.object(sys, "argv", ["worker", "sha256:" + "0" * 64]):
                with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(audit.main(self.input, self.work), 1)
                native.assert_not_called()


if __name__ == "__main__":
    unittest.main()

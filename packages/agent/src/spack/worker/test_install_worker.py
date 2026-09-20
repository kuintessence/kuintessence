"""Offline install fixtures: stub native APIs, never execute recipe Python."""

import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

import source_audit as audit
import test_source_audit as fixtures

try:
    import install_worker as worker
except ModuleNotFoundError:
    worker = None


class InstallSpec(fixtures.FakeSpec):
    def __init__(self, native, key, node):
        super().__init__(native, key, node)
        external = node.get("external", {})
        self.external_path = external.get("path")
        self.external_modules = external.get("module")
        self.extra_attributes = external.get("extra_attributes", {})
        self.abstract_hash = None
        self.variants = {}
        self.compiler_flags = ""
        self.package.spec = self

    @property
    def prefix(self):
        return self.external_path or str(self.native.store_path / self.name)

    def format(self, template=None):
        assert template in (
            None,
            "{namespace}.{name}{@version}{variants}{compiler_flags} arch={architecture}",
            "{name}{@version}{variants}{compiler_flags} arch={architecture}",
        )
        namespace = f"{self.namespace}." if template is None or "{namespace}" in template else ""
        variants = "".join(f" {name}={value}" for name, value in self.variants.items())
        return (f"{namespace}{self.name}@={self.version}{variants}"
                f"{self.compiler_flags} arch={self.architecture}")

    def copy(self, deps=True):
        assert deps is False
        result = copy.copy(self)
        result.variants = copy.deepcopy(self.variants)
        return result

    def traverse(self):
        yield self
        yield from self.dependencies()


class Native(fixtures.Native):
    def __init__(self, work, lock, store):
        super().__init__(work, lock)
        self.store_path = store
        self.nodes = {
            key: InstallSpec(self, key, node) for key, node in lock["concrete_specs"].items()
        }
        self.roots = [self.nodes[lock["roots"][0]["hash"]]]
        self.solved_root = self.roots[0]
        self.records = {
            key: types.SimpleNamespace(
                spec=spec, path=spec.prefix, installed=True, deprecated_for=None
            )
            for key, spec in self.nodes.items() if not spec.external
        }
        self.upstream = False
        self.install_error = self.solver_error = None
        self.solver_constraints = None
        self.shell = "export PATH='/approved/bin';\n"
        self.install_options = None
        for name in (
            "store", "concretize", "installer", "stage", "user_environment",
            "platforms", "compilers", "compilers.config", "solver", "solver.core",
            "vendor", "vendor.archspec", "vendor.archspec.cpu",
        ):
            full = "spack." + name
            module = types.ModuleType(full)
            self.modules[full] = module
            parent, _, child = full.rpartition(".")
            setattr(self.modules[parent], child, module)
        self.modules["spack.store"].use_store = self.use_store
        self.modules["spack.concretize"].concretize_one = self.concretize
        self.modules["spack.installer"].PackageInstaller = self.installer
        self.modules["spack.stage"].Stage = type("Stage", (), {"fetch": self.fetch})
        self.modules["spack.compilers.config"].all_compilers = lambda **kw: []
        self.modules["spack.solver.core"]._bootstrap_clingo = lambda: self.fail("bootstrap")
        self.modules["spack.user_environment"].environment_modifications_for_specs = self.load
        self.modules["spack.platforms"].host = lambda: types.SimpleNamespace(
            name="linux", default_operating_system=lambda: "ubuntu24.04"
        )
        target = types.SimpleNamespace(name="x86_64", vendor="generic", ancestors=[])
        generic = types.SimpleNamespace(
            name="x86_64_v3", vendor="generic", ancestors=[target],
        )
        self.modules["spack.vendor.archspec.cpu"].host = lambda: target
        self.modules["spack.vendor.archspec.cpu"].TARGETS = {
            "x86_64": target,
            "x86_64_v3": generic,
            "aarch64": types.SimpleNamespace(name="aarch64", vendor="generic", ancestors=[]),
            "haswell": types.SimpleNamespace(
                name="haswell", vendor="GenuineIntel", ancestors=[generic, target],
            ),
            "zen3": types.SimpleNamespace(
                name="zen3", vendor="AuthenticAMD", ancestors=[generic, target],
            ),
        }
        self.modules["clingo"] = types.ModuleType("clingo")
        self.modules["clingo"].Symbol = object
        self.modules["clingo.ast"] = types.ModuleType("clingo.ast")
        self.modules["spack.spec"].Spec = self.spec
        self.spec.from_json = self.from_json

    @staticmethod
    def fail(message):
        raise AssertionError(message)

    @staticmethod
    def fetch(*args, mirror_only=False, **kwargs):
        if not mirror_only:
            raise AssertionError("origin fetch must be impossible")

    @staticmethod
    def spec(text):
        class Abstract:
            concrete = False
            abstract_hash = None

            def traverse(self):
                return [self]

            def constrain(self, constraint):
                self.constraints.append(constraint.text)
                return True

        result = Abstract()
        result.text = text
        result.constraints = []
        return result

    def from_json(self, data):
        self.calls.append(("spec-json",))
        return self.nodes[json.loads(data)["hash"]]

    @contextlib.contextmanager
    def use_store(self, path):
        self.calls.append(("store", str(path)))
        db = types.SimpleNamespace(
            read_transaction=lambda: contextlib.nullcontext(),
            query_by_spec_hash=lambda key: (self.upstream, self.records.get(key)),
        )
        store = types.SimpleNamespace(db=db)
        self.modules["spack.store"].STORE = store
        yield store

    def concretize(self, spec, **kwargs):
        self.calls.append(("solve", spec.text))
        self.solver_constraints = list(spec.constraints)
        assert not spec.concrete
        assert self.config["concretizer"]["reuse"] is False
        assert self.config["bootstrap"]["enable"] is False
        if self.solver_error:
            raise self.solver_error
        return self.solved_root

    def installer(self, packages, **kwargs):
        self.calls.append(("installer",))
        self.install_options = kwargs
        assert packages == [self.roots[0].package]
        assert self.config["modules"]["default"]["enable"] == []
        assert self.config["packages"]["all"]["permissions"] == {
            "read": "world", "write": "user",
        }

        def install():
            self.calls.append(("install",))
            mode = os.umask(0o022)
            os.umask(mode)
            assert mode == 0o022
            self.modules["spack.stage"].Stage().fetch(mirror_only=False)
            if self.install_error:
                raise self.install_error

        return types.SimpleNamespace(install=install)

    def load(self, root):
        self.calls.append(("load", root.key))

        def shell_modifications(shell):
            assert shell == "sh"
            return self.shell

        return types.SimpleNamespace(shell_modifications=shell_modifications)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(worker, "install_worker implementation is required")
        fixtures.AuditTests.setUp(self)
        self.base = self.base.resolve()
        self.input, self.work = self.input.resolve(), self.work.resolve()
        self.store = self.base / "releases" / "release"
        self.store.mkdir(parents=True, mode=0o755)
        self.compiler = self.base / "cc"
        self.compiler.write_bytes(b"pinned compiler, never executed")
        self.compiler.chmod(0o555)
        self.profile = {
            "version": 1, "storeRoot": str(self.store.parent),
            "target": self.manifest["target"], "runtimeSifSha256": "f" * 64,
            "osReleaseSha256": hashlib.sha256(b"fixture os").hexdigest(),
            "hostFiles": [{
                "path": str(self.compiler),
                "sha256": hashlib.sha256(self.compiler.read_bytes()).hexdigest(),
            }],
            "externals": [], "sharedStoreConfirmed": True,
            "compatibleComputeNodesConfirmed": True, "trustedRecipesConfirmed": True,
            "quotaEnforcedBySite": True,
        }
        self.request = {
            "version": 1, "action": "install", "manifestDigest": self.save(),
            "siteProfileDigest": "", "storePath": str(self.store), "siteProfile": self.profile,
        }
        self.save_request()
        self.native = Native(self.work, self.lock, self.store)
        self.make_output()

    blob = fixtures.AuditTests.blob
    save = fixtures.AuditTests.save

    def save_request(self):
        profile_bytes = json.dumps(self.profile, indent=2).encode()
        (self.input / "site-profile.json").write_bytes(profile_bytes)
        self.request["siteProfileDigest"] = fixtures.digest(profile_bytes)
        (self.input / "request.json").write_text(json.dumps(self.request))

    def make_output(self):
        (self.store / ".spack-db").mkdir(exist_ok=True)
        (self.store / ".spack-db/index.json").write_text('{"database":{}}')
        for key, node in self.lock["concrete_specs"].items():
            if "external" not in node:
                metadata = self.store / node["name"] / ".spack"
                metadata.mkdir(parents=True, exist_ok=True)
                (metadata / "spec.json").write_text(json.dumps({"hash": key}))

    def mounts(self, mode=None):
        mode = mode or ("rw" if self.request["action"] == "install" else "ro")
        return [
            (Path("/"), {"ro"}, "squashfs"),
            (self.input, {"ro"}, "tmpfs"),
            (self.work, {"rw"}, "tmpfs"),
            (self.store, {mode}, "ext4"),
        ]

    def scratch_mountinfo(self, action="install", rootfs="squashfs"):
        """Apptainer v1.4.3 session-backed scratch; destinations use fixture paths."""
        store_mode = "rw" if action == "install" else "ro"
        session = "/var/apptainer/mnt/session"
        root_options = "ro" if rootfs == "squashfs" else "ro,lowerdir=/session/lower"
        return (
            f"10 0 7:0 / / ro,relatime - {rootfs} image {root_options}\n"
            "11 10 0:1 / /proc rw,nosuid,nodev,noexec - proc proc rw\n"
            "12 10 0:2 / /sys ro,nosuid,nodev,noexec - sysfs sysfs ro\n"
            "13 10 0:3 / /dev rw,nosuid - tmpfs tmpfs rw,mode=755\n"
            "14 13 0:4 / /dev/pts rw,nosuid,noexec - devpts devpts rw\n"
            f"15 10 0:5 / {session} rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=1777\n"
            f"16 10 0:5 /scratch/kq/work {self.work} rw,nosuid,nodev - tmpfs tmpfs rw\n"
            "17 10 0:5 /tmp /tmp rw,nosuid,nodev - tmpfs tmpfs rw\n"
            "18 10 0:5 /var/tmp /var/tmp rw,nosuid,nodev - tmpfs tmpfs rw\n"
            f"19 10 8:0 /materials {self.input} ro,nosuid,nodev - ext4 disk rw\n"
            f"20 19 8:0 /manifest.json {self.input}/manifest.json ro - ext4 disk rw\n"
            f"21 10 8:0 /releases/fixture {self.store} {store_mode},nosuid,nodev - ext4 disk rw\n"
            f"22 10 8:0 /toolchain/cc {self.compiler} ro,nosuid - ext4 disk rw\n"
            "23 12 0:6 /job /sys/fs/cgroup ro,nosuid,nodev,noexec - cgroup2 cgroup rw\n"
        ).encode()

    def parse_mountinfo(self, data):
        original = Path.open

        def open_file(path, *args, **kwargs):
            if str(path) == "/proc/self/mountinfo":
                return io.BytesIO(data)
            return original(path, *args, **kwargs)

        with patch.object(Path, "open", open_file):
            return worker.mount_table()

    @contextlib.contextmanager
    def runtime(self):
        original = audit.read_regular
        os_release_paths = {Path("/etc/os-release"), Path("/etc/os-release").resolve()}

        def read(path, maximum, expected=None):
            if path in os_release_paths:
                return b"fixture os"
            return original(path, maximum, expected)

        with patch.dict(sys.modules, self.native.modules):
            with patch.object(audit, "verify_runtime_boundary") as boundary:
                with patch.object(worker, "mount_table", side_effect=lambda: self.mounts()):
                    with patch.object(audit, "read_regular", side_effect=read):
                        yield boundary

    def run_worker(self, action="install"):
        self.request["action"] = action
        self.request["manifestDigest"] = self.save()
        self.save_request()
        with self.runtime() as boundary:
            result = worker.run(self.input, self.work)
            boundary.assert_called_once_with(self.input, memory_limit=4294967296)
            return result

    def assert_no_recipes(self):
        self.assertFalse(any(c[0] in ("repositories", "solve", "installer")
                             for c in self.native.calls))

    def test_request_exact_bytes_and_strict_profile(self):
        self.assertEqual(worker.read_request(self.input), self.request)
        (self.input / "site-profile.json").write_bytes(
            (self.input / "site-profile.json").read_bytes() + b"\n"
        )
        with self.assertRaises(audit.AuditError):
            worker.read_request(self.input)
        self.save_request()
        self.request["siteProfile"] = {**self.profile, "target": "linux-other-x86_64"}
        (self.input / "request.json").write_text(json.dumps(self.request))
        with self.assertRaises(audit.AuditError):
            worker.read_request(self.input)

    def test_reject_invalid_request_profile_shapes(self):
        mutations = [
            lambda: self.request.update(version=True),
            lambda: self.request.update(action="remove"),
            lambda: self.request.update(extra=True),
            lambda: self.profile.update(runtimeSifSha256="secret"),
            lambda: self.profile.update(osReleaseSha256="bad"),
            lambda: self.profile.update(trustedRecipesConfirmed=False),
            lambda: self.profile.update(sharedStoreConfirmed=1),
            lambda: self.profile.update(extra=True),
            lambda: self.profile["hostFiles"].append(self.profile["hostFiles"][0]),
            lambda: self.profile.update(hostFiles=[]),
            lambda: self.profile.update(externals=[{"hash": "x", "prefix": "/usr/bin"}]),
        ]
        original = copy.deepcopy(self.request)
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.request = copy.deepcopy(original)
                self.profile = self.request["siteProfile"]
                mutate()
                self.save_request()
                with self.assertRaises(audit.AuditError):
                    worker.read_request(self.input)
        self.assert_no_recipes()

    def test_boundary_must_precede_even_request_read_for_all_actions(self):
        for action in ("install", "verify", "load"):
            with self.subTest(action=action), self.runtime() as boundary:
                boundary.side_effect = audit.AuditError("runtime-boundary")
                with patch.object(worker, "read_request") as read:
                    with self.assertRaises(audit.AuditError):
                        worker.run(self.input, self.work)
                    boundary.assert_called_once_with(self.input, memory_limit=4294967296)
                    read.assert_not_called()

    def test_spack_runpy_entry_loads_sibling_without_script_directory_on_sys_path(self):
        script = str(Path(worker.__file__).resolve())
        child = subprocess.run(
            [sys.executable, "-I", "-B", "-c",
             "import runpy, sys\n"
             "loaded = runpy.run_path(sys.argv[1], run_name='fixture')\n"
             "assert loaded['audit'].__file__.endswith('/source_audit.py')\n"
             "assert 'spack' not in sys.modules\n", script],
            capture_output=True, text=True, check=False, timeout=10,
        )
        self.assertEqual((child.returncode, child.stdout, child.stderr), (0, "", ""))

    def test_mount_vfs_mode_unique_no_children(self):
        for action in ("install", "verify", "load"):
            self.request["action"] = action
            valid = self.mounts()
            worker.verify_store(self.request, valid)
            for mounts in (
                valid[:-1], valid + valid[-1:],
                valid + [(self.store / "hidden", {"ro"}, "tmpfs")],
                valid[:-1] + [(self.store, {"rw", "ro"}, "ext4")],
                valid[:-1] + [(self.store, {"ro" if action == "install" else "rw"}, "ext4")],
            ):
                with self.subTest(action=action, mounts=mounts):
                    with self.assertRaises(audit.AuditError):
                        worker.verify_store(self.request, mounts)

    def test_store_unsafe_paths_owner_and_symlinks(self):
        for path in ("/usr/local/store", "/opt/spack/store", "/kq/store/out",
                     "/srv/../store", "/srv//store", "/srv/store/", "/srv"):
            with self.subTest(path=path):
                bad = {**self.request, "storePath": path}
                with self.assertRaises(audit.AuditError):
                    worker.verify_store(bad, self.mounts())
        with patch.object(os, "getuid", return_value=self.store.stat().st_uid + 1):
            with self.assertRaises(audit.AuditError):
                worker.verify_store(self.request, self.mounts())
        alias = self.store.parent / "alias"
        alias.symlink_to(self.store, target_is_directory=True)
        bad = {**self.request, "storePath": str(alias)}
        with self.assertRaises(audit.AuditError):
            worker.verify_store(bad, self.mounts() + [(alias, {"rw"}, "ext4")])

    def test_pins_and_target_fail_before_recipes(self):
        self.profile["hostFiles"][0]["sha256"] = "0" * 64
        with self.assertRaises(audit.AuditError):
            self.run_worker()
        self.assert_no_recipes()

    def test_runtime_sif_format_fails_before_recipes(self):
        self.profile["runtimeSifSha256"] = "not-a-sha256"
        with self.assertRaises(audit.AuditError):
            self.run_worker()
        self.assert_no_recipes()

    def test_os_digest_writable_pin_and_cpu_fail_before_recipes(self):
        for failure in ("os", "pin-mount", "cpu", "platform"):
            with self.subTest(failure=failure):
                with self.runtime(), contextlib.ExitStack() as stack:
                    if failure == "os":
                        self.profile["osReleaseSha256"] = "0" * 64
                    elif failure == "pin-mount":
                        stack.enter_context(patch.object(
                            worker, "mount_table",
                            return_value=self.mounts() + [(self.compiler, {"rw"}, "ext4")],
                        ))
                    elif failure == "cpu":
                        cpu = self.native.modules["spack.vendor.archspec.cpu"]
                        stack.enter_context(patch.object(
                            cpu, "host", return_value=types.SimpleNamespace(
                                name="aarch64", vendor="generic", ancestors=[]
                            ),
                        ))
                    else:
                        platform = self.native.modules["spack.platforms"]
                        stack.enter_context(patch.object(
                            platform, "host", return_value=types.SimpleNamespace(
                                name="linux", default_operating_system=lambda: "different"
                            ),
                        ))
                    self.save_request()
                    with self.assertRaises(audit.AuditError):
                        worker.run(self.input, self.work)
                self.profile["osReleaseSha256"] = hashlib.sha256(b"fixture os").hexdigest()
                self.assert_no_recipes()

    def test_all_lock_targets_and_root_external_rejected_before_recipes(self):
        self.add_external()
        for key in (fixtures.ROOT_HASH, fixtures.DEP_HASH):
            node = self.lock["concrete_specs"][key]
            original = copy.deepcopy(node["arch"])
            for field, value in (
                ("platform", "different"),
                ("platform_os", "different"),
                ("target", "x86_64_v3"),
                ("target", {"name": "x86_64_v3"}),
            ):
                with self.subTest(node=key, field=field, value=value):
                    node["arch"][field] = value
                    with self.assertRaisesRegex(audit.AuditError, "target-mismatch"):
                        self.run_worker()
                    self.assert_no_recipes()
                    node["arch"] = copy.deepcopy(original)
        node = self.lock["concrete_specs"][fixtures.ROOT_HASH]
        node["external"] = {"path": "/usr", "module": None}
        with self.assertRaises(audit.AuditError):
            self.run_worker()
        self.assert_no_recipes()

    def test_profile_target_mismatch_rejected_before_recipes(self):
        self.profile["target"] = "linux-ubuntu24.04-x86_64_v3"
        cpu = self.native.modules["spack.vendor.archspec.cpu"]
        with patch.object(cpu, "host", return_value=cpu.TARGETS["x86_64_v3"]):
            with self.assertRaisesRegex(audit.AuditError, "target-mismatch"):
                self.run_worker()
        self.assert_no_recipes()

    def test_unknown_profile_target_rejected_before_recipes(self):
        self.profile["target"] = "linux-ubuntu24.04-unknown"
        with self.assertRaisesRegex(audit.AuditError, "cpu-mismatch"):
            self.run_worker()
        self.assert_no_recipes()

    def add_external(self):
        node = copy.deepcopy(self.lock["concrete_specs"][fixtures.ROOT_HASH])
        prefix = self.base / "external"
        prefix.mkdir()
        node.update(hash=fixtures.DEP_HASH, name="gcc", external={
            "path": str(prefix), "module": None,
            "extra_attributes": {"compilers": {"c": str(self.compiler), "cxx": None}},
        })
        self.lock["concrete_specs"][fixtures.DEP_HASH] = node
        self.lock["concrete_specs"][fixtures.ROOT_HASH]["dependencies"] = [{
            "name": "gcc", "hash": fixtures.DEP_HASH,
        }]
        self.profile["externals"] = [{"hash": fixtures.DEP_HASH, "prefix": str(prefix)}]
        self.native = Native(self.work, self.lock, self.store)
        return node

    def test_external_allowlist_and_compiler_paths_before_recipes(self):
        node = self.add_external()
        original = copy.deepcopy(node["external"])
        for failure in ("module", "prefix", "compiler", "relative", "nested-path"):
            with self.subTest(failure=failure):
                node["external"] = copy.deepcopy(original)
                external = node["external"]
                if failure == "module":
                    external["module"] = ["compiler/secret"]
                elif failure == "prefix":
                    external["path"] = str(self.base)
                elif failure == "nested-path":
                    external["extra_attributes"]["environment"] = {"set": {"PATH": "/unapproved"}}
                else:
                    external["extra_attributes"]["compilers"]["c"] = (
                        "/usr/bin/cc" if failure == "compiler" else "cc"
                    )
                with self.assertRaises(audit.AuditError):
                    self.run_worker()
                self.assert_no_recipes()
        node["external"] = original
        self.profile["externals"] = []
        with self.assertRaises(audit.AuditError):
            self.run_worker()

    def test_configuration_sets_shared_read_permissions_without_widening_writes(self):
        self.add_external()
        for nodes in ({}, self.native.nodes):
            with self.subTest(externals=bool(nodes)):
                with self.runtime():
                    config = worker.configuration(self.work, nodes, self.profile["target"])
                self.assertEqual(config["packages"]["all"]["permissions"],
                                 {"read": "world", "write": "user"})
                self.assertEqual(config["packages"]["all"]["require"],
                                 ["arch=" + self.profile["target"]])
                self.assertIs(config["config"]["allow_sgid"], False)
                if nodes:
                    self.assertIs(config["packages"]["gcc"]["buildable"], False)
                    self.assertEqual(len(config["packages"]["gcc"]["externals"]), 1)

    def test_configuration_granularity_uses_target_vendor(self):
        for cpu_name, granularity in (
            ("x86_64", "generic"),
            ("x86_64_v3", "generic"),
            ("aarch64", "generic"),
            ("haswell", "microarchitectures"),
            ("zen3", "microarchitectures"),
        ):
            with self.subTest(target=cpu_name), self.runtime():
                config = worker.configuration(self.work, {}, "linux-ubuntu24.04-" + cpu_name)
                self.assertEqual(config["packages"]["all"]["require"],
                                 ["arch=linux-ubuntu24.04-" + cpu_name])
                self.assertEqual(config["concretizer"], {
                    "reuse": False, "unify": True, "splice": {"automatic": False},
                    "targets": {"host_compatible": True, "granularity": granularity},
                })

    def test_configuration_does_not_infer_granularity_from_host_vendor(self):
        cpu = self.native.modules["spack.vendor.archspec.cpu"]
        for host_name in ("haswell", "zen3"):
            with self.subTest(host=host_name), self.runtime():
                with patch.object(cpu, "host", return_value=cpu.TARGETS[host_name]) as host:
                    config = worker.configuration(self.work, {}, self.profile["target"])
                host.assert_not_called()
                self.assertEqual(config["concretizer"]["targets"]["granularity"], "generic")

    def test_configuration_unknown_target_fails_closed(self):
        with self.runtime(), self.assertRaisesRegex(audit.AuditError, "cpu-mismatch"):
            worker.configuration(self.work, {}, "linux-ubuntu24.04-unknown")
        self.assert_no_recipes()

    def test_external_configuration_omits_native_patch_metadata_without_mutating_lock_spec(self):
        self.add_external()
        external = self.native.nodes[fixtures.DEP_HASH]
        external.variants = {"languages": "c,c++", "patches": "a" * 64}
        external.compiler_flags = ' cflags="-O2"'
        original = copy.deepcopy(external.variants)
        lock = copy.deepcopy(self.lock)
        nodes = self.native.nodes.copy()
        node_values = {
            key: (node.format(), copy.deepcopy(node.variants), copy.deepcopy(node.extra_attributes))
            for key, node in nodes.items()
        }
        with self.runtime():
            config = worker.configuration(self.work, self.native.nodes, self.profile["target"])
        entry = config["packages"]["gcc"]["externals"][0]
        self.assertEqual(entry["spec"],
                         f"gcc@={external.version} languages=c,c++"
                         ' cflags="-O2" arch=linux-ubuntu24.04-x86_64')
        self.assertNotIn("patches=", entry["spec"])
        self.assertNotIn("/" + fixtures.DEP_HASH, entry["spec"])
        self.assertEqual(external.variants, original)
        self.assertEqual(self.lock, lock)
        self.assertEqual(self.native.nodes, nodes)
        for key, node in self.native.nodes.items():
            self.assertIs(node, nodes[key])
            self.assertEqual((node.format(), node.variants, node.extra_attributes), node_values[key])
        self.assertEqual(entry["prefix"], external.external_path)
        self.assertEqual(entry["extra_attributes"], external.extra_attributes)
        self.assertIsNot(entry["extra_attributes"], external.extra_attributes)

    def test_external_configuration_avoids_self_conditioned_namespace(self):
        self.add_external()
        external = self.native.nodes[fixtures.DEP_HASH]
        original_namespace = external.namespace
        for name in ("gcc", "gmake"):
            with self.subTest(package=name):
                external.name = name
                with self.runtime():
                    config = worker.configuration(self.work, self.native.nodes, self.profile["target"])
                entry = config["packages"][name]["externals"][0]
                self.assertEqual(
                    entry["spec"], f"{name}@={external.version} arch={external.architecture}",
                )
                self.assertFalse(config["packages"][name]["buildable"])
                self.assertEqual(external.namespace, original_namespace)

    def test_solver_external_namespace_mismatch_fails_before_build(self):
        self.add_external()
        impostor = Native(self.work, self.lock, self.store)
        impostor.hash_descriptor = self.native.hash_descriptor
        impostor.nodes[fixtures.DEP_HASH].namespace = "other"
        self.native.solved_root = impostor.roots[0]
        with self.assertRaisesRegex(audit.AuditError, "native-binding"):
            self.run_worker()
        self.assertTrue(any(call[0] == "solve" for call in self.native.calls))
        self.assertFalse(any(call[0] == "installer" for call in self.native.calls))

    def test_solver_dependency_architecture_mismatch_fails_before_build(self):
        self.add_external()
        impostor = Native(self.work, self.lock, self.store)
        impostor.hash_descriptor = self.native.hash_descriptor
        impostor.nodes[fixtures.DEP_HASH].architecture = "linux-ubuntu24.04-haswell"
        self.native.solved_root = impostor.roots[0]
        with self.assertRaisesRegex(audit.AuditError, "native-binding"):
            self.run_worker()
        self.assertTrue(any(call[0] == "solve" for call in self.native.calls))
        self.assertFalse(any(call[0] == "installer" for call in self.native.calls))

    def test_profile_granularity_preserves_full_solver_architecture_and_lock(self):
        self.add_external()
        for cpu_name, granularity in (
            ("x86_64", "generic"),
            ("x86_64_v3", "generic"),
            ("haswell", "microarchitectures"),
        ):
            with self.subTest(target=cpu_name):
                target_arch = "linux-ubuntu24.04-" + cpu_name
                self.profile["target"] = self.manifest["target"] = target_arch
                for node in self.lock["concrete_specs"].values():
                    node["arch"]["target"] = cpu_name
                self.work = self.base / ("work-" + cpu_name)
                self.work.mkdir(mode=0o700)
                self.native = Native(self.work, self.lock, self.store)
                for node in self.native.nodes.values():
                    node.architecture = target_arch
                cpu = self.native.modules["spack.vendor.archspec.cpu"]
                lock = copy.deepcopy(self.lock)
                with patch.object(cpu, "host", return_value=cpu.TARGETS[cpu_name]):
                    result = self.run_worker()
                self.assertEqual(self.native.solver_constraints, ["arch=" + target_arch])
                self.assertEqual(result["root"]["arch"], target_arch)
                self.assertEqual(self.native.config["concretizer"]["targets"], {
                    "host_compatible": True, "granularity": granularity,
                })
                self.assertEqual(self.native.config["packages"]["all"]["require"],
                                 ["arch=" + target_arch])
                self.assertEqual(self.lock, lock)
                self.assertTrue(all(str(node.architecture) == target_arch
                                    for node in self.native.nodes.values()))
                self.assertEqual((self.work / "env/spack.lock").read_bytes(),
                                 (self.input / "blobs" /
                                  self.manifest["lockfile"]["digest"][7:]).read_bytes())

    def test_install_uses_native_solver_installer_store_and_root_only_report(self):
        self.add_external()
        result = self.run_worker()
        self.assertEqual(result, {
            "version": 1, "validation": "isolated-install", "action": "install",
            "manifestDigest": self.request["manifestDigest"],
            "siteProfileDigest": self.request["siteProfileDigest"],
            "storePath": str(self.store),
            "root": {"name": "hello", "version": "1.0", "hash": fixtures.ROOT_HASH,
                     "arch": self.profile["target"], "spec": self.manifest["spec"]},
            "prefix": str(self.store / "hello"), "installedHashes": [fixtures.ROOT_HASH],
        })
        names = [c[0] for c in self.native.calls]
        self.assertLess(names.index("solve"), names.index("installer"))
        self.assertIn(("store", str(self.store)), self.native.calls)
        self.assertEqual(self.native.install_options["use_cache"], False)
        self.assertEqual(self.native.install_options["package_use_cache"], False)
        self.assertEqual(self.native.install_options["dependencies_use_cache"], False)
        self.assertEqual(self.native.install_options["explicit"], True)
        self.assertEqual(self.native.config["config"]["concretization_cache"], {"enable": False})
        self.assertEqual(self.native.solver_constraints, ["arch=" + self.profile["target"]])
        external = self.native.config["packages"]["gcc"]["externals"][0]
        self.assertNotIn("/" + fixtures.DEP_HASH, external["spec"])
        self.assertEqual(external["extra_attributes"]["compilers"]["c"], str(self.compiler))
        self.assertEqual((self.work / "env/spack.lock").read_bytes(),
                         (self.input / "blobs" / self.manifest["lockfile"]["digest"][7:]).read_bytes())

    def test_audit_failure_prevents_solver_and_install(self):
        self.native.check_error = True
        with self.assertRaises(audit.AuditError):
            self.run_worker()
        self.assertFalse(any(c[0] in ("solve", "installer") for c in self.native.calls))

    def test_solver_mismatch_and_unavailable_fail_closed(self):
        for failure in ("hash", "missing-solver"):
            with self.subTest(failure=failure):
                if failure == "hash":
                    self.native.solved_root = InstallSpec(
                        self.native, fixtures.DEP_HASH, self.lock["concrete_specs"][fixtures.ROOT_HASH]
                    )
                else:
                    self.native.solver_error = ImportError("SECRET /private clingo")
                with self.assertRaises((audit.AuditError, ImportError)):
                    self.run_worker()
                self.assertNotIn(("installer",), self.native.calls)
                # Each attempt is an independent empty scratch environment.
                self.work = self.base / ("work-" + failure)
                self.work.mkdir(mode=0o700)
                self.native = Native(self.work, self.lock, self.store)

    def test_verify_and_load_use_native_db_not_install_or_temporary_prefix(self):
        for action in ("verify", "load"):
            with self.subTest(action=action):
                result = self.run_worker(action)
                self.assertEqual(result["prefix"], str(self.store / "hello"))
                self.assertEqual("loadShell" in result, action == "load")
                if action == "load":
                    self.assertEqual(result["loadShell"], self.native.shell)
                self.assertNotIn(("installer",), self.native.calls)
                self.assertIn(("spec-json",), self.native.calls)
                self.work = self.base / ("work-" + action)
                self.work.mkdir(mode=0o700)
                self.native = Native(self.work, self.lock, self.store)

    def test_load_shell_allows_only_the_exact_verified_transaction_prefix(self):
        store = Path("/srv/kq/spack/releases/fixture-1")
        for shell in (
            f"export PATH='{store}/hello/bin:/usr/bin';\n",
            f'export CMAKE_PREFIX_PATH="{store}/hello:{store}/gcc-runtime";\n',
            f"export PREFIX={store};\n",
            f"export PREFIX='{store}'",
            f"export PREFIX={store}",
        ):
            with self.subTest(shell=shell):
                self.assertEqual(worker.validate_load_shell(shell, store), shell)
        for shell in (
            f"export PATH='{store}/hello/bin:/kq/work/bin';\n",
            f'export DATA="{store}/hello:/kq/input";\n',
            f"export PATH='{store}-other/hello/bin';\n",
            f"export PATH='/unapproved{store}/hello/bin';\n",
            f"export PREFIX='-I{store}/hello';\n",
            "export PATH='/tmp/../kq/work/bin';\n",
            "export PREFIX=/kq",
            "export PREFIX='/kq';\n",
            'export PREFIX="/kq";\n',
            "export PATH='/kq:/usr/bin';\n",
            "export PREFIX='/kq/input';\n",
            "export PREFIX='/kq/work';\n",
            "\x00",
            "x" * (256 * 1024 + 1),
            None,
        ):
            with self.subTest(shell=repr(shell)[:80]):
                with self.assertRaises(audit.AuditError):
                    worker.validate_load_shell(shell, store)
        dotted = Path("/srv/kq/spack/releases/fixture.1+")
        shell = f"export PREFIX='{dotted}/hello';\n"
        self.assertEqual(worker.validate_load_shell(shell, dotted), shell)
        with self.assertRaises(audit.AuditError):
            worker.validate_load_shell(
                "export PREFIX='/srv/kq/spack/releases/fixtureX111/hello';\n", dotted
            )

    def test_load_validates_native_shell_against_its_real_store_without_installing(self):
        shell = f"export PATH='{self.store}/hello/bin:/usr/bin';\n"
        self.native.shell = shell
        with patch.object(worker, "validate_load_shell", wraps=worker.validate_load_shell) as check:
            result = self.run_worker("load")
        check.assert_called_once_with(shell, self.store)
        self.assertEqual(result["loadShell"], shell)
        self.assertNotIn(("installer",), self.native.calls)

    def test_db_missing_uninstalled_upstream_or_wrong_prefix_rejected(self):
        for failure in ("missing", "uninstalled", "upstream", "prefix", "hash"):
            with self.subTest(failure=failure):
                record = self.native.records[fixtures.ROOT_HASH]
                if failure == "missing":
                    self.native.records.clear()
                elif failure == "uninstalled":
                    record.installed = False
                elif failure == "upstream":
                    self.native.upstream = True
                elif failure == "prefix":
                    record.path = "/kq/work/store/hello"
                else:
                    record.spec = InstallSpec(
                        self.native, fixtures.DEP_HASH, self.lock["concrete_specs"][fixtures.ROOT_HASH]
                    )
                with self.assertRaises(audit.AuditError):
                    self.run_worker("verify")
                self.work = self.base / ("work-" + failure)
                self.work.mkdir(mode=0o700)
                self.native = Native(self.work, self.lock, self.store)

    def test_output_tree_permissions_special_hardlinks_and_symlinks(self):
        worker.verify_tree(self.store, self.profile)
        target = self.store / "unsafe"
        for failure in ("write-file", "write-dir", "fifo", "hardlink", "scratch",
                        "escape", "dangling"):
            with self.subTest(failure=failure):
                if failure == "write-file":
                    target.write_text("bad")
                    target.chmod(0o666)
                elif failure == "write-dir":
                    target.mkdir(mode=0o777)
                    target.chmod(0o777)
                elif failure == "fifo":
                    os.mkfifo(target)
                elif failure == "hardlink":
                    os.link(self.store / ".spack-db/index.json", target)
                else:
                    target.symlink_to({
                        "scratch": "/kq/work/source",
                        "escape": "../../outside", "dangling": "missing",
                    }[failure])
                with self.assertRaises(audit.AuditError):
                    worker.verify_tree(self.store, self.profile)
                if target.is_dir() and not target.is_symlink():
                    target.rmdir()
                else:
                    target.unlink()
        target.symlink_to("hello")
        worker.verify_tree(self.store, self.profile)
        target.unlink()
        target.symlink_to(self.compiler)
        worker.verify_tree(self.store, self.profile)

    def test_output_tree_accepts_same_store_absolute_and_relative_symlinks(self):
        wrapper = self.store / "compiler-wrapper/libexec/spack"
        (wrapper / "gcc").mkdir(parents=True)
        script = wrapper / "cc"
        script.write_text("fixture compiler wrapper, never executed\n")
        script.chmod(0o755)
        links = {
            wrapper / "gcc/gcc": script,
            wrapper / "ld": "cc",
            wrapper / "c99": wrapper / "gcc/gcc",
            self.store / "wrapper-bin": wrapper,
        }
        for link, target in links.items():
            link.symlink_to(target)
            self.assertTrue(worker.within(link.resolve(strict=True), self.store))
        worker.verify_tree(self.store, self.profile)

    def test_output_tree_rejects_resolved_symlink_escape_to_other_transaction_or_scratch(self):
        other = self.store.with_name(self.store.name + "-other")
        other.mkdir()
        (other / "cc").write_text("other transaction\n")
        scratch = self.work / "cc"
        scratch.write_text("scratch output\n")
        alias = self.base / "other-alias"
        alias.symlink_to(other, target_is_directory=True)
        link = self.store / "unsafe"
        for target in (
            other / "cc", "../" + other.name + "/cc",
            self.store / ".." / other.name / "cc", alias / "cc", scratch,
        ):
            with self.subTest(target=str(target)):
                link.symlink_to(target)
                try:
                    self.assertTrue(link.resolve(strict=True).is_file())
                    with self.assertRaisesRegex(audit.AuditError, "^output-symlink$"):
                        worker.verify_tree(self.store, self.profile)
                finally:
                    link.unlink()

    def test_output_tree_rejects_absolute_dangling_and_cyclic_symlinks(self):
        link = self.store / "unsafe"
        cycle = self.store / "cycle"
        for failure in ("dangling", "self-cycle", "two-link-cycle"):
            with self.subTest(failure=failure):
                target = self.store / "missing" if failure == "dangling" else link
                if failure == "two-link-cycle":
                    cycle.symlink_to(link)
                    target = cycle
                link.symlink_to(target)
                try:
                    with self.assertRaisesRegex(audit.AuditError, "^invalid-path$"):
                        worker.verify_tree(self.store, self.profile)
                finally:
                    link.unlink()
                    if cycle.is_symlink():
                        cycle.unlink()

    def test_database_symlinks_rejected_even_when_target_is_in_same_store(self):
        link = self.store / ".spack-db/index_verifier"
        for target in (self.store / "hello/.spack/spec.json", "../hello/.spack/spec.json"):
            with self.subTest(target=str(target)):
                link.symlink_to(target)
                try:
                    self.assertTrue(worker.within(link.resolve(strict=True), self.store))
                    with self.assertRaisesRegex(audit.AuditError, "^database-path$"):
                        worker.verify_tree(self.store, self.profile)
                finally:
                    link.unlink()

    def test_tree_and_native_metadata_budgets(self):
        with patch.object(worker, "MAX_ENTRIES", 2), self.assertRaises(audit.AuditError):
            worker.verify_tree(self.store, self.profile)
        metadata = self.store / "hello/.spack/spec.json"
        with metadata.open("wb") as stream:
            stream.truncate(worker.MAX_SPEC_BYTES + 1)
        with self.assertRaises(audit.AuditError):
            worker.verify_tree(self.store, self.profile)
        self.assertNotIn(("spec-json",), self.native.calls)

    def test_db_auxiliary_metadata_is_bounded_before_native_db(self):
        with (self.store / ".spack-db/index_verifier").open("wb") as stream:
            stream.truncate(audit.CHUNK + 1)
        with self.assertRaises(audit.AuditError):
            self.run_worker("verify")
        self.assert_no_recipes()

    def test_native_db_auxiliary_files_cannot_bypass_bounds_with_symlinks(self):
        (self.store / ".spack-db/index_verifier").symlink_to(self.compiler)
        with self.assertRaises(audit.AuditError):
            self.run_worker("verify")
        self.assert_no_recipes()

    def test_native_db_root_external_bindings_are_rechecked_for_load(self):
        self.add_external()
        impostor = Native(self.work, copy.deepcopy(self.lock), self.store)
        impostor.hash_descriptor = self.native.hash_descriptor
        impostor.nodes[fixtures.DEP_HASH].external_path = "/unapproved"
        self.native.records[fixtures.ROOT_HASH].spec = impostor.roots[0]
        with self.assertRaises(audit.AuditError):
            self.run_worker("load")
        self.assertFalse(any(c[0] == "load" for c in self.native.calls))

    def test_all_nonexternal_dependencies_must_be_installed(self):
        node = self.add_external()
        del node["external"]
        self.profile["externals"] = []
        self.native = Native(self.work, self.lock, self.store)
        self.make_output()
        self.native.records[fixtures.DEP_HASH].installed = False
        with self.assertRaises(audit.AuditError):
            self.run_worker("verify")
        self.assertNotIn(("installer",), self.native.calls)

    def test_solver_full_dag_mismatch_even_if_root_hash_matches(self):
        self.add_external()
        solved = InstallSpec(
            self.native, fixtures.ROOT_HASH, self.lock["concrete_specs"][fixtures.ROOT_HASH]
        )
        solved.dependencies = lambda: []
        self.native.solved_root = solved
        with self.assertRaises(audit.AuditError):
            self.run_worker()
        self.assertNotIn(("installer",), self.native.calls)

    def test_missing_preinstalled_clingo_never_installs_or_bootstraps(self):
        self.native.modules["clingo"] = None
        with self.assertRaises(ImportError):
            self.run_worker()
        self.assertFalse(any(c[0] in ("solve", "installer") for c in self.native.calls))

    def test_store_json_size_rejected_before_audit(self):
        with (self.store / ".spack-db/index.json").open("wb") as stream:
            stream.truncate(worker.MAX_DB_BYTES + 1)
        with self.assertRaises(audit.AuditError):
            self.run_worker("verify")
        self.assert_no_recipes()

    def test_readonly_load_repeats_source_audit(self):
        source = self.input / "blobs" / self.manifest["sources"][0]["blob"]["digest"][7:]
        source.write_bytes(b"x" * source.stat().st_size)
        with self.assertRaises(audit.AuditError):
            self.run_worker("load")
        self.assertFalse(any(c[0] in ("solve", "installer", "load") for c in self.native.calls))

    def test_failure_restores_umask_and_does_not_report(self):
        before = os.umask(0o077)
        self.addCleanup(os.umask, before)
        self.native.install_error = RuntimeError("SECRET")
        output, errors = io.StringIO(), io.StringIO()
        with self.runtime(), patch.object(sys, "argv", ["worker"]):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                self.assertEqual(worker.main(self.input, self.work), 1)
        previous = os.umask(0o077)
        self.assertEqual(previous, 0o077)
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn("SECRET", errors.getvalue())

    def test_mount_parser_reads_vfs_not_superblock_and_decodes_paths(self):
        mountinfo = (
            b"1 0 0:1 / / ro - squashfs image ro\n"
            b"2 1 0:2 / /srv/store/release ro,nosuid - ext4 disk rw\n"
            b"3 1 0:3 / /srv/store/release/hidden\\040child ro - tmpfs tmpfs rw\n"
        )
        original = Path.open

        def open_file(path, *args, **kwargs):
            if str(path) == "/proc/self/mountinfo":
                return io.BytesIO(mountinfo)
            return original(path, *args, **kwargs)

        with patch.object(Path, "open", open_file):
            mounts = worker.mount_table()
        self.assertEqual(mounts[1], (Path("/srv/store/release"), {"ro", "nosuid"}, "ext4"))
        self.assertEqual(mounts[2][0], Path("/srv/store/release/hidden child"))

    def test_runtime_rejects_writable_host_mount_and_non_tmpfs_work(self):
        mounts = self.mounts()
        for invalid in (
            mounts + [(Path("/srv/other"), {"rw"}, "ext4")],
            [m if m[0] != self.work else (self.work, {"rw"}, "ext4") for m in mounts],
            mounts + [(self.work / "nested", {"ro"}, "tmpfs")],
        ):
            with self.subTest(mounts=invalid), self.assertRaises(audit.AuditError):
                worker.verify_scratch(self.input, self.work, self.store, invalid)

    def test_apptainer_session_scratch_0755_is_tightened_before_audit_for_all_actions(self):
        for rootfs in ("squashfs", "overlay"):
            for action in ("install", "verify", "load"):
                with self.subTest(rootfs=rootfs, action=action):
                    self.work = self.base / ("scratch-" + rootfs + "-" + action)
                    self.work.mkdir(mode=0o755)
                    self.work.chmod(0o755)
                    self.native = Native(self.work, self.lock, self.store)
                    self.request["action"] = action
                    self.save_request()
                    mounts = self.parse_mountinfo(self.scratch_mountinfo(action, rootfs))
                    self.assertIn((self.work, {"rw", "nosuid", "nodev"}, "tmpfs"), mounts)
                    original_audit = audit.audit

                    def audited(*args):
                        self.assertEqual(self.work.stat().st_mode & 0o7777, 0o700)
                        self.assertEqual(list(self.work.iterdir()), [])
                        return original_audit(*args)

                    with self.runtime(), patch.object(worker, "mount_table", return_value=mounts):
                        with patch.object(audit, "audit", side_effect=audited) as invoked:
                            result = worker.run(self.input, self.work)
                    self.assertEqual(result["action"], action)
                    invoked.assert_called_once()

    def test_scratch_0700_needs_no_chmod(self):
        with patch.object(os, "fchmod") as chmod:
            worker.verify_scratch(self.input, self.work, self.store, self.mounts())
        chmod.assert_not_called()

    def test_scratch_0755_no_chmod_until_all_mounts_are_safe(self):
        self.work.chmod(0o755)
        valid = self.parse_mountinfo(self.scratch_mountinfo())
        session = Path("/var/apptainer/mnt/session")
        invalid_mounts = [
            [m for m in valid if m[0] != self.work],
            valid + [(self.work, {"rw"}, "tmpfs")],
            valid + [(self.work / "nested", {"ro"}, "tmpfs")],
            [m if m[0] != self.work else (self.work, {"ro"}, "tmpfs") for m in valid],
            [m if m[0] != self.work else (self.work, {"ro", "rw"}, "tmpfs") for m in valid],
            [m if m[0] != self.work else (self.work, {"rw"}, "ext4") for m in valid],
            [m if m[0] != self.work else (self.work, {"rw"}, "ramfs") for m in valid],
            [m if m[0] != self.input else (self.input, {"rw"}, "ext4") for m in valid],
            [m if m[0] != Path("/") else (Path("/"), {"rw"}, "overlay") for m in valid],
            [m if m[0] != session else (session, {"rw"}, "ext4") for m in valid],
        ]
        for mounts in invalid_mounts:
            with self.subTest(mounts=mounts), patch.object(os, "fchmod") as chmod:
                with self.assertRaises(audit.AuditError):
                    worker.verify_scratch(self.input, self.work, self.store, mounts)
                chmod.assert_not_called()
                self.assertEqual(self.work.stat().st_mode & 0o7777, 0o755)

    def test_scratch_unsafe_permissions_owner_nonempty_or_symlink_never_chmod(self):
        for mode in (0o775, 0o757, 0o777, 0o1755, 0o2755, 0o4755, 0o555):
            with self.subTest(mode=oct(mode)), patch.object(os, "fchmod") as chmod:
                self.work.chmod(mode)
                with self.assertRaises(audit.AuditError):
                    worker.verify_scratch(self.input, self.work, self.store, self.mounts())
                chmod.assert_not_called()
        self.work.chmod(0o755)
        with patch.object(os, "fchmod") as chmod:
            with patch.object(os, "getuid", return_value=self.work.stat().st_uid + 1):
                with self.assertRaises(audit.AuditError):
                    worker.verify_scratch(self.input, self.work, self.store, self.mounts())
            (self.work / "not-empty").write_text("fixture")
            with self.assertRaises(audit.AuditError):
                worker.verify_scratch(self.input, self.work, self.store, self.mounts())
            alias = self.base / "scratch-alias"
            alias.symlink_to(self.work, target_is_directory=True)
            with self.assertRaises(audit.AuditError):
                worker.verify_scratch(
                    self.input, alias, self.store, self.mounts() + [(alias, {"rw"}, "tmpfs")]
                )
            chmod.assert_not_called()

    def test_visible_session_tmpfs_allowed_but_rw_overlay_still_fails(self):
        valid = self.parse_mountinfo(self.scratch_mountinfo())
        worker.verify_scratch(self.input, self.work, self.store, valid)
        invalid = [m if m[0] != Path("/") else (Path("/"), {"rw"}, "overlay") for m in valid]
        with self.assertRaisesRegex(audit.AuditError, "^writable-host-mount$"):
            worker.verify_scratch(self.input, self.work, self.store, invalid)

    def test_output_symlink_to_approved_external_and_symlink_cycle(self):
        self.add_external()
        external = Path(self.profile["externals"][0]["prefix"])
        (external / "include").mkdir()
        link = self.store / "link"
        link.symlink_to(external / "include")
        worker.verify_tree(self.store, self.profile)
        link.unlink()
        link.symlink_to("cycle")
        (self.store / "cycle").symlink_to("link")
        with self.assertRaises(audit.AuditError):
            worker.verify_tree(self.store, self.profile)

    def test_root_prefix_symlink_rejected(self):
        prefix = self.store / "hello"
        renamed = self.store / "other"
        prefix.rename(renamed)
        prefix.symlink_to("other")
        with self.assertRaises(audit.AuditError):
            self.run_worker("verify")

    def test_main_no_args_single_report_fixed_errors_and_native_fd_output(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with self.runtime(), patch.object(sys, "argv", ["install_worker.py"]):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(worker.main(self.input, self.work), 0)
        lines = stdout.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("KQ_SPACK_INSTALL_RESULT:"))
        stdout, stderr = io.StringIO(), io.StringIO()

        def noisy(*args):
            print("SECRET https://private/path")
            os.write(1, b"SECRET fd1 /private/path\n")
            os.write(2, b"SECRET fd2\n")
            raise RuntimeError("SECRET")

        with patch.object(worker, "run", side_effect=noisy):
            with patch.object(sys, "argv", ["install_worker.py"]):
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    self.assertEqual(worker.main(self.input, self.work), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn("SECRET", stderr.getvalue())
        self.assertIn("install-worker-failed", stderr.getvalue())
        with patch.object(worker, "run") as run:
            with patch.object(sys, "argv", ["worker", "unexpected-secret"]):
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(worker.main(self.input, self.work), 1)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()

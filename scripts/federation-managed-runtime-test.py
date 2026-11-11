"""Managed AIO trust, store and bootstrap fixtures; never starts a container or service."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("managed", ROOT / "deploy/federation/aio/managed.py")
managed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(managed)


class ManagedRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = {
            stem + suffix: value for stem in ("AGENT_SPACK_AUDIT_APPTAINER", "AGENT_SPACK_AUDIT_SIF",
                                              "AGENT_SPACK_INSTALL_SITE_PROFILE", "AGENT_SANDBOX_SIF_PUBLIC_KEY")
            for suffix, value in (("_PATH", "/opt/kq/runtime/" + stem.lower()), ("_SHA256", "a" * 64))
        }
        self.env.update(AGENT_SANDBOX_PUBLIC_KEYS_JSON='{"server-key":"public-only"}',
                        AGENT_SANDBOX_RUNTIME_CACHE_JSON='{"sha256:example":{"kind":"SIF"}}')

    def tearDown(self):
        self.temp.cleanup()

    def environment(self, env=None, store="/srv/kq/spack"):
        values = {"version": 1, "environment": self.env if env is None else env}
        with patch.object(managed, "read_json", side_effect=[values, {"storeRoot": store}]), \
             patch.object(managed, "protected", return_value=SimpleNamespace(st_mode=0o100444)), \
             patch.object(managed, "sha256", return_value="a" * 64), \
             patch.dict(os.environ, {"KQ_AGENT_REGISTRATION_SCHEDULER": "slurm"}):
            return managed.runtime_environment()

    def test_runtime_uses_production_checks_without_root_or_implicit_approvals(self):
        env = self.environment()
        self.assertEqual(env["AGENT_SPACK_INSTALL_ENABLED"], "true")
        self.assertEqual(env["AGENT_SPACK_AUDIT_ENABLED"], "true")
        self.assertEqual(env["AGENT_SLURM_TERMINAL_STATUS_BACKEND"], "sacct")
        self.assertEqual(env["AGENT_SPAWNER_BACKEND"], "host")
        self.assertEqual(env["AGENT_SANDBOX_EXECUTION_MODE"], "self-account")
        self.assertEqual(env["AGENT_SANDBOX_ROOT_IMPERSONATION"], "false")
        self.assertEqual(env["AGENT_SANDBOX_ATTESTATION_QUEUE"], "debug")
        self.assertNotIn("sharedStoreConfirmed", env)
        self.assertNotIn("quotaEnforcedBySite", env)
        self.assertNotIn("AGENT_ID", env)

    def test_runtime_file_cannot_override_identity_or_execute_shell_environment(self):
        for name, value in (("AGENT_ID", "other-agent"), ("NODE_OPTIONS", "--import malicious"),
                            ("AGENT_SANDBOX_ROOT_IMPERSONATION", "true"),
                            ("AGENT_SPACK_MANAGED_MEMORY_MIB", 1024),
                            ("AGENT_SPACK_MANAGED_MEMORY_MIB", "1024\nOTHER=value")):
            with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                self.environment({**self.env, name: value})

    def test_missing_pin_or_unbounded_store_fails_before_start(self):
        for name in ("AGENT_SPACK_AUDIT_SIF_SHA256", "AGENT_SPACK_INSTALL_SITE_PROFILE_PATH",
                     "AGENT_SANDBOX_SIF_PUBLIC_KEY_SHA256", "AGENT_SANDBOX_PUBLIC_KEYS_JSON"):
            env = self.env.copy()
            del env[name]
            with self.subTest(missing=name), self.assertRaises((ValueError, FileNotFoundError, KeyError)):
                self.environment(env)
        with self.assertRaisesRegex(ValueError, "bounded store"):
            self.environment(store="/arbitrary/unlimited")

    def test_runtime_configuration_rejects_non_objects_and_boolean_version(self):
        for value in ([], None, {"version": True, "environment": self.env}):
            with self.subTest(value=value), patch.object(managed, "read_json", return_value=value), \
                 self.assertRaises(ValueError):
                managed.runtime_environment()

    def test_replaced_or_writable_runtime_is_rejected(self):
        for mode, checksum in ((0o100444, "b" * 64), (0o100644, "a" * 64)):
            with self.subTest(mode=mode), \
                 patch.object(managed, "read_json", return_value={"version": 1, "environment": self.env}), \
                 patch.object(managed, "protected", return_value=SimpleNamespace(st_mode=mode)), \
                 patch.object(managed, "sha256", return_value=checksum), \
                 self.assertRaises(ValueError):
                managed.runtime_environment()

    def test_protected_runtime_refuses_links_and_writable_files(self):
        path = self.root / "public.json"
        path.write_text("{}")
        link = self.root / "linked"
        link.symlink_to(path)
        with self.assertRaisesRegex(ValueError, "canonical"):
            managed.protected(link)
        path.chmod(0o666)
        with self.assertRaises(ValueError):
            managed.protected(path)

    def disk_fixture(self):
        original = Path.lstat
        def owned(path):
            info = original(path)
            return SimpleNamespace(st_mode=info.st_mode, st_uid=0, st_size=info.st_size, st_nlink=info.st_nlink)
        return patch.object(managed.Path, "lstat", owned)

    def test_store_is_formatted_once_and_existing_data_is_not_recreated(self):
        size = 1024 ** 3
        with self.disk_fixture(), patch.object(managed, "protected", side_effect=lambda path: path.lstat()), \
             patch.object(managed.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * size)), \
             patch.object(managed, "run") as commands:
            path = managed.prepare_store(self.root, size)
            self.assertEqual(path.stat().st_size, size)
            with path.open("r+b") as stream:
                stream.write(b"retained datastore")
            self.assertEqual(managed.prepare_store(self.root, size), path)
            commands.assert_called_once()
            with path.open("rb") as stream:
                self.assertEqual(stream.read(18), b"retained datastore")
            with self.assertRaisesRegex(ValueError, "maintenance"):
                managed.prepare_store(self.root, size * 2)

    def test_failed_format_leaves_exclusive_checkpoint_and_cannot_retry_blindly(self):
        size = 1024 ** 3
        with self.disk_fixture(), \
             patch.object(managed.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * size)), \
             patch.object(managed, "run", side_effect=subprocess.CalledProcessError(1, "mkfs")) as commands:
            with self.assertRaises(subprocess.CalledProcessError):
                managed.prepare_store(self.root, size)
            self.assertFalse((self.root / "store.ext4").exists())
            self.assertTrue((self.root / "store.ext4.creating").exists())
            with self.assertRaises(FileExistsError):
                managed.prepare_store(self.root, size)
            commands.assert_called_once()

    def test_invalid_budget_or_disk_full_does_not_create_a_store(self):
        with self.disk_fixture(), patch.object(managed.shutil, "disk_usage", return_value=SimpleNamespace(free=1)), \
             patch.object(managed, "run") as commands:
            for size in (True, 1, 17 * 1024 ** 3, 1024 ** 3):
                with self.subTest(size=size), self.assertRaises(ValueError):
                    managed.prepare_store(self.root, size)
            self.assertEqual(list(self.root.iterdir()), [])
            commands.assert_not_called()

    def test_managed_agent_cannot_run_as_root_and_basic_mode_keeps_original_entry(self):
        with patch.dict(os.environ, {"KQ_AIO_MANAGED_RUNTIME": "1"}), \
             patch.object(managed.os, "getuid", return_value=0), patch.object(managed.os, "execv") as execute:
            with self.assertRaisesRegex(ValueError, "isolated kq account"):
                managed.main("agent")
            execute.assert_not_called()
        with patch.dict(os.environ, {"KQ_AIO_MANAGED_RUNTIME": "0"}), \
             patch.object(managed.os, "execv", side_effect=RuntimeError("exec replacement")) as execute:
            with self.assertRaisesRegex(RuntimeError, "exec replacement"):
                managed.main("agent")
            self.assertEqual(execute.call_args.args[1][-1], "/usr/local/lib/kuintessence/start-agent.py")

    def test_host_or_foreign_cgroup_cannot_be_bootstrapped(self):
        with patch.dict(os.environ, {"KQ_AIO_MANAGED_RUNTIME": "1"}), \
             patch.object(managed.os, "getuid", return_value=0), patch.object(managed.os, "getpid", return_value=1), \
             patch.object(managed.Path, "read_text", return_value="0::/foreign\n"), \
             patch.object(managed.os, "execv") as execute, patch.object(managed, "run") as commands:
            with self.assertRaisesRegex(ValueError, "private container"):
                managed.main("init")
            execute.assert_not_called()
            commands.assert_not_called()

    def test_managed_agent_receives_own_home_and_user_bus(self):
        with patch.dict(os.environ, {"KQ_AIO_MANAGED_RUNTIME": "1", "HOME": "/root"}), \
             patch.object(managed.os, "getuid", return_value=1000), \
             patch.object(managed, "runtime_environment", return_value={}), \
             patch.object(managed.Path, "mkdir"), \
             patch.object(managed.os, "execv", side_effect=RuntimeError("exec replacement")):
            with self.assertRaisesRegex(RuntimeError, "exec replacement"):
                managed.main("agent")
            self.assertEqual(os.environ["HOME"], "/home/kq")
            self.assertEqual(os.environ["USER"], "kq")
            self.assertEqual(os.environ["XDG_RUNTIME_DIR"], "/run/user/1000")
            self.assertEqual(os.environ["DBUS_SESSION_BUS_ADDRESS"], "unix:path=/run/user/1000/bus")

    def test_pbs_foreign_slice_rejected_before_any_filesystem_write(self):
        with patch.object(managed, "run", side_effect=[SimpleNamespace(), SimpleNamespace(stdout="/../../foreign")]) as commands:
            with self.assertRaisesRegex(ValueError, "PBS job slice"):
                managed.install_pbs_hook()
            self.assertEqual(commands.call_count, 2)

    def test_slurm_accounting_password_is_private_and_not_shell_or_config_input(self):
        password = self.root / "slurm-db-password"
        config = self.root / "slurmdbd.conf"
        with patch.object(managed, "RUNTIME", self.root), \
             patch.object(managed, "protected", side_effect=lambda path: path.stat()), \
             patch.object(managed.shutil, "chown"):
            for value, mode in (("a" * 64, 0o644), ("a" * 64 + "\nInjected=value", 0o600),
                                ("$(false)", 0o600)):
                password.write_text(value)
                password.chmod(mode)
                with self.subTest(value=value, mode=mode), self.assertRaises(ValueError):
                    managed.prepare_slurm_accounting(config)
                self.assertFalse(config.exists())
            password.write_text("a" * 64 + "\n")
            password.chmod(0o600)
            managed.prepare_slurm_accounting(config)
            self.assertIn("StorageHost=scheduler-accounting\n", config.read_text())
            self.assertIn("StoragePass=" + "a" * 64 + "\n", config.read_text())
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)

    def test_slurm_accounting_reuses_existing_associations_without_mutation(self):
        values = ["kq-aio-slurm\n", "kq-aio\n", "kq-aio-slurm|kq-aio|kq\n"]
        with patch.object(managed.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
             patch.object(managed, "run", side_effect=[SimpleNamespace(stdout=value) for value in values]) as calls:
            managed.register_slurm_accounting()
            self.assertEqual(calls.call_count, 3)
            self.assertTrue(all("add" not in c.args[0] for c in calls.call_args_list))

    def test_slurm_accounting_initializes_only_missing_fixed_associations(self):
        existing = {}
        added = []
        values = {"cluster": "kq-aio-slurm", "account": "kq-aio", "association": "kq-aio-slurm|kq-aio|kq"}
        def execute(argv, **_kwargs):
            if "add" in argv:
                kind = argv[3]
                existing["association" if kind == "user" else kind] = True
                added.append(argv)
                return SimpleNamespace()
            return SimpleNamespace(stdout=values[argv[3]] if existing.get(argv[3]) else "")
        with patch.object(managed.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
             patch.object(managed, "run", side_effect=execute):
            managed.register_slurm_accounting()
            managed.register_slurm_accounting()
        self.assertEqual(added, [
            ["sacctmgr", "-i", "add", "cluster", "kq-aio-slurm"],
            ["sacctmgr", "-i", "add", "account", "kq-aio", "Cluster=kq-aio-slurm"],
            ["sacctmgr", "-i", "add", "user", "kq", "Account=kq-aio", "Cluster=kq-aio-slurm"],
        ])

    def test_slurm_accounting_failure_or_foreign_identity_cannot_register(self):
        with patch.object(managed.subprocess, "run", return_value=SimpleNamespace(returncode=1)), \
             patch.object(managed.time, "sleep"), patch.object(managed, "run") as calls:
            with self.assertRaisesRegex(ValueError, "ready"):
                managed.register_slurm_accounting()
            calls.assert_not_called()
        with patch.object(managed.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
             patch.object(managed, "run", return_value=SimpleNamespace(stdout="foreign-cluster")) as calls:
            with self.assertRaisesRegex(ValueError, "reconciliation"):
                managed.register_slurm_accounting()
            calls.assert_called_once()

    def test_slurm_accounting_cannot_be_bootstrapped_by_agent_or_pbs(self):
        for uid, scheduler in ((1000, "slurm"), (0, "pbs-pro")):
            with self.subTest(uid=uid, scheduler=scheduler), \
                 patch.dict(os.environ, {"KQ_AIO_MANAGED_RUNTIME": "1", "KQ_AGENT_REGISTRATION_SCHEDULER": scheduler}), \
                 patch.object(managed.os, "getuid", return_value=uid), \
                 patch.object(managed, "prepare_slurm_accounting") as setup:
                with self.assertRaises(ValueError):
                    managed.main("slurm-accounting")
                setup.assert_not_called()


class SchedulerDownloadTests(unittest.TestCase):
    def download(self, component, overrides=None, expected_default=None):
        source = ROOT / "deploy/schedulers" / ("pbs/Dockerfile" if component == "OPENPBS" else "base/Dockerfile")
        text = source.read_text()
        variable = component + "_SHA256"
        start = text.index(f'if [[ -z "${{{variable}}}" ]]')
        stop = text.index("  && " + ("mv " if component == "BUN" else "rm -f "), start)
        script = text[start:stop].rstrip().removesuffix("\\").rstrip()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = script.replace("/tmp/", directory + "/")
            env = {**os.environ, "BUN_VERSION": "1.4.2", "bun_arch": "x64", "SPACK_REF": "v1.0.3",
                   "OPENPBS_REF": "v23.06.06", variable: "", **(overrides or {}),
                   "DOWNLOAD_MARKER": str(root / "downloaded"), "UNPACK_MARKER": str(root / "unpacked")}
            helpers = '''curl() { printf 'fixture archive' > "${@: -1}"; touch "$DOWNLOAD_MARKER"; }
unzip() { touch "$UNPACK_MARKER"; }
tar() { touch "$UNPACK_MARKER"; }
'''
            if expected_default:
                env["EXPECTED_SHA256"] = expected_default
                helpers += 'sha256sum() { read -r checksum filename; [[ "$checksum" == "$EXPECTED_SHA256" ]]; }\n'
            result = subprocess.run(["bash", "-o", "pipefail", "-c", helpers + script], env=env,
                                    capture_output=True, text=True, timeout=5)
            return result.returncode, (root / "downloaded").exists(), (root / "unpacked").exists()

    def test_downloads_verify_bytes_before_extracting(self):
        checksum = hashlib.sha256(b"fixture archive").hexdigest()
        for component in ("BUN", "SPACK", "OPENPBS"):
            for expected, succeeded in ((checksum, True), ("0" * 64, False)):
                with self.subTest(component=component, succeeded=succeeded):
                    status, downloaded, unpacked = self.download(component, {component + "_SHA256": expected})
                    self.assertTrue(downloaded)
                    self.assertEqual(status == 0, succeeded)
                    self.assertEqual(unpacked, succeeded)

    def test_known_versions_keep_their_official_archive_pins(self):
        pins = (
            ("BUN", {"bun_arch": "x64"}, "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913"),
            ("BUN", {"bun_arch": "aarch64"}, "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7"),
            ("SPACK", {"SPACK_REF": "v1.0.3"}, "84cb2f2ef0230d9b3913277202f5fa53ad26ae8fdbc6d46985bbc3f866031581"),
            ("SPACK", {"SPACK_REF": "v1.0.0"}, "70dceb9abdf1225d596714522a0fc4d0290e8c5496f1bae8192ffe611b60cfa1"),
            ("OPENPBS", {}, "689df6caa101422237118d81f9cfb0e6cad432209c77a6b3b8021cf984a91a90"),
        )
        for component, overrides, checksum in pins:
            with self.subTest(component=component, overrides=overrides):
                self.assertEqual(self.download(component, overrides, checksum), (0, True, True))

    def test_unknown_versions_require_explicit_pins_before_downloading(self):
        for component, selector in (("BUN", "BUN_VERSION"), ("SPACK", "SPACK_REF"), ("OPENPBS", "OPENPBS_REF")):
            with self.subTest(component=component):
                status, downloaded, unpacked = self.download(component, {selector: "unapproved-version"})
                self.assertNotEqual(status, 0)
                self.assertFalse(downloaded)
                self.assertFalse(unpacked)


if __name__ == "__main__":
    unittest.main()

import importlib.util
import io
import subprocess
import errno
import json
import os
import socket
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("onboard", ROOT / "examples/slurm-user-site/onboard.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BootstrapTests(unittest.TestCase):
    def test_prepare_capabilities_copies_verified_runtime_without_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local, shared, release = (root / part for part in ("local", "shared", "release"))
            for path in (local, shared, release):
                path.mkdir(mode=0o700)
            runtime = release / "runtime.sif"
            runtime.write_bytes(b"signed-runtime-fixture")
            runtime.chmod(0o400)
            manifest = {"files": [{"role": "runtime-sif", "name": runtime.name, "sha256": module.sha(runtime)}]}
            with patch.object(module, "verify_release", return_value=manifest), patch.object(module, "role", return_value=runtime), patch.object(module, "reserve_capacity"), patch.object(module, "registration", side_effect=AssertionError("must not register")), patch.object(module, "activate", side_effect=AssertionError("must not activate")), patch.object(module, "install_helpers"), patch("sys.stdout", new=io.StringIO()):
                module.prepare_capabilities(local, shared, release)
                target = shared / "releases/release/runtime.sif"
                self.assertEqual(target.read_bytes(), runtime.read_bytes())
                self.assertIn(str(target), (local / "capability.env").read_text())
                self.assertIn(module.sha(runtime), (local / "capability.env").read_text())
                self.assertFalse((local / "registration").exists())
                self.assertFalse((local / "current").exists())
                # A repeat reuses the verified shared artifact without requiring space for another copy.
                with patch.object(module, "reserve_capacity", side_effect=AssertionError("must reuse")):
                    module.prepare_capabilities(local, shared, release)

    def test_prepare_capabilities_leaves_no_partial_publication_on_copy_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local, shared, release = (root / part for part in ("local", "shared", "release"))
            for path in (local, shared, release):
                path.mkdir(mode=0o700)
            runtime = release / "runtime.sif"
            runtime.write_bytes(b"verified")
            def corrupt(source, destination):
                Path(destination).write_bytes(b"corrupt")
            with patch.object(module, "verify_release", return_value={"files": [{"role": "runtime-sif", "sha256": module.sha(runtime)}]}), patch.object(module, "role", return_value=runtime), patch.object(module, "reserve_capacity"), patch.object(module.shutil, "copyfile", side_effect=corrupt):
                with self.assertRaisesRegex(ValueError, "digest mismatch"):
                    module.prepare_capabilities(local, shared, release)
            self.assertFalse((local / "capability.env").exists())
            self.assertEqual(list((shared / "releases/release").iterdir()), [])

    def spack_release(self, directory):
        release = Path(directory) / "release"
        shared = Path(directory) / "shared"
        release.mkdir()
        shared.mkdir()
        (release / "runtime.sif").write_bytes(b"verified runtime fixture")
        (release / "spack").write_text("#!/bin/sh\nexit 0\n")
        (release / "spack").chmod(0o500)
        site = {"version": 1, "storeRoot": str(shared / "software"), "target": "linux-test-x86_64", "runtimeSifSha256": module.sha(release / "runtime.sif"), "osReleaseSha256": "a" * 64, "hostFiles": [{"path": "/usr/bin/make", "sha256": "b" * 64}], "externals": [], "sharedStoreConfirmed": True, "compatibleComputeNodesConfirmed": True, "trustedRecipesConfirmed": True, "quotaEnforcedBySite": True}
        profile = release / "site.json"
        profile.write_text(json.dumps(site))
        (release / "manifest.json").write_text(json.dumps({"files": [{"role": role, "name": name, "sha256": module.sha(release / name)} for role, name in (("runtime-sif", "runtime.sif"), ("site-profile", "site.json"), ("spack", "spack"))]}))
        return release, shared, profile, site

    def test_spack_release_binds_runtime_and_private_shared_store_before_registration(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(module.platform, "machine", return_value="x86_64"), patch.object(module, "managed_capability_preflight"):
            release, shared, profile, site = self.spack_release(directory)
            self.assertEqual(module.preflight_spack_release(release, shared), site)
            for changes in ({"runtimeSifSha256": "0" * 64}, {"storeRoot": str(shared)}, {"storeRoot": str(shared / "jobs" / "store")}, {"storeRoot": str(shared / ".." / "outside")}, {"target": "linux-test-aarch64"}, {"quotaEnforcedBySite": False}, {"hostFiles": []}):
                with self.subTest(changes=changes):
                    profile.write_text(json.dumps({**site, **changes}))
                    with self.assertRaises(ValueError):
                        module.preflight_spack_release(release, shared)
            # Microarchitectures remain subject to the Agent's native target check.
            profile.write_text(json.dumps({**site, "target": "linux-test-haswell"}))
            module.preflight_spack_release(release, shared)
            profile.write_text(json.dumps({**site, "runtimeSifSha256": "0" * 64}))
            local = Path(directory) / "local"
            local.mkdir()
            with patch.dict(os.environ, {"KQ_ENABLE_SPACK": "1"}), patch.object(module, "run", side_effect=AssertionError("must not register")):
                with self.assertRaises(ValueError):
                    module.registration(local, shared, release)
            self.assertFalse((local / "registration").exists())
            self.assertFalse((shared / "helpers").exists())

    def test_spack_staging_checks_signed_binding_without_consuming_live_capability_gate(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(module.platform, "machine", return_value="x86_64"), patch.object(module, "managed_capability_preflight", side_effect=ValueError("stale inventory")):
            release, shared, profile, site = self.spack_release(directory)
            self.assertEqual(module.preflight_spack_release(release, shared, require_capabilities=False), site)
            with self.assertRaisesRegex(ValueError, "stale inventory"):
                module.preflight_spack_release(release, shared)
            profile.write_text(json.dumps({**site, "runtimeSifSha256": "0" * 64}))
            with self.assertRaisesRegex(ValueError, "bind"):
                module.preflight_spack_release(release, shared, require_capabilities=False)

    def test_spack_memory_and_timeout_map_to_generated_agent_config(self):
        for budget, expected, timeout, expected_timeout in ((None, "4096", None, "21600000"), ("1024", "1024", "60000", "60000"), ("2048", "2048", "1800000", "1800000"), ("4096", "4096", "86400000", "86400000"), ("32768", "32768", None, "21600000"), ("1048576", "1048576", None, "21600000")):
            with self.subTest(budget=budget), tempfile.TemporaryDirectory() as directory:
                release, shared, _, _ = self.spack_release(directory)
                manifest = json.loads((release / "manifest.json").read_text())
                manifest["files"].append({"role": "agent", "name": "agent"})
                (release / "manifest.json").write_text(json.dumps(manifest))
                local = Path(directory) / "local"
                (local / "registration").mkdir(parents=True, mode=0o700)
                (local / "registration/agent.env").write_text("existing identity")
                env = {"KQ_ENABLE_SPACK": "1", "SERVER_HTTP_URL": "https://example.test", "SERVER_GRPC_URL": "https://example.test", "PATH": os.environ["PATH"]}
                if budget is not None:
                    env["KQ_SPACK_MANAGED_MEMORY_MIB"] = budget
                if timeout is not None:
                    env["KQ_SPACK_INSTALL_TIMEOUT_MS"] = timeout
                with patch.dict(os.environ, env, clear=True), patch.object(module, "preflight_spack_release"), patch.object(module, "install_helpers"), patch.object(module, "registration_config", return_value={}), patch.object(module.shutil, "which", return_value="/usr/bin/true"):
                    module.registration(local, shared, release)
                self.assertIn("export AGENT_SPACK_MANAGED_MEMORY_MIB=" + expected + "\n", (release / "agent.env").read_text())
                self.assertIn("export AGENT_SPACK_INSTALL_TIMEOUT_MS=" + expected_timeout + "\n", (release / "agent.env").read_text())

    def test_invalid_spack_memory_rejected_before_side_effects(self):
        for budget in ("", "1023", "1048577", "2048.0", "-2048", " 2048", "garbage"):
            with self.subTest(budget=budget), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with patch.dict(os.environ, {"KQ_ENABLE_SPACK": "1", "KQ_SPACK_MANAGED_MEMORY_MIB": budget}), patch.object(module, "run", side_effect=AssertionError("no commands")), patch.object(module, "verify_release", side_effect=AssertionError("no activation")):
                    for operation in (lambda: module.registration(root, root, root), lambda: module.stage(root), lambda: module.activate(root, root), module.main):
                        with self.assertRaisesRegex(ValueError, "KQ_SPACK_MANAGED_MEMORY_MIB"):
                            operation()
                self.assertEqual(list(root.iterdir()), [])
        with patch.dict(os.environ, {"KQ_ENABLE_SPACK": "0", "KQ_SPACK_MANAGED_MEMORY_MIB": "invalid"}):
            self.assertIsNone(module.spack_managed_memory_mib())

    def test_managed_capability_gate_requires_fresh_bound_passed_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            digest = "a" * 64
            capabilities = {"observedAt": 100000, "partition": "cn", "runtimeSifSha256": digest, "memoryMib": 32768,
                            "abi": {"status": "passed"}, "userManager": {"status": "passed"},
                            "isolation": {"status": "passed"}, "scratch": {"status": "passed", "availableMib": 30000}}
            env = {"KQ_ENABLE_SPACK": "1", "KQ_SPACK_MANAGED_MEMORY_MIB": "32768", "KQ_SLURM_MEMORY_LIMIT_MIB": "33280", "KQ_COMPUTE_INVENTORY_FILE": str(path)}
            inventory = {"kind": "kq-compute-inventory", "ok": True, "managedCapabilities": capabilities}
            with patch.dict(os.environ, env, clear=True), patch.object(module.time, "time", return_value=100001), patch.object(module, "login_persistence_checks", return_value={"stateRetention": "passed", "longRunningProcess": "passed"}):
                path.write_text(json.dumps(inventory))
                module.managed_capability_preflight(digest)
                compatible = {**inventory, "arch": "x86_64", "libc": {"name": "glibc", "version": "2.34"}, "cpu": {"supportedFlags": ["sse4_2"]}}
                path.write_text(json.dumps(compatible))
                compatibility = {"architecture": "x86_64", "minGlibc": "2.28", "cpuFlags": ["sse4_2"]}
                module.managed_capability_preflight(digest, compatibility)
                for request in ({**compatibility, "architecture": "aarch64"}, {**compatibility, "minGlibc": "2.35"}, {**compatibility, "cpuFlags": ["avx2"]}):
                    with self.assertRaises(ValueError):
                        module.managed_capability_preflight(digest, request)
                for changes in ({"observedAt": 0}, {"observedAt": 100002}, {"memoryMib": 4096}, {"partition": "other"}, {"runtimeSifSha256": "b" * 64}, {"isolation": {"status": "not-tested"}}, {"userManager": {"status": "failed"}}, {"scratch": {"status": "passed", "availableMib": 1}}):
                    with self.subTest(changes=changes):
                        path.write_text(json.dumps({**inventory, "managedCapabilities": {**capabilities, **changes}}))
                        with self.assertRaisesRegex(ValueError, "fresh passed compute inventory"):
                            module.managed_capability_preflight(digest)
                path.write_text(json.dumps(inventory))
                for limit in ("", "32768", "1049089", "9007199254740992", "NaN"):
                    with self.subTest(limit=limit), patch.dict(os.environ, {"KQ_SLURM_MEMORY_LIMIT_MIB": limit}):
                        with self.assertRaises(ValueError):
                            module.managed_capability_preflight(digest)
                with patch.object(module, "login_persistence_checks", return_value={"stateRetention": "not-tested", "longRunningProcess": "passed"}):
                    with self.assertRaisesRegex(ValueError, "retention"):
                        module.managed_capability_preflight(digest)

    def test_invalid_spack_timeout_rejected_before_side_effects(self):
        for timeout in ("", "59999", "86400001", "1800000.0", "-1800000", " 1800000", "garbage"):
            with self.subTest(timeout=timeout), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with patch.dict(os.environ, {"KQ_ENABLE_SPACK": "1", "KQ_SPACK_INSTALL_TIMEOUT_MS": timeout}), patch.object(module, "run", side_effect=AssertionError("no commands")), patch.object(module, "verify_release", side_effect=AssertionError("no activation")):
                    for operation in (lambda: module.registration(root, root, root), lambda: module.stage(root), lambda: module.activate(root, root), module.main):
                        with self.assertRaisesRegex(ValueError, "KQ_SPACK_INSTALL_TIMEOUT_MS"):
                            operation()
                self.assertEqual(list(root.iterdir()), [])
        with patch.dict(os.environ, {"KQ_ENABLE_SPACK": "0", "KQ_SPACK_INSTALL_TIMEOUT_MS": "invalid"}):
            self.assertIsNone(module.spack_install_timeout_ms())

    def test_worker_controller_terminal_proof_without_accounting(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Path(directory) / "materials/audits/run-1/slurm.json"
            journal.parent.mkdir(parents=True)
            original = json.dumps({"phase": "recovery-required", "jobId": "42", "name": "worker"})
            journal.write_text(original)
            output = "JobId=42 JobName=worker JobState=CANCELLED Requeue=0"
            def query(args, **kwargs):
                self.assertEqual(kwargs["timeout"], 5)
                if args[0] == "sacct":
                    raise subprocess.CalledProcessError(1, args, stderr="accounting disabled")
                return subprocess.CompletedProcess(args, 0, "" if args[0] == "squeue" else output)
            with patch.dict(os.environ, {"KQ_SHARED": directory}), patch.object(module, "run", side_effect=query):
                module.check_workers()
                for output in ("JobId=43 JobName=worker JobState=CANCELLED Requeue=0", "JobId=42 JobName=other JobState=CANCELLED Requeue=0", "JobId=42 JobName=worker JobState=RUNNING Requeue=0", "JobId=42 JobName=worker JobState=CANCELLED", "JobId=42 JobId=42 JobName=worker JobState=CANCELLED Requeue=0", ""):
                    with self.subTest(output=output), self.assertRaises(ValueError):
                        module.check_workers()
            self.assertEqual(journal.read_text(), original)

    def environment(self, mode="ssh-forward"):
        return patch.dict(os.environ, {"KQ_TRANSPORT_MODE": mode, "KQ_GATEWAY_FORWARD": "18443:127.0.0.1:18443", "KQ_PROXY_FORWARD": "18080:127.0.0.1:3128", "SERVER_HTTP_URL": "https://platform.invalid/platform", "SERVER_GRPC_URL": "https://agent.invalid", "KQ_ALLOWED_ORIGINS": "", "KQ_TLS_CA_FILE": ""}, clear=False)

    def test_forward_preserves_original_url_and_disables_ambient_proxy(self):
        with self.environment():
            module.configure_transport()
            args = module.curl_options("https://platform.invalid/bucket/a?signature=a%2Fb")
            self.assertIn("platform.invalid:443:127.0.0.1:18443", args)
            self.assertIn("--noproxy", args)
            self.assertNotIn("-L", args)
            with self.assertRaises(ValueError):
                module.curl_options("https://public.invalid/a")

    def test_proxy_mode_and_ssh_binds_only_loopback(self):
        with self.environment("http-proxy"):
            module.configure_transport()
            self.assertIn("http://127.0.0.1:18080", module.curl_options("https://platform.invalid/a"))
            self.assertIn("127.0.0.1:18080:127.0.0.1:3128", module.ssh_args())
            self.assertIn("StrictHostKeyChecking=yes", module.ssh_args())

    def test_activation_refuses_state_format_changes_without_switching_current(self):
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory)
            old, new = local / "old", local / "new"
            old.mkdir()
            new.mkdir()
            (old / "manifest.json").write_text(json.dumps({"stateFormat": "a", "files": []}))
            (new / "manifest.json").write_text(json.dumps({"stateFormat": "b", "files": []}))
            (local / "current").symlink_to(old)
            with patch.dict(os.environ, {"KQ_MAINTENANCE_WINDOW": "1"}):
                with self.assertRaisesRegex(ValueError, "State format"):
                    module.activate(local, new)
            self.assertEqual((local / "current").resolve(), old)

    def test_completed_partial_is_verified_before_network_and_bad_digest_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "agent"
            target.with_suffix(".part").write_bytes(b"agent")
            with patch.object(module, "run", side_effect=AssertionError("must not use network")):
                module.fetch("https://platform.invalid/agent", target, 5, module.sha(target.with_suffix(".part")))
            self.assertEqual(target.read_bytes(), b"agent")

    def test_activation_refuses_unfinished_build_and_allows_confirmed_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory)
            old, new = local / "old", local / "new"
            for release in (old, new):
                release.mkdir()
                (release / "manifest.json").write_text(json.dumps({"stateFormat": "a", "files": []}))
            (local / "state").mkdir()
            (local / "current").symlink_to(old)
            journal = local / "materials/installs/run-1/slurm.json"
            journal.parent.mkdir(parents=True)
            journal.write_text(json.dumps({"phase": "running", "jobId": "42", "name": "worker"}))
            from subprocess import CompletedProcess
            with patch.dict(os.environ, {"KQ_MAINTENANCE_WINDOW": "1", "KQ_SHARED": str(local)}):
                with patch.object(module, "run", return_value=CompletedProcess([], 0, "42|RUNNING\n")):
                    with self.assertRaisesRegex(ValueError, "still active"):
                        module.activate(local, new)
                self.assertEqual((local / "current").resolve(), old)
                with patch.object(module, "run", side_effect=module.subprocess.TimeoutExpired("squeue", 5)):
                    with self.assertRaises(ValueError):
                        module.activate(local, new)
                self.assertEqual((local / "current").resolve(), old)
                with patch.object(module, "run", side_effect=lambda args, **kwargs: CompletedProcess(args, 0, "" if args[0] == "squeue" else "JobId=42 JobName=worker JobState=COMPLETED Requeue=0" if args[0] == "scontrol" else "42|COMPLETED\n")):
                    module.activate(local, new)
                self.assertEqual((local / "current").resolve(), new)

    def test_worker_check_requests_full_length_accounting_states(self):
        from subprocess import CompletedProcess
        with tempfile.TemporaryDirectory() as directory:
            shared = Path(directory)
            journal = shared / "materials/installs/run-long-state/slurm.json"
            journal.parent.mkdir(parents=True)
            journal.write_text(json.dumps({"phase": "running", "jobId": "42", "name": "worker", "noRequeue": True}))
            def accounting(args, **kwargs):
                self.assertEqual(kwargs["timeout"], 5)
                if args[0] == "squeue":
                    return CompletedProcess(args, 0, "")
                if args[0] == "scontrol":
                    raise subprocess.CalledProcessError(1, args)
                self.assertIn("--format=JobIDRaw,State%64", args)
                return CompletedProcess(args, 0, "42|OUT_OF_MEMORY\n")
            with patch.dict(os.environ, {"KQ_SHARED": str(shared)}), patch.object(module, "run", side_effect=accounting):
                module.check_workers()

    def test_worker_terminal_proof_requires_empty_queue_and_safe_requeue(self):
        from subprocess import CompletedProcess, TimeoutExpired
        with tempfile.TemporaryDirectory() as directory:
            shared = Path(directory)
            journal = shared / "materials/installs/run-1/slurm.json"
            journal.parent.mkdir(parents=True)
            def query(args, **kwargs):
                self.assertEqual(kwargs["timeout"], 5)
                return CompletedProcess(args, 0, outputs[args[0]])
            with patch.dict(os.environ, {"KQ_SHARED": str(shared)}):
                journal.write_text(json.dumps({"phase": "PREEMPTED", "jobId": "42", "name": "worker"}))
                outputs = {"squeue": "42|worker\n", "sacct": "42|PREEMPTED\n", "scontrol": "JobId=42 JobName=worker JobState=PREEMPTED Requeue=1"}
                with patch.object(module, "run", side_effect=query):
                    with self.assertRaises(ValueError):
                        module.check_workers()
                    outputs["squeue"] = ""
                    with self.assertRaises(ValueError):
                        module.check_workers()
                    outputs["scontrol"] = "JobId=42 JobName=worker JobState=PREEMPTED Requeue=0"
                    module.check_workers()
                for failed_command in ("squeue", "scontrol"):
                    def timeout_query(args, **kwargs):
                        if args[0] == failed_command:
                            raise TimeoutExpired(args, 5)
                        return query(args, **kwargs)
                    with patch.object(module, "run", side_effect=timeout_query):
                        with self.assertRaises(ValueError):
                            module.check_workers()
                journal.write_text(json.dumps({"phase": "PREEMPTED", "jobId": "42", "name": "worker", "noRequeue": True}))
                with patch.object(module, "run", side_effect=query) as command:
                    module.check_workers()
                    self.assertEqual(command.call_count, 2)
                outputs["scontrol"] = ""
                with patch.object(module, "run", side_effect=query) as command:
                    module.check_workers()
                    self.assertEqual([call.args[0][0] for call in command.call_args_list], ["squeue", "scontrol"])
                with patch.object(module, "run", side_effect=TimeoutExpired("squeue", 5)):
                    with self.assertRaises(ValueError):
                        module.check_workers()

    def test_readonly_directory_inspection_does_not_create_path(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "new" / "state"
            inspected, ancestor = module.inspect_directory(target)
            self.assertEqual(inspected, target)
            self.assertEqual(ancestor, Path(directory))
            self.assertFalse(target.exists())

    def test_corrupt_update_leaves_active_release_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory)
            old, new = local / "old", local / "new"
            old.mkdir()
            new.mkdir()
            (old / "manifest.json").write_text(json.dumps({"stateFormat": "a", "files": []}))
            (new / "agent").write_text("corrupt")
            (new / "manifest.json").write_text(json.dumps({"stateFormat": "a", "files": [{"name": "agent", "sha256": "0" * 64}]}))
            (local / "current").symlink_to(old)
            with self.assertRaisesRegex(ValueError, "Staged artifact changed"):
                module.activate(local, new)
            self.assertEqual((local / "current").resolve(), old)

    def test_live_agent_lock_blocks_activation_and_rollback(self):
        import fcntl
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory)
            (local / "state").mkdir()
            old, new = local / "old", local / "new"
            for release in (old, new):
                release.mkdir()
                (release / "manifest.json").write_text(json.dumps({"stateFormat": "a", "files": []}))
            (local / "current").symlink_to(old)
            with (local / "state/agent.lock").open("a") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch.dict(os.environ, {"KQ_MAINTENANCE_WINDOW": "1"}):
                    for rollback in (False, True):
                        with self.assertRaises(BlockingIOError):
                            module.activate(local, new, rollback=rollback)
            self.assertEqual((local / "current").resolve(), old)

    def test_rollback_requires_maintenance_and_preserves_current_on_config_error(self):
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory)
            (local / "state").mkdir()
            old, new = local / "old", local / "new"
            for release in (old, new):
                release.mkdir()
                (release / "manifest.json").write_text(json.dumps({"stateFormat": "a", "files": []}))
            (local / "current").symlink_to(new)
            with patch.dict(os.environ, {"KQ_MAINTENANCE_WINDOW": "0"}):
                with self.assertRaisesRegex(ValueError, "maintenance|MAINTENANCE"):
                    module.activate(local, old, rollback=True)
            def fail():
                raise ValueError("configuration rejected")
            with patch.dict(os.environ, {"KQ_MAINTENANCE_WINDOW": "1"}), patch.object(module, "check_workers"):
                with self.assertRaisesRegex(ValueError, "configuration rejected"):
                    module.activate(local, old, rollback=True, configure=fail)
                self.assertEqual((local / "current").resolve(), new)
                module.activate(local, old, rollback=True)
                self.assertEqual((local / "current").resolve(), old)
                self.assertEqual(json.loads((local / "status.json").read_text())["phase"], "rolled-back")

    def test_installed_modules_helper_matches_source_without_extra_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            shared = Path(directory)
            module.install_helpers(shared)
            helper = shared / "helpers/modules-smoke.sh"
            self.assertEqual(helper.read_text(), (ROOT / "examples/slurm-user-site/modules-smoke.sh").read_text())
            self.assertEqual(helper.stat().st_mode & 0o777, 0o500)

    def test_failure_status_uses_fixed_reason_and_preserves_active_release(self):
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory)
            old = local / ("a" * 64)
            old.mkdir()
            (local / "current").symlink_to(old)
            (local / "bootstrap.lock").touch()
            module.record_failure(local, ValueError("https://secret.invalid/?token=secret"))
            report = json.loads((local / "status.json").read_text())
            self.assertEqual(report["phase"], "failed")
            self.assertEqual(report["reason"], "validation_failed")
            self.assertEqual(report["release"], old.name)
            self.assertEqual(report["activeRelease"], old.name)
            self.assertNotIn("secret", json.dumps(report))
            self.assertEqual((local / "current").resolve(), old)

    def test_dangling_current_pointer_is_not_treated_as_first_install(self):
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory)
            new = local / "new"
            new.mkdir()
            (new / "manifest.json").write_text(json.dumps({"stateFormat": "a", "files": []}))
            (local / "current").symlink_to(local / "missing")
            with self.assertRaisesRegex(ValueError, "pointer is broken"):
                module.activate(local, new)
            self.assertEqual(os.readlink(local / "current"), str(local / "missing"))

    def test_interrupted_shared_copy_retries_without_publishing_partial_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            source, destination = Path(directory) / "source.sif", Path(directory) / "runtime.sif"
            source.write_bytes(b"verified runtime" * 1024)
            source.chmod(0o400)
            def interrupt(_source, temporary):
                Path(temporary).write_bytes(b"partial")
                raise OSError("copy interrupted")
            with patch.object(module.shutil, "copyfile", side_effect=interrupt):
                with self.assertRaisesRegex(OSError, "copy interrupted"):
                    module.atomic_copy(source, destination)
            self.assertFalse(destination.exists())
            module.atomic_copy(source, destination)
            self.assertEqual(module.sha(source), module.sha(destination))
            self.assertEqual(destination.stat().st_mode & 0o777, 0o400)
            with patch.object(module.shutil, "copyfile", side_effect=AssertionError("complete artifact must be reused")):
                module.atomic_copy(source, destination)
            destination.chmod(0o600)
            destination.write_bytes(b"partial from an older bootstrap")
            module.atomic_copy(source, destination)
            self.assertEqual(module.sha(source), module.sha(destination))

    def test_tunnel_owned_fake_ssh_is_stopped_on_success_and_body_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ssh = root / "ssh"
            ssh.write_text(f"#!{sys.executable}\n" + """import json, os, signal, socket, sys
from pathlib import Path
root = Path(os.environ['KQ_TEST_SSH_LOG'])
(root / 'args.json').write_text(json.dumps(sys.argv[1:]))
(root / 'pid').write_text(str(os.getpid()))
def stop(_signal, _frame):
    (root / 'stopped').write_text('terminated')
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
local = sys.argv[sys.argv.index('-L') + 1].split(':')
with socket.socket() as listener:
    listener.bind((local[0], int(local[1])))
    listener.listen()
    while True:
        connection, _ = listener.accept()
        connection.close()
""")
            ssh.chmod(0o700)
            for fails in (False, True):
                with self.subTest(body_fails=fails):
                    (root / "stopped").unlink(missing_ok=True)
                    with socket.socket() as candidate:
                        candidate.bind(("127.0.0.1", 0))
                        port = candidate.getsockname()[1]
                    with self.environment(), patch.dict(os.environ, {"PATH": str(root) + os.pathsep + os.environ["PATH"], "KQ_GATEWAY_FORWARD": f"{port}:127.0.0.1:443", "KQ_SSH_HOST": "fake-service", "KQ_TEST_SSH_LOG": str(root), "KQ_REUSE_TUNNEL": "0"}):
                        def operation():
                            with module.tunnel():
                                self.assertFalse((root / "stopped").exists())
                                if fails:
                                    raise RuntimeError("operation interrupted")
                        if fails:
                            with self.assertRaisesRegex(RuntimeError, "operation interrupted"):
                                operation()
                        else:
                            operation()
                    self.assertEqual((root / "stopped").read_text(), "terminated")
                    args = json.loads((root / "args.json").read_text())
                    self.assertIn(f"127.0.0.1:{port}:127.0.0.1:443", args)
                    self.assertIn("StrictHostKeyChecking=yes", args)
                    self.assertEqual(args[-1], "fake-service")
                    with self.assertRaises(ProcessLookupError):
                        os.kill(int((root / "pid").read_text()), 0)

    def test_tunnel_reports_fake_ssh_startup_failure_without_yielding(self):
        with tempfile.TemporaryDirectory() as directory:
            ssh = Path(directory) / "ssh"
            ssh.write_text("#!/bin/sh\nexit 9\n")
            ssh.chmod(0o700)
            with socket.socket() as candidate:
                candidate.bind(("127.0.0.1", 0))
                port = candidate.getsockname()[1]
            with self.environment(), patch.dict(os.environ, {"PATH": directory + os.pathsep + os.environ["PATH"], "KQ_GATEWAY_FORWARD": f"{port}:127.0.0.1:443", "KQ_REUSE_TUNNEL": "0"}):
                with self.assertRaisesRegex(ValueError, "exited before becoming ready"):
                    with module.tunnel():
                        self.fail("failed SSH process must not be treated as a ready tunnel")

    def test_tunnel_reuse_requires_opt_in_and_never_stops_the_existing_listener(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            with self.environment(), patch.dict(os.environ, {"KQ_GATEWAY_FORWARD": f"{port}:127.0.0.1:443", "KQ_REUSE_TUNNEL": "0"}), patch.object(module.subprocess, "Popen", side_effect=AssertionError("must not spawn SSH")):
                with self.assertRaisesRegex(ValueError, "already occupied"):
                    with module.tunnel():
                        self.fail("unverified listener must not be reused")
                with patch.dict(os.environ, {"KQ_REUSE_TUNNEL": "1"}):
                    with module.tunnel():
                        pass
                self.assertEqual(listener.getsockname()[1], port)
                self.assertGreaterEqual(listener.fileno(), 0)

    def test_atomic_disk_full_keeps_old_file_and_cleans_the_uncommitted_temporary(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "record.json"
            target.write_text("old")
            with patch.object(module.os, "fsync", side_effect=OSError(errno.ENOSPC, "disk full")):
                with self.assertRaises(OSError):
                    module.atomic(target, "new")
            self.assertEqual(target.read_text(), "old")
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_activation_metadata_failure_restores_current_previous_and_status(self):
        for failing_name in ("current", "previous", "status.json"):
            with self.subTest(failing_name=failing_name), tempfile.TemporaryDirectory() as directory:
                local = Path(directory)
                old, new = local / "old", local / "new"
                old.mkdir()
                new.mkdir()
                (local / "current").symlink_to(old)
                (local / "previous").write_text("older\n")
                (local / "status.json").write_text('{"phase":"activated","release":"old"}\n')
                previous = (local / "previous").read_bytes()
                status = (local / "status.json").read_bytes()
                replace = module.os.replace
                def fail_commit(source, destination):
                    if Path(source).name == failing_name and Path(source).parent.name == "after":
                        raise OSError(errno.ENOSPC, "disk full during rename")
                    return replace(source, destination)
                with patch.object(module.os, "replace", side_effect=fail_commit):
                    with self.assertRaises(OSError):
                        module.switch_release(local, new, rollback=False)
                self.assertEqual((local / "current").resolve(), old)
                self.assertEqual((local / "previous").read_bytes(), previous)
                self.assertEqual((local / "status.json").read_bytes(), status)
                self.assertEqual(list(local.glob(".activate-*")), [])

    def test_activation_disk_full_before_switch_keeps_current_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory)
            old, new = local / "old", local / "new"
            old.mkdir()
            new.mkdir()
            (local / "current").symlink_to(old)
            with patch.object(module.os, "fsync", side_effect=OSError(errno.ENOSPC, "disk full")):
                with self.assertRaises(OSError):
                    module.switch_release(local, new, rollback=False)
            self.assertEqual((local / "current").resolve(), old)
            self.assertFalse((local / "status.json").exists())
            self.assertEqual(list(local.glob(".activate-*")), [])

    def test_same_release_configuration_is_restored_when_activation_commit_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory)
            release = local / "release"
            release.mkdir()
            env, launcher = release / "agent.env", local / "run-agent.sh"
            env.write_text("old configuration")
            launcher.write_text("old launcher")
            launcher.chmod(0o700)
            (local / "current").symlink_to(release)
            replace = module.os.replace
            def configure():
                module.atomic(env, "new configuration")
                module.atomic(launcher, "new launcher", 0o700)
            def fail_status(source, destination):
                if Path(source).name == "status.json" and Path(source).parent.name == "after":
                    raise OSError(errno.ENOSPC, "disk full")
                return replace(source, destination)
            with patch.object(module.os, "replace", side_effect=fail_status):
                with self.assertRaises(OSError):
                    module.switch_release(local, release, False, configure=configure)
            self.assertEqual(env.read_text(), "old configuration")
            self.assertEqual(launcher.read_text(), "old launcher")
            self.assertEqual(launcher.stat().st_mode & 0o777, 0o700)
            self.assertEqual((local / "current").resolve(), release)

    def test_services_refuses_uninstalled_release_before_writing_units(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(module.shutil, "which", return_value="/fixture/systemctl"), patch.object(module, "run", side_effect=AssertionError("must not call systemctl")):
            with self.assertRaisesRegex(ValueError, "Install and activate"):
                module.services(Path(directory))

    def test_services_bind_all_units_to_install_host_in_shared_home(self):
        import shutil
        analyzer = shutil.which("systemd-analyze")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local, home = root / "local", root / "shared-home"
            release = local / "releases" / "release"
            release.mkdir(parents=True)
            (local / "current").symlink_to(release)
            for hostname in (socket.gethostname(), "another-kq-login-host"):
                with self.subTest(hostname=hostname), patch.object(module.socket, "gethostname", return_value=hostname), patch.object(module.Path, "home", return_value=home), patch.object(module, "verify_release"), patch.object(module, "rollback_configuration"), patch.object(module, "ssh_args", return_value=["ssh", "fixture"]), patch.object(module.shutil, "which", return_value="/fixture/systemctl"), patch.object(module, "run"), patch.dict(os.environ, {"KQ_BOOTSTRAP_SCRIPT": "/fixture/bootstrap.sh", "KQ_SITE_ENV": "/fixture/site.env"}):
                    module.services(local)
                for name in ("kq-agent.service", "kq-tunnel.service", "kq-update.service", "kq-update.timer"):
                    content = (home / ".config/systemd/user" / name).read_text()
                    conditions = [line for line in content.splitlines() if line.startswith("ConditionHost=")]
                    self.assertEqual(conditions, ["ConditionHost=" + hostname])
                    self.assertIn("ConditionHost=" + hostname, content.split("[Service]")[0].split("[Timer]")[0])
                    if analyzer:
                        result = subprocess.run([analyzer, "condition", conditions[0]], capture_output=True, text=True, timeout=5)
                        self.assertEqual(result.returncode == 0, hostname == socket.gethostname(), result.stderr)

    def test_services_reject_unsafe_or_ambiguous_hostname_before_writes(self):
        for hostname in ("", "login*", "!login", "login\nConditionHost=*", "%H", "a" * 32):
            with self.subTest(hostname=hostname), tempfile.TemporaryDirectory() as directory, patch.object(module.socket, "gethostname", return_value=hostname), patch.object(module, "run", side_effect=AssertionError("must not run")):
                with self.assertRaisesRegex(ValueError, "ConditionHost"):
                    module.services(Path(directory))
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_state_storage_rejects_home_shared_temporary_network_and_readonly_paths(self):
        from subprocess import CompletedProcess
        with patch.object(module.Path, "home", return_value=Path("/site/home/user")):
            for path in ("/site/home/user/state", "/site/shared/state", "/tmp/state", "/var/tmp/state", "/run/state", "/dev/shm/state"):
                with self.subTest(path=path), patch.object(module, "run", side_effect=AssertionError("path must be rejected before probing mount")):
                    with self.assertRaisesRegex(ValueError, "outside HOME"):
                        module.validate_state_storage(Path(path), Path(path).parent, Path("/site/shared"))
            for evidence in ("nfs4 rw", "tmpfs rw", "ext4 ro", "ext4", "overlay rw"):
                with self.subTest(mount=evidence), patch.object(module, "run", return_value=CompletedProcess([], 0, evidence)):
                    with self.assertRaisesRegex(ValueError, "writable local filesystem"):
                        module.validate_state_storage(Path("/site/local/state"), Path("/site/local"), Path("/site/shared"))
            with patch.object(module, "run", return_value=CompletedProcess([], 0, "ext4 rw,relatime")) as probe:
                # Same /site tree as HOME is allowed; only HOME's own subtree is rejected.
                module.validate_state_storage(Path("/site/local/state"), Path("/site/local"), Path("/site/shared"))
                self.assertEqual(probe.call_args.kwargs["timeout"], 5)
                self.assertIn("FSTYPE,OPTIONS", probe.call_args.args[0])

    def test_readonly_partition_check_rejects_missing_down_and_timeout(self):
        from subprocess import CompletedProcess
        with patch.dict(os.environ, {"KQ_PARTITION": "cn"}):
            for rows in ("", "other|up\n", "cn|down\n", "cn|inact\n"):
                with self.subTest(rows=rows), patch.object(module, "run", return_value=CompletedProcess([], 0, rows)):
                    with self.assertRaisesRegex(ValueError, "missing or not UP"):
                        module.readonly_site_checks()
            with patch.object(module, "run", side_effect=subprocess.TimeoutExpired("sinfo", 5)):
                with self.assertRaisesRegex(ValueError, "timed out"):
                    module.readonly_site_checks()

    def test_readonly_checks_report_optional_modules_and_missing_residency_honestly(self):
        from subprocess import CompletedProcess
        with patch.dict(os.environ, {"KQ_PARTITION": "cn", "KQ_ENABLE_SPACK": "0", "KQ_PYTHON_MODULE_STATUS": "not-tested", "KQ_APPTAINER_MODULE_STATUS": "failed"}), patch.object(module, "run", return_value=CompletedProcess([], 0, "cn*|up\n")) as commands, patch.object(module.subprocess, "run", side_effect=[CompletedProcess([], 1, "degraded"), CompletedProcess([], 0, "no")]), patch.object(module, "slurm_recovery_conditions", return_value={"status": "not-tested"}), patch("sys.stdout", new_callable=io.StringIO) as output:
            module.readonly_site_checks()
            report = output.getvalue()
            self.assertIn("slurm-partition: passed", report)
            self.assertIn("python-module: not-tested", report)
            self.assertIn("apptainer-module: failed", report)
            self.assertIn("user-systemd: passed", report)
            self.assertIn("linger: failed", report)
            self.assertIn("retention policy still requires site confirmation", report)
            self.assertEqual(commands.call_args.args[0], ["sinfo", "--noheader", "--partition", "cn", "--format=%P|%a"])
            self.assertEqual(commands.call_args.kwargs["timeout"], 5)

    def test_slurm_recovery_reports_controller_window_when_accounting_is_absent(self):
        from subprocess import CompletedProcess
        with patch.dict(os.environ, {"KQ_RECOVERY_WINDOW_SEC": "86400"}), patch.object(module.subprocess, "run", return_value=CompletedProcess([], 0, "AccountingStorageType = accounting_storage/none\nMinJobAge = 300\n")) as command:
            report = module.slurm_recovery_conditions()
            self.assertEqual(report["status"], "degraded")
            self.assertEqual(report["controllerWindowSec"], 300)
            self.assertEqual(report["accounting"], "failed")
            self.assertEqual(command.call_args.kwargs["timeout"], 5)
        with patch.object(module.subprocess, "run", side_effect=subprocess.TimeoutExpired("scontrol", 5)):
            self.assertEqual(module.slurm_recovery_conditions()["status"], "not-tested")

    def test_embedded_script_is_exact_source(self):
        embedded = (ROOT / "examples/slurm-user-site/bootstrap.sh").read_text().split("KQ_BOOTSTRAP_PY'\n", 1)[1].rsplit("\nKQ_BOOTSTRAP_PY\n", 1)[0]
        self.assertEqual(embedded, (ROOT / "examples/slurm-user-site/onboard.py").read_text())


if __name__ == "__main__":
    unittest.main()

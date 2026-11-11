"""Offline delivery boundaries; no daemon, containers or deployment credentials."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("offline", ROOT / "deploy/federation/offline.py")
offline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(offline)
REVISION = "a" * 40
CASDOOR_IMAGE = "casbin/casdoor@sha256:" + "d" * 64


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bundle = self.root / "bundle"
        self.bundle.mkdir()
        self.manifest = {"version": 1, "revision": REVISION, "platform": "linux/amd64", "files": {}, "images": [],
                         "casdoor": {"source": CASDOOR_IMAGE, "id": "sha256:" + "b" * 64}}
        for name in ("images.tar.gz", *offline.PUBLIC_FILES):
            path = self.bundle / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"test-only")
            self.manifest["files"][name] = {"sha256": offline.digest(path), "bytes": path.stat().st_size}
        for name in [*(offline.image_name(c, REVISION) for c in (*offline.COMPONENTS, "scheduler-slurm", "scheduler-pbs", "casdoor")), *offline.THIRD_PARTY]:
            self.manifest["images"].append({"name": name, "id": "sha256:" + "b" * 64, "size": 1024})

    def tearDown(self):
        self.temp.cleanup()

    def write_manifest(self):
        path = self.bundle / "manifest.json"
        path.write_text(json.dumps(self.manifest))
        return offline.digest(path)

    def test_complete_delivery(self):
        self.assertEqual(offline.verify_bundle(self.bundle, self.write_manifest())["revision"], REVISION)

    def test_manifest_requires_an_immutable_casdoor_source_bound_to_its_alias(self):
        for source in (None, {"source": "casbin/casdoor:latest", "id": "sha256:" + "b" * 64},
                       {"source": CASDOOR_IMAGE, "id": "sha256:" + "c" * 64}):
            with self.subTest(source=source):
                self.manifest["casdoor"] = source
                with self.assertRaisesRegex(ValueError, "Casdoor"):
                    offline.verify_bundle(self.bundle, self.write_manifest())
        del self.manifest["casdoor"]
        with self.assertRaisesRegex(ValueError, "Casdoor"):
            offline.verify_bundle(self.bundle, self.write_manifest())

    def test_replaced_casdoor_alias_is_rejected_before_export(self):
        output = self.root / "export"
        def image(name):
            return {"name": name, "revision": REVISION, "size": 1,
                    "id": "sha256:" + ("c" if name == offline.image_name("casdoor", REVISION) else "b") * 64}
        with patch.object(offline, "source_revision"), patch.object(offline, "inspect_image", side_effect=image), \
             patch.object(offline.subprocess, "Popen") as exporter:
            with self.assertRaisesRegex(ValueError, "approved source"):
                offline.export(SimpleNamespace(revision=REVISION, casdoor_image=CASDOOR_IMAGE, output=output))
        exporter.assert_not_called()
        self.assertFalse(output.exists())

    def test_export_binds_approved_casdoor_and_includes_public_setup_materials(self):
        output = self.root / "export"
        exporter = Mock()
        exporter.wait.return_value = 0
        def compress(command, **kwargs):
            self.assertEqual(command, ["gzip", "-1"])
            kwargs["stdout"].write(b"fixture image archive")
        with patch.object(offline, "source_revision"), \
             patch.object(offline, "inspect_image", side_effect=lambda name: {"name": name, "revision": REVISION, "size": 1, "id": "sha256:" + "b" * 64}), \
             patch.object(offline.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * 1024 ** 3)), \
             patch.object(offline.subprocess, "Popen", return_value=exporter), \
             patch.object(offline, "run", side_effect=compress):
            offline.export(SimpleNamespace(revision=REVISION, casdoor_image=CASDOOR_IMAGE, output=output))
        saved = offline.verify_bundle(output, offline.digest(output / "manifest.json"))
        self.assertEqual(saved["casdoor"], {"source": CASDOOR_IMAGE, "id": "sha256:" + "b" * 64})
        for name in ("deploy/federation/aio/README.md", "deploy/federation/aio/env.example",
                     "deploy/main/env.example", "deploy/federation/env.example", "deploy/federation/deployment.md"):
            self.assertIn(name, saved["files"])
            self.assertEqual((output / name).read_bytes(), (ROOT / name).read_bytes())
        self.assertFalse(any(Path(name).name == ".env" for name in saved["files"]))
        (output / "deploy/federation/aio/env.example").write_text("changed template")
        with self.assertRaisesRegex(ValueError, "checksum"):
            offline.verify_bundle(output, offline.digest(output / "manifest.json"))

    def test_requires_independently_trusted_manifest(self):
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "Manifest SHA"):
            offline.verify_bundle(self.bundle, "0" * 64)

    def test_tampered_payload(self):
        trusted = self.write_manifest()
        (self.bundle / "images.tar.gz").write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "checksum"):
            offline.verify_bundle(self.bundle, trusted)

    def test_missing_image(self):
        self.manifest["images"].pop()
        with self.assertRaisesRegex(ValueError, "image closure"):
            offline.verify_bundle(self.bundle, self.write_manifest())

    def test_duplicate_image(self):
        self.manifest["images"].append(self.manifest["images"][0])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            offline.verify_bundle(self.bundle, self.write_manifest())

    def test_rejects_payload_links(self):
        path = self.bundle / "images.tar.gz"
        path.unlink()
        (self.root / "outside").write_bytes(b"test-only")
        path.symlink_to(self.root / "outside")
        with self.assertRaises(ValueError):
            offline.verify_bundle(self.bundle, self.write_manifest())

    def test_rejects_manifest_links(self):
        self.write_manifest()
        path = self.bundle / "manifest.json"
        path.rename(self.root / "manifest")
        path.symlink_to(self.root / "manifest")
        with self.assertRaisesRegex(ValueError, "links"):
            offline.verify_bundle(self.bundle, offline.digest(path))

    def test_rejects_arbitrary_extra_payload(self):
        self.manifest["files"]["../../outside"] = {"sha256": "0" * 64, "bytes": 0}
        with self.assertRaisesRegex(ValueError, "payload"):
            offline.verify_bundle(self.bundle, self.write_manifest())

    def test_loaded_identity_must_match(self):
        with patch.object(offline, "inspect_image", return_value={"id": "sha256:" + "c" * 64}):
            with self.assertRaisesRegex(ValueError, "trusted manifest"):
                offline.validate_images(self.manifest)

    def test_target_observation_is_isolated_and_bound_to_delivered_image(self):
        output = self.root / "slurm-target.json"
        facts = {"version": 1, "scheduler": "slurm", "softwareInstallationAccepted": False}
        image = next(r for r in self.manifest["images"] if "/scheduler-slurm:" in r["name"])
        with patch.object(offline, "inspect_image", return_value=image), \
             patch.object(offline, "run", return_value=SimpleNamespace(stdout=json.dumps(facts))) as engine:
            offline.target_facts(self.manifest, "slurm", output)
        command = engine.call_args.args[0]
        self.assertEqual(command[command.index("--pull") + 1], "never")
        self.assertEqual(command[command.index("--network") + 1], "none")
        self.assertEqual(command[command.index("--user") + 1], "65534:65534")
        self.assertIn("--read-only", command)
        self.assertIn("no-new-privileges", command)
        self.assertNotIn("--privileged", command)
        self.assertNotIn("--volume", command)
        self.assertEqual(command[-3:], [image["name"], "/usr/local/bin/kq-target-facts.py", "slurm"])
        self.assertEqual(engine.call_args.kwargs["timeout"], 120)
        saved = json.loads(output.read_text())
        self.assertEqual(saved["image"], {"name": image["name"], "id": image["id"]})
        self.assertEqual(saved["revision"], REVISION)
        self.assertIs(saved["facts"]["softwareInstallationAccepted"], False)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_wrong_image_or_existing_target_observation_never_runs_container(self):
        output = self.root / "target.json"
        with patch.object(offline, "inspect_image", return_value={"id": "sha256:" + "c" * 64}), \
             patch.object(offline, "run") as engine:
            with self.assertRaisesRegex(ValueError, "trusted manifest"):
                offline.target_facts(self.manifest, "pbs", output)
            self.assertFalse(output.exists())
            engine.assert_not_called()
            output.write_text("original evidence")
            with self.assertRaisesRegex(ValueError, "already exist"):
                offline.target_facts(self.manifest, "pbs", output)
            self.assertEqual(output.read_text(), "original evidence")

    def test_runtime_extraction_is_image_bound_and_never_claims_installation(self):
        output = self.root / "spack.sif"
        image = next(r for r in self.manifest["images"] if "/scheduler-slurm:" in r["name"])
        def extract(command, **kwargs):
            self.assertEqual(command[command.index("--network") + 1], "none")
            self.assertEqual(command[command.index("--pull") + 1], "never")
            self.assertNotIn("--privileged", command)
            self.assertNotIn("--volume", command)
            kwargs["stdout"].write(b"fixture runtime bytes")
        with patch.object(offline, "inspect_image", return_value=image), \
             patch.object(offline.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * 1024 ** 3)), \
             patch.object(offline, "run", side_effect=extract) as engine:
            offline.export_runtime(self.manifest, "slurm", output)
            metadata = json.loads(Path(str(output) + ".json").read_text())
            self.assertEqual(metadata["sha256"], offline.digest(output))
            self.assertEqual(metadata["image"]["id"], image["id"])
            self.assertIs(metadata["signed"], False)
            self.assertIs(metadata["softwareInstallationAccepted"], False)
            self.assertEqual(output.stat().st_mode & 0o777, 0o444)
            with self.assertRaisesRegex(ValueError, "new output"):
                offline.export_runtime(self.manifest, "slurm", output)
            engine.assert_called_once()

    def test_failed_runtime_export_keeps_checkpoint_without_completion_record(self):
        output = self.root / "spack.sif"
        with patch.object(offline, "inspect_image", return_value={"id": "sha256:" + "b" * 64}), \
             patch.object(offline.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * 1024 ** 3)), \
             patch.object(offline, "run", side_effect=offline.subprocess.CalledProcessError(1, "fixture")) as engine:
            with self.assertRaises(offline.subprocess.CalledProcessError):
                offline.export_runtime(self.manifest, "pbs", output)
            self.assertFalse(output.exists())
            self.assertFalse(Path(str(output) + ".json").exists())
            self.assertTrue(Path(str(output) + ".creating").exists())
            with self.assertRaises(FileExistsError):
                offline.export_runtime(self.manifest, "pbs", output)
            engine.assert_called_once()

    def test_failed_or_mismatched_observation_leaves_no_success_file(self):
        output = self.root / "target.json"
        for result in ({"version": 1, "scheduler": "slurm", "softwareInstallationAccepted": False},
                       {"version": 1, "scheduler": "pbs", "softwareInstallationAccepted": True}):
            with self.subTest(result=result), \
                 patch.object(offline, "inspect_image", return_value={"id": "sha256:" + "b" * 64}), \
                 patch.object(offline, "run", return_value=SimpleNamespace(stdout=json.dumps(result))):
                with self.assertRaisesRegex(ValueError, "Invalid target observation"):
                    offline.target_facts(self.manifest, "pbs", output)
                self.assertFalse(output.exists())
        with patch.object(offline, "inspect_image", return_value={"id": "sha256:" + "b" * 64}), \
             patch.object(offline, "run", side_effect=offline.subprocess.TimeoutExpired(["fixture"], 120)):
            with self.assertRaises(offline.subprocess.TimeoutExpired):
                offline.target_facts(self.manifest, "pbs", output)
            self.assertFalse(output.exists())

    def test_target_collection_keeps_actual_os_compiler_and_host_target(self):
        spec = importlib.util.spec_from_file_location("target_facts", ROOT / "deploy/federation/aio/target-facts.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        observations = {"-p": "linux", "-o": "ubuntu20.04", "-t": "haswell"}
        with patch.object(module.Path, "read_text", return_value='ID=ubuntu\nVERSION_ID="20.04"\n'), \
             patch.object(module, "sha256", return_value="c" * 64), \
             patch.object(module, "executable", side_effect=lambda name, _: {"path": "/tools/" + name, "version": "actual"}), \
             patch.object(module, "command", side_effect=lambda argv: observations.get(argv[-1], "glibc 2.31")):
            result = module.collect("pbs")
        self.assertEqual(result["os"]["VERSION_ID"], "20.04")
        self.assertEqual(result["os"]["libc"], "glibc 2.31")
        self.assertEqual(result["spackArchitecture"]["hostTarget"], "haswell")
        self.assertEqual(result["executables"]["gcc"]["version"], "actual")
        self.assertIn("qstat", result["executables"])
        self.assertIs(result["softwareInstallationAccepted"], False)
        with patch.object(module.Path, "read_text") as read:
            with self.assertRaisesRegex(ValueError, "slurm or pbs"):
                module.collect("other")
            read.assert_not_called()
        with patch.object(module.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ValueError, "executable missing"):
                module.executable("gcc", [])

    def test_packaged_agent_requires_the_original_revision_and_binary(self):
        spec = importlib.util.spec_from_file_location("verify_agent", ROOT / "deploy/federation/aio/verify-agent.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        binary = self.root / "agent"
        binary.write_bytes(b"fixture compiled agent")
        manifest = self.root / "agent-manifest.json"
        entry = {"target": "bun-linux-x64", "name": "kq-agent-bun-linux-x64",
                 "size": binary.stat().st_size, "sha256": offline.digest(binary)}
        original = {"version": 1, "revision": REVISION, "files": [entry]}
        manifest.write_text(json.dumps(original))
        module.verify(binary, manifest, REVISION)
        for value in (
            {**original, "revision": "b" * 40},
            {**original, "files": [entry, entry]},
            {**original, "files": [{**entry, "size": True}]},
            {**original, "files": [{**entry, "sha256": "0" * 64}]},
        ):
            with self.subTest(manifest=value):
                manifest.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    module.verify(binary, manifest, REVISION)
        manifest.write_text(json.dumps(original))
        binary.write_bytes(b"unexpected binary")
        with self.assertRaises(ValueError):
            module.verify(binary, manifest, REVISION)
        with self.assertRaisesRegex(ValueError, "fixed Agent"):
            module.verify(binary, manifest, "unknown")

    def test_exporter_is_reaped_after_compression_failure_without_publishing_manifest(self):
        output = self.root / "export"
        exporter = Mock()
        exporter.poll.return_value = None
        image = {"revision": REVISION, "size": 1, "id": "sha256:" + "b" * 64}
        with patch.object(offline, "source_revision"), \
             patch.object(offline, "inspect_image", side_effect=lambda name: {**image, "name": name}), \
             patch.object(offline.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * 1024 ** 3)), \
             patch.object(offline.subprocess, "Popen", return_value=exporter), \
             patch.object(offline, "run", side_effect=offline.subprocess.CalledProcessError(1, "gzip")):
            with self.assertRaises(offline.subprocess.CalledProcessError):
                offline.export(SimpleNamespace(revision=REVISION, casdoor_image=CASDOOR_IMAGE, output=output))
        exporter.stdout.close.assert_called_once()
        exporter.kill.assert_called_once()
        exporter.wait.assert_called_once()
        self.assertFalse((output / "manifest.json").exists())

    def test_changed_source_or_image_cannot_publish_a_ready_delivery(self):
        for changed in ("source", "image"):
            with self.subTest(changed=changed):
                output = self.root / changed
                exporter = Mock()
                exporter.wait.return_value = 0
                records = [{"name": name, "revision": REVISION, "size": 1, "id": "sha256:" + "b" * 64}
                           for name in [*(offline.image_name(c, REVISION) for c in (*offline.COMPONENTS, "scheduler-slurm", "scheduler-pbs", "casdoor")), *offline.THIRD_PARTY]]
                inspected = [{**records[0], "name": CASDOOR_IMAGE}] + records + [{**records[0], "id": "sha256:" + "c" * 64}]
                revisions = [None, ValueError("source changed")] if changed == "source" else [None, None]
                with patch.object(offline, "source_revision", side_effect=revisions), \
                     patch.object(offline, "inspect_image", side_effect=inspected), \
                     patch.object(offline.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * 1024 ** 3)), \
                     patch.object(offline.subprocess, "Popen", return_value=exporter), \
                     patch.object(offline, "run", return_value=SimpleNamespace(returncode=0)):
                    with self.assertRaises(ValueError):
                        offline.export(SimpleNamespace(revision=REVISION, casdoor_image=CASDOOR_IMAGE, output=output))
                self.assertFalse((output / "manifest.json").exists())

    def test_pbs_recreation_preserves_database_and_requires_recoverable_history(self):
        # Run the real entrypoint against command fixtures; no daemon or host path is touched.
        binaries = self.root / "bin"
        binaries.mkdir()
        spool = self.root / "pbs"
        log = self.root / "commands"
        for name, body in {
            "qstat": "exit 0",
            "chown": "exit 0",
            "qmgr": 'echo "$*" >>"$FIXTURE_LOG"; if [[ "$*" == *job_history_enable* && "${FAIL_HISTORY:-0}" == 1 ]]; then exit 9; fi',
            "init-pbs": 'echo "pbs $*" >>"$FIXTURE_LOG"',
            "register": 'echo register >>"$FIXTURE_LOG"',
            "start-agent": "exit 0",
            "verify": "exit 0",
            "postinstall": f'mkdir -p "{spool}/server_priv"; echo original >"{spool}/server_priv/db_password"; echo postinstall >>"$FIXTURE_LOG"',
        }.items():
            path = binaries / name
            path.write_text("#!/bin/bash\nset -euo pipefail\n" + body + "\n")
            path.chmod(0o700)
        capacity_script = self.root / "capacity.py"
        capacity_script.write_text('print("1 128")\n')
        source = (ROOT / "deploy/schedulers/pbs/entrypoint.sh").read_text()
        replacements = {
            "/usr/local/bin/kq-verify-architecture": binaries / "verify",
            "/opt/pbs/libexec/pbs_postinstall": binaries / "postinstall",
            "/etc/init.d/pbs": binaries / "init-pbs",
            "/usr/local/bin/kq-register-compose-agent": binaries / "register",
            "/usr/local/bin/kq-start-agent": binaries / "start-agent",
            "/usr/local/bin/kq-scheduler-capacity.py": capacity_script,
            "/var/spool/pbs": spool,
            "/var/lib/kuintessence": self.root / "agent",
            "/var/cache/bun": self.root / "cache",
            "/etc/pbs.conf": self.root / "pbs.conf",
            "/etc/hosts": self.root / "hosts",
            "/scratch": self.root / "scratch",
        }
        for before, after in replacements.items():
            source = source.replace(before, str(after))
        entrypoint = self.root / "entrypoint.sh"
        entrypoint.write_text(source)
        (self.root / "hosts").write_text("")
        env = {**os.environ, "PATH": str(binaries) + os.pathsep + os.defpath,
               "FIXTURE_LOG": str(log), "AGENT_SANDBOX_ROOT_IMPERSONATION": "true",
               "AGENT_SANDBOX_EXECUTION_MODE": "disabled", "FAIL_HISTORY": "0"}
        def boot():
            return offline.subprocess.run(["bash", str(entrypoint)], env=env,
                                          capture_output=True, text=True, timeout=10)
        self.assertEqual(boot().returncode, 0)
        database = spool / "server_priv/db_password"
        database.write_text("retained private database marker")
        (self.root / "pbs.conf").unlink()
        self.assertEqual(boot().returncode, 0)
        self.assertEqual(database.read_text(), "retained private database marker")
        self.assertEqual(log.read_text().splitlines().count("postinstall"), 1)
        self.assertEqual(log.read_text().splitlines().count("register"), 2)
        self.assertIn("set server job_history_duration = 24:00:00", log.read_text())
        env["FAIL_HISTORY"] = "1"
        self.assertEqual(boot().returncode, 9)
        self.assertEqual(log.read_text().splitlines().count("register"), 2)
        self.assertEqual(database.read_text(), "retained private database marker")

    def test_rejects_invalid_uncompressed_size(self):
        for value in (None, True, 0, -1, "1024"):
            with self.subTest(size=value):
                self.manifest["images"][0]["size"] = value
                with self.assertRaisesRegex(ValueError, "image size"):
                    offline.verify_bundle(self.bundle, self.write_manifest())

    def test_managed_slurm_requires_accounting_before_registration_and_reaps_daemons(self):
        binaries = self.root / "bin"
        binaries.mkdir()
        log = self.root / "commands"
        processes = self.root / "pids"
        daemon = 'echo "$$" >>"$FIXTURE_PIDS"; trap "exit 0" TERM; while :; do sleep 0.05; done'
        for name, body in {
            "chown": ":", "verify": ":", "munged": ":", "sinfo": "echo idle",
            "slurmdbd": daemon, "slurmctld": daemon, "slurmd": daemon,
            "runuser": 'while [[ "$1" != -- ]]; do shift; done; shift; exec "$@"',
            "register": 'echo register >>"$FIXTURE_LOG"',
            "start-agent": 'sleep 0.1; exit 7',
        }.items():
            path = binaries / name
            path.write_text("#!/bin/bash\nset -euo pipefail\n" + body + "\n")
            path.chmod(0o700)
        capacity = self.root / "capacity.py"
        capacity.write_text('print("1 128")\n')
        manager = self.root / "manager.py"
        manager.write_text('import os,sys\nfrom pathlib import Path\n'
                           'with Path(os.environ["FIXTURE_LOG"]).open("a") as f: f.write(sys.argv[1]+"\\n")\n'
                           'if sys.argv[1]=="slurm-accounting-register" and os.environ.get("FAIL_ACCOUNTING")=="1": sys.exit(9)\n')
        source = (ROOT / "deploy/schedulers/slurm/entrypoint.sh").read_text()
        for before, after in {
            "/usr/local/bin/kq-verify-architecture": binaries / "verify",
            "/usr/local/bin/kq-register-compose-agent": binaries / "register",
            "/usr/local/bin/kq-start-agent": binaries / "start-agent",
            "/usr/local/bin/kq-scheduler-capacity.py": capacity,
            "/usr/local/lib/kuintessence/managed.py": manager,
            "/run/munge": self.root / "run-munge", "/var/log/munge": self.root / "munge-log",
            "/var/lib/kuintessence": self.root / "agent", "/etc/munge": self.root / "munge",
            "/etc/slurm-llnl": self.root / "slurm", "/var/spool/slurmctld": self.root / "controller",
            "/var/spool/slurmd": self.root / "worker", "/var/log/slurm": self.root / "slurm-log",
            "/var/cache/bun": self.root / "cache", "/scratch": self.root / "scratch",
        }.items():
            source = source.replace(before, str(after))
        (self.root / "slurm").mkdir()
        (self.root / "slurm/slurm.conf.template").write_text("NodeName=__HOSTNAME__ CPUs=__CPUS__\n")
        (self.root / "munge").mkdir()
        (self.root / "munge/munge.key").write_text("retained test identity")
        script = self.root / "slurm.sh"
        script.write_text(source)
        env = {**os.environ, "PATH": str(binaries) + os.pathsep + os.defpath,
               "KQ_AIO_MANAGED_RUNTIME": "1", "FIXTURE_LOG": str(log), "FIXTURE_PIDS": str(processes)}
        for fail, expected in (("1", 9), ("0", 7)):
            env["FAIL_ACCOUNTING"] = fail
            child = offline.subprocess.Popen(["bash", str(script)], env=env, stdout=offline.subprocess.PIPE,
                                             stderr=offline.subprocess.PIPE, start_new_session=True)
            try:
                _, error = child.communicate(timeout=10)
                self.assertEqual(child.returncode, expected, error.decode())
            finally:
                try:
                    os.killpg(child.pid, 15)
                except ProcessLookupError:
                    pass
                child.wait(timeout=5)
            lines = log.read_text().splitlines()
            self.assertEqual(lines.count("register"), 0 if fail == "1" else 1)
            if fail == "0":
                self.assertLess(lines.index("slurm-accounting-register"), lines.index("register"))
        for pid in processes.read_text().splitlines():
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pid), 0)

    def test_full_target_disk_never_reaches_load(self):
        with patch.object(offline, "run", return_value=SimpleNamespace(stdout=str(self.root))) as engine, \
             patch.object(offline.shutil, "disk_usage", return_value=SimpleNamespace(free=1024)):
            with self.assertRaisesRegex(ValueError, "no images were loaded"):
                offline.load_images(self.bundle, self.manifest)
            engine.assert_called_once_with(["docker", "info", "--format", "{{.DockerRootDir}}"],
                                           capture_output=True, text=True)

    def test_accounting_secrets_are_private_files_not_compose_plaintext_or_links(self):
        password = self.root / "password"
        password.write_text("a" * 64 + "\n")
        password.chmod(0o600)
        config = {"services": {"scheduler-accounting": {"volumes": [
            {"type": "bind", "source": str(password), "target": target, "read_only": True}
            for target in ("/run/secrets/slurm-db-password", "/run/secrets/root-password")
        ]}}}
        original = Path.lstat
        def owned(path):
            info = original(path)
            return SimpleNamespace(st_mode=0o40755 if path in self.root.parents else info.st_mode,
                                   st_uid=0, st_size=info.st_size)
        with patch.object(offline.Path, "lstat", owned):
            offline.validate_accounting_credentials(config)
            password.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "private root"):
                offline.validate_accounting_credentials(config)
            password.chmod(0o600)
            password.write_text("not a random hex password")
            with self.assertRaisesRegex(ValueError, "hex-encoded"):
                offline.validate_accounting_credentials(config)
            link = self.root / "alias"
            link.symlink_to(password)
            config["services"]["scheduler-accounting"]["volumes"][0]["source"] = str(link)
            with self.assertRaisesRegex(ValueError, "canonical"):
                offline.validate_accounting_credentials(config)
        config["services"]["scheduler-accounting"]["volumes"] = []
        with self.assertRaisesRegex(ValueError, "both private"):
            offline.validate_accounting_credentials(config)

    def test_config_is_private_and_cannot_overwrite(self):
        path = self.root / "private.json"
        offline.private_write(path, {"secret": "test-only"})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        offline.require_private_file(path)
        with self.assertRaises(FileExistsError):
            offline.private_write(path, {})
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private"):
            offline.require_private_file(path)

    def test_rendered_compose_preserves_literal_dollars(self):
        self.assertEqual(offline.escape_interpolation({"key": ["cost$123${NOT_AN_ENV}"]}),
                         {"key": ["cost$$123$${NOT_AN_ENV}"]})

    def test_nerdctl_build_cannot_use_kubernetes_namespace(self):
        argv = ["offline.py", "--image-engine", "nerdctl", "--namespace", "k8s.io",
                "build", "--revision", REVISION, "--casdoor-image", "example@sha256:" + "0" * 64]
        with patch("sys.argv", argv), patch.object(offline, "build") as build:
            with self.assertRaisesRegex(ValueError, "never k8s.io"):
                offline.main()
            build.assert_not_called()

    def test_corrupt_bundle_never_reaches_engine_load(self):
        self.write_manifest()
        argv = ["offline.py", "load", "--bundle", str(self.bundle), "--manifest-sha256", "0" * 64]
        with patch("sys.argv", argv), patch.object(offline, "run") as engine:
            with self.assertRaisesRegex(ValueError, "Manifest SHA"):
                offline.main()
            engine.assert_not_called()

    def test_capacity_is_budget_not_measured_acceptance(self):
        result = offline.capacity({"services": {"server": {"mem_limit": 10 ** 15},
                                                  "migration": {"restart": "no", "mem_limit": 10 ** 15}}})
        self.assertFalse(result["fitsReservedBudget"])
        self.assertFalse(result["measuredCapacityAcceptance"])
        self.assertEqual(result["serviceLimitsMiB"], 10 ** 15 // 1024 ** 2)

    def test_other_institution_limits_cannot_be_oversold(self):
        containers = [
            {"HostConfig": {"Memory": 1024}, "Config": {"Labels": {"com.docker.compose.project": "kq-fed-site-a"}}},
            {"HostConfig": {"Memory": 2048}, "Config": {"Labels": {"com.docker.compose.project": "kq-fed-r"}}},
        ]
        with patch.object(offline, "run", side_effect=[SimpleNamespace(stdout="one\ntwo\n"), SimpleNamespace(stdout=json.dumps(containers))]):
            self.assertEqual(offline.other_container_limits("kq-fed-r"), 1024)
        baseline = offline.capacity({"services": {}})
        with_other = offline.capacity({"services": {}}, 512 * 1024 ** 2)
        self.assertEqual(with_other["requiredMiB"], baseline["requiredMiB"] + 512)

    def test_running_limits_are_not_allocated_twice_against_available_memory(self):
        memory = "MemTotal: 8388608 kB\nMemAvailable: 1048576 kB\n"
        with patch.object(offline.Path, "read_text", return_value=memory):
            result = offline.capacity({"services": {"admin": {"mem_limit": 128 * 1024 ** 2}}},
                                      other_limits=5 * 1024 ** 3)
        self.assertTrue(result["fitsReservedBudget"])
        self.assertTrue(result["fitsAvailableBudget"])
        self.assertEqual(result["availableRequiredMiB"], 640)

    def test_admin_cannot_expand_mode_or_arbitrator_scope(self):
        saved = {"mode": "direct", "role": "institution"}
        with self.assertRaisesRegex(ValueError, "direct mode"):
            offline.admin_service(saved, "approve", "evidence", REVISION)
        saved.update(mode="fabric", role="arbitrator")
        for operation, kind in (("approve", "commercial"), ("orderer-join", None)):
            with self.assertRaisesRegex(ValueError, "Arbitrator"):
                offline.admin_service(saved, operation, kind, REVISION)
        saved["role"] = "orderer"
        with self.assertRaisesRegex(ValueError, "only orderer-join"):
            offline.admin_service(saved, "peer-join", None, REVISION)
        with self.assertRaisesRegex(ValueError, "chaincode kind"):
            offline.admin_service(saved, "approve", None, REVISION)

    def test_offline_orderer_admin_is_one_shot_and_preserves_deployment(self):
        trusted = self.write_manifest()
        saved = {"deliveryManifest": trusted, "mode": "fabric", "role": "orderer", "compose": {
            "name": "kq-fed-test", "services": {"fabric-orderer": {
                "image": "hyperledger/fabric-orderer:3.1.5", "pull_policy": "never",
                "volumes": [{"type": "bind", "source": "/private/fabric/orderer", "target": "/run/kq-orderer"}],
            }}}}
        config_path = self.root / "config.json"
        offline.private_write(config_path, saved)
        state_path = self.root / "kq-fed-test.deployment.json"
        state = {"mode": "fabric", "role": "orderer", "manifest": trusted, "phase": "complete"}
        offline.private_write(state_path, state)
        argv = ["offline.py", "admin", "--bundle", str(self.bundle), "--manifest-sha256", trusted,
                "--config", str(config_path), "--operation", "orderer-join"]
        rendered = []
        def command(args, **kwargs):
            rendered.append(json.loads(Path(args[args.index("-f") + 1]).read_text()))
            return SimpleNamespace(returncode=0)
        with patch("sys.argv", argv), patch.object(offline, "other_container_limits", return_value=0), \
             patch.object(offline, "capacity", return_value={"fitsReservedBudget": True, "fitsAvailableBudget": True}), \
             patch.object(offline, "validate_images"), patch.object(offline, "run", side_effect=command) as engine:
            offline.main()
        last = engine.call_args.args[0]
        self.assertEqual(last[-8:], ["run", "--rm", "--no-deps", "--pull", "never", "-T", "fabric-admin", "orderer-join"])
        self.assertNotIn("up", last)
        self.assertEqual(json.loads(state_path.read_text()), state)
        self.assertEqual(json.loads(config_path.read_text()), saved)
        helper = rendered[-1]["services"]["fabric-admin"]
        self.assertEqual(helper["volumes"][0]["source"], "/private/fabric/admin")
        self.assertEqual(helper["pull_policy"], "never")
        self.assertEqual(helper["image"], offline.image_name("fabric-tools", REVISION))

    def test_trust_append_checks_approved_artifacts_and_cannot_replace_the_fixed_operation(self):
        binaries = self.root / "bin"
        binaries.mkdir()
        log = self.root / "peer-args.jsonl"
        peer = binaries / "peer"
        peer.write_text('#!/usr/bin/python3\nimport json,os,sys\n'
                        'from pathlib import Path\n'
                        'with Path(os.environ["FIXTURE_LOG"]).open("a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\n'
                        'if sys.argv[1:4]==["lifecycle","chaincode","calculatepackageid"]: print("approved:test-package")\n')
        peer.chmod(0o700)
        directory = self.root / "admin/commercial"
        directory.mkdir(parents=True)
        (directory / "package.id").write_text("approved:test-package\n")
        (directory / "package.tgz").write_bytes(b"fixture package")
        (directory / "trust-update.args").write_text("-C\ncooperation\n-n\nkq-commercial\n--peerAddresses\npeer-a:7051\n--peerAddresses\npeer-b:7051\n")
        approved = directory / "trust-update.next.json"
        approved.write_text('{"approvedFixture":true}')
        previous = "sha256:" + "a" * 64
        expected = "sha256:" + offline.digest(approved)
        (directory / "trust-update.before.sha256").write_text(previous + "\n")
        (directory / "trust-update.after.sha256").write_text(expected + "\n")
        script = self.root / "trust-update.sh"
        script.write_text((ROOT / "deploy/federation/fabric-init.sh").read_text().replace("/run/kq-admin", str(directory.parent)))
        env = {"PATH": str(binaries) + os.pathsep + os.defpath, "FIXTURE_LOG": str(log)}
        result = offline.subprocess.run(["bash", str(script), "trust-update", "commercial"], env=env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(commands[-1][:3], ["chaincode", "invoke", "--waitForEvent"])
        self.assertEqual(json.loads(commands[-1][4]), {"Args": ["UpdateTrust", previous, expected]})
        self.assertNotIn("--isInit", commands[-1])
        for reserved in ("--ctor", "-c{}", "--isInit", "--waitForEvent=false"):
            (directory / "trust-update.args").write_text(reserved + "\n")
            denied = offline.subprocess.run(["bash", str(script), "trust-update", "commercial"], env=env, capture_output=True, text=True, timeout=5)
            self.assertNotEqual(denied.returncode, 0)
            self.assertIn("fixed operation", denied.stderr)
        (directory / "trust-update.args").write_text("-C\ncooperation\n")
        approved.write_text("tampered")
        denied = offline.subprocess.run(["bash", str(script), "trust-update", "commercial"], env=env, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(denied.returncode, 0)
        self.assertIn("digest mismatch", denied.stderr)
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(sum(call[:2] == ["chaincode", "invoke"] for call in calls), 1)
        for role, kind in (("arbitrator", "commercial"), ("institution", "case"), ("orderer", "commercial")):
            with self.subTest(role=role, kind=kind), self.assertRaisesRegex(ValueError, "institution.*commercial"):
                offline.admin_service({"mode": "fabric", "role": role}, "trust-update", kind, REVISION)
    def test_scheduler_advertises_cgroup_memory_instead_of_host_memory(self):
        spec = importlib.util.spec_from_file_location("scheduler_capacity", ROOT / "deploy/schedulers/common/scheduler-capacity.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        meminfo = self.root / "meminfo"
        meminfo.write_text("MemTotal: 16777216 kB\n")
        (self.root / "memory.max").write_text(str(384 * 1024 ** 2))
        (self.root / "cpu.max").write_text("100000 100000")
        self.assertEqual(module.resources(self.root, meminfo), (1, 128))
        (self.root / "memory.max").write_text(str(128 * 1024 ** 2))
        with self.assertRaisesRegex(ValueError, "320 MiB"):
            module.resources(self.root, meminfo)
        (self.root / "memory.max").write_text("max")
        (self.root / "memory").mkdir()
        (self.root / "memory/memory.limit_in_bytes").write_text(str(1024 * 1024 ** 2))
        self.assertEqual(module.resources(self.root, meminfo), (1, 768))


@unittest.skipUnless(shutil.which("docker"), "Docker Compose CLI required for configuration-only checks")
class ConfigurationTests(unittest.TestCase):
    def test_modes_roles_and_pbs(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            env = {
                "POSTGRES_PASSWORD": "test-only", "DATABASE_URL": "postgres://kq:unused@postgres/kuintessence",
                "JWT_SECRET": "test-only", "AUTHZ_SPICEDB_TOKEN": "test-only", "RUSTFS_ACCESS_KEY": "test-only",
                "RUSTFS_SECRET_KEY": "test-only", "SSO_BOOTSTRAP_CLIENT_ID": "test-only",
                "SSO_BOOTSTRAP_CLIENT_SECRET": "test-only", "SSO_BOOTSTRAP_ISSUER_URL": "https://sso.example.org",
                "SSO_BOOTSTRAP_REDIRECT_URI": "https://example.org/callback", "WEB_BASE_URL": "https://example.org",
                "MTLS_TRUSTED_PROXY_CIDRS": "127.0.0.1/32", "FEDERATION_SITE_ID": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "FEDERATION_SIGNING_KEY_ID": "test-only", "KQ_FABRIC_DIRECTORY": str(directory),
                "KQ_AIO_PRIVATE_DIRECTORY": str(directory), "KQ_AIO_AGENT_ID": "test-agent", "KQ_AIO_CLUSTER_NAME": "test cluster",
                "KQ_DATA_MARKET_COMMITTER_ACCESS_KEY": "test-committer", "KQ_DATA_MARKET_COMMITTER_SECRET_KEY": "test-only",
                "KQ_CASDOOR_POSTGRES_PASSWORD": "test-only", "KQ_STORAGE_PUBLIC_URL": "https://storage.example.org",
                "KQ_AIO_SSO_HOST": "sso.example.org", "KQ_AIO_PUBLIC_HOST": "platform.example.org",
                "KQ_AIO_STORAGE_HOST": "storage.example.org", "KQ_SEED_DIRECTORY": str(directory),
            }
            for key in ("FEDERATION_SIGNING_KEY_FILE", "FEDERATION_CLIENT_CA_FILE", "FEDERATION_CLIENT_CERT_FILE",
                        "FEDERATION_CLIENT_KEY_FILE", "FEDERATION_TLS_CA_FILE", "FEDERATION_TLS_CERT_FILE", "FEDERATION_TLS_KEY_FILE"):
                env[key] = str(directory / key)
            for kind in offline.KINDS:
                env[f"KQ_FABRIC_{kind.upper()}_PACKAGE_ID"] = f"{kind}:test-only"
            env_file = directory / "deployment.env"
            env_file.write_text("\n".join(f"{key}={value}" for key, value in env.items()))
            env_file.chmod(0o600)
            names = [*(offline.image_name(c, REVISION) for c in (*offline.COMPONENTS, "scheduler-slurm", "scheduler-pbs", "casdoor")), *offline.THIRD_PARTY]
            manifest = {"revision": REVISION, "images": [{"name": name} for name in names]}
            args = argparse.Namespace(env_file=env_file, project="kq-fed-test-a", mode="direct", role="institution", scheduler="slurm")
            config = offline.render_config(ROOT, manifest, args)
            self.assertFalse(any(name.startswith("fabric-") for name in config["services"]))
            self.assertNotIn("FEDERATION_COMMERCIAL_SOCKET_PATH", config["services"]["server"]["environment"])
            self.assertFalse(config["services"]["scheduler"].get("privileged", False))
            self.assertNotIn("scheduler-accounting", config["services"])
            self.assertEqual(config["services"]["scheduler"]["environment"]["AGENT_SLURM_TERMINAL_STATUS_BACKEND"], "scontrol")
            scheduler_volumes = {v["target"]: v["source"] for v in config["services"]["scheduler"]["volumes"]}
            self.assertEqual(scheduler_volumes["/var/spool/slurmctld"], "slurm-controller")
            self.assertEqual(scheduler_volumes["/var/spool/slurmd"], "slurm-worker")
            self.assertEqual(scheduler_volumes["/etc/munge"], "slurm-munge")
            for service in config["services"].values():
                self.assertNotIn("build", service)
                self.assertEqual(service["pull_policy"], "never")
            args.managed = True
            config = offline.render_config(ROOT, manifest, args)
            self.assertTrue(config["services"]["scheduler"]["privileged"])
            self.assertEqual(config["services"]["scheduler"]["cgroup"], "private")
            self.assertEqual(config["services"]["scheduler"]["environment"]["KQ_AIO_MANAGED_RUNTIME"], "1")
            self.assertGreaterEqual(int(config["services"]["scheduler"]["mem_limit"]), 2560 * 1024 ** 2)
            self.assertEqual(offline.capacity(config)["requiredMiB"], 5792)
            self.assertEqual(config["services"]["scheduler"]["environment"]["AGENT_SLURM_TERMINAL_STATUS_BACKEND"], "sacct")
            database = config["services"]["scheduler-accounting"]
            self.assertFalse(database.get("ports"))
            self.assertFalse(database.get("privileged"))
            self.assertEqual(database["pull_policy"], "never")
            self.assertEqual(database["environment"]["MARIADB_PASSWORD_FILE"], "/run/secrets/slurm-db-password")
            self.assertNotIn("MARIADB_PASSWORD", database["environment"])
            scheduler_volumes = {v["target"]: v["source"] for v in config["services"]["scheduler"]["volumes"]}
            self.assertEqual(scheduler_volumes["/managed-disk"], "managed-disk")
            self.assertEqual(scheduler_volumes["/opt/kq/runtime"], str(directory / "runtime"))
            self.assertTrue(all(not s.get("privileged") for name, s in config["services"].items() if name != "scheduler"))
            args.mode = "fabric"
            config = offline.render_config(ROOT, manifest, args)
            self.assertEqual(offline.capacity(config)["requiredMiB"], 7584)
            args.scheduler = "pbs"
            config = offline.render_config(ROOT, manifest, args)
            self.assertNotIn("scheduler-accounting", config["services"])
            self.assertTrue(config["services"]["scheduler"]["privileged"])
            scheduler_volumes = {v["target"]: v["source"] for v in config["services"]["scheduler"]["volumes"]}
            self.assertEqual(scheduler_volumes["/var/spool/pbs"], "pbs-state")
            self.assertNotIn("/var/spool/slurmctld", scheduler_volumes)
            self.assertEqual(scheduler_volumes["/managed-disk"], "managed-disk")
            self.assertGreater(offline.capacity(config)["requiredMiB"], 4096)
            self.assertEqual(offline.capacity(config)["requiredMiB"], 7200)
            self.assertIn("fabric-orderer", config["services"])
            self.assertIn("fabric-admin", config["services"])
            self.assertTrue(all(not svc.get("privileged") for name, svc in config["services"].items() if name != "scheduler"))
            args.role = "arbitrator"
            with self.assertRaisesRegex(ValueError, "test scheduler"):
                offline.render_config(ROOT, manifest, args)
            args.managed = False
            config = offline.render_config(ROOT, manifest, args)
            self.assertNotIn("scheduler", config["services"])
            self.assertNotIn("fabric-orderer", config["services"])
            self.assertNotIn("fabric-commercial-adapter", config["services"])
            self.assertNotIn("FEDERATION_COMMERCIAL_SOCKET_PATH", config["services"]["server"]["environment"])
            self.assertIn("fabric-case-adapter", config["services"])
            args.role = "orderer"
            config = offline.render_config(ROOT, manifest, args)
            self.assertEqual(set(config["services"]), {"fabric-orderer"})
            self.assertNotIn("pg-data", config["volumes"])
            config["services"]["fabric-admin"] = offline.admin_service(
                {"mode": "fabric", "role": "orderer", "compose": config}, "orderer-join", None, REVISION)
            rendered_file = directory / "orderer-admin.json"
            rendered_file.write_text(json.dumps(offline.escape_interpolation(config)))
            parsed = json.loads(offline.run(["docker", "compose", "-f", rendered_file,
                                            "config", "--format", "json"], capture_output=True, text=True).stdout)
            self.assertEqual(set(parsed["services"]), {"fabric-orderer", "fabric-admin"})
            self.assertEqual(int(parsed["services"]["fabric-admin"]["mem_limit"]), 128 * 1024 ** 2)
            args.mode = "direct"
            with self.assertRaisesRegex(ValueError, "fabric mode"):
                offline.render_config(ROOT, manifest, args)
            args.mode = "fabric"
            args.project = "kq-tencent-lab"
            with self.assertRaisesRegex(ValueError, "distinct"):
                offline.render_config(ROOT, manifest, args)


if __name__ == "__main__":
    unittest.main()

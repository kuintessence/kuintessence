import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("site_maintenance", ROOT / "examples/slurm-user-site/maintenance.py")
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.local = self.root / "local"
        self.shared = self.root / "shared"
        for path in (self.local, self.shared, self.local / "state", self.local / "releases", self.shared / "releases"):
            path.mkdir(mode=0o700)
        self.database = self.local / "state/agent.db"
        with sqlite3.connect(self.database) as db:
            db.executescript((ROOT / "packages/db/src/sqlite/init.sql").read_text())
        self.database.chmod(0o600)
        self.env = patch.dict(os.environ, {"KQ_SHARED": str(self.shared), "KQ_LOCAL": str(self.local), "KQ_MAINTENANCE_WINDOW": "1"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def write(self, path, value):
        path.write_text(value)
        path.chmod(0o600)

    def release(self, version):
        executable = ("executable-" + version).encode()
        manifest = json.dumps({"stateFormat": version, "files": [{"name": "kq-agent", "size": len(executable),
                               "sha256": hashlib.sha256(executable).hexdigest()}]})
        digest = hashlib.sha256(manifest.encode()).hexdigest()
        directory = self.local / "releases" / digest
        directory.mkdir(mode=0o700)
        self.write(directory / "manifest.json", manifest)
        self.write(directory / "kq-agent", executable.decode())
        self.write(directory / "agent.env", "export AGENT_ID=site\n")
        return directory

    def test_capacity_checks_remaining_bytes_and_inodes(self):
        info = SimpleNamespace(f_bavail=50, f_frsize=1024, f_favail=8, f_files=100)
        with patch.object(maintenance.os, "statvfs", return_value=info):
            self.assertTrue(maintenance.capacity(self.local, 40 * 1024, 8)["passed"])
            for size, inodes in ((51 * 1024, 8), (40 * 1024, 9)):
                with self.assertRaisesRegex(ValueError, "capacity"):
                    maintenance.capacity(self.local, size, inodes)

    def test_agent_lock_prevents_maintenance(self):
        path = self.local / "state/agent.lock"
        self.write(path, "")
        with path.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError, "running"):
                with maintenance.stopped(self.local):
                    self.fail("active Agent lock must not be bypassed")

    def test_retention_preserves_current_previous_staged_and_checkpoint(self):
        releases = [self.release(str(i)) for i in range(5)]
        self.local.joinpath("current").symlink_to(releases[0])
        self.write(self.local / "previous", releases[1].name)
        self.write(self.local / "staged", releases[2].name)
        self.write(self.local / "highest.json", json.dumps({"release": releases[3].name}))
        checkpoint = self.local / "state/upload-checkpoint.json"
        self.write(checkpoint, '{"uploadId":"must-retain"}')
        old = time.time() - 40 * 86400
        for release in releases:
            for path in [*release.iterdir(), release]:
                os.utime(path, (old, old))
        plan = maintenance.collect(self.local, self.shared)
        self.assertEqual([c["path"] for c in plan["candidates"]], [str(releases[4])])
        self.assertTrue(releases[4].exists())
        with patch.object(maintenance, "idle_scheduler"):
            maintenance.collect(self.local, self.shared, apply=True)
        self.assertFalse(releases[4].exists())
        self.assertTrue(checkpoint.exists())
        self.assertTrue(all(p.exists() for p in releases[:4]))

    def test_retention_refuses_active_jobs_and_symlinks(self):
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO active_remote_jobs VALUES ('job','42','{}','[]',0,0)")
        with patch.object(maintenance, "idle_scheduler"), self.assertRaisesRegex(ValueError, "unfinished"):
            maintenance.collect(self.local, self.shared, apply=True)
        link = self.local / "releases" / ("a" * 64)
        link.symlink_to(self.shared)
        with self.assertRaisesRegex(ValueError, "symlinks"):
            maintenance.retention_plan(self.local, self.shared)

    def test_snapshot_restores_old_format_only_without_new_execution_state(self):
        old = self.release("schema-v1")
        new = self.release("schema-v2")
        self.local.joinpath("current").symlink_to(old)
        with patch.object(maintenance, "idle_scheduler"):
            backup = Path(maintenance.snapshot(self.local)["snapshot"])
            with sqlite3.connect(self.database) as db:
                db.execute("CREATE TABLE new_empty_schema_table (id TEXT)")
            self.local.joinpath("current").unlink()
            self.local.joinpath("current").symlink_to(new)
            restored = maintenance.restore(self.local, backup)
        self.assertEqual(restored["stateFormat"], "schema-v1")
        self.assertEqual(self.local.joinpath("current").resolve(), old)
        self.assertFalse((self.local / "restore-intent.json").exists())
        with sqlite3.connect(self.database) as db:
            self.assertFalse(db.execute("SELECT name FROM sqlite_master WHERE name='new_empty_schema_table'").fetchone())
        self.assertTrue(list((self.local / "state").glob("before-restore-*.db")))

    def test_restore_refuses_loss_of_new_terminal_job(self):
        old = self.release("schema-v1")
        self.local.joinpath("current").symlink_to(old)
        with patch.object(maintenance, "idle_scheduler"):
            backup = Path(maintenance.snapshot(self.local)["snapshot"])
            with sqlite3.connect(self.database) as db:
                db.execute("INSERT INTO local_jobs (job_id,status,command,cpus,memory_mb,submitted_at,updated_at) VALUES ('new-job','completed','true',1,1,0,0)")
            before = self.database.read_bytes()
            with self.assertRaisesRegex(ValueError, "lose state"):
                maintenance.restore(self.local, backup)
        self.assertEqual(self.database.read_bytes(), before)

    def test_restore_resumes_same_intent_after_link_switch_failure(self):
        old, new = self.release("schema-v1"), self.release("schema-v2")
        self.local.joinpath("current").symlink_to(old)
        replace = maintenance.os.replace
        def fail_switch(source, destination):
            if Path(source).name == "current.restore":
                raise OSError("injected pointer switch failure")
            return replace(source, destination)
        with patch.object(maintenance, "idle_scheduler"):
            backup = Path(maintenance.snapshot(self.local)["snapshot"])
            with sqlite3.connect(self.database) as db:
                db.execute("CREATE TABLE migrated_empty (id TEXT)")
            self.local.joinpath("current").unlink()
            self.local.joinpath("current").symlink_to(new)
            with patch.object(maintenance.os, "replace", side_effect=fail_switch):
                with self.assertRaises(OSError):
                    maintenance.restore(self.local, backup)
            self.assertTrue((self.local / "restore-intent.json").exists())
            self.assertTrue((self.local / "current.restore").is_symlink())
            maintenance.restore(self.local, backup)
        self.assertFalse((self.local / "restore-intent.json").exists())
        self.assertEqual(self.local.joinpath("current").resolve(), old)

    def test_checkpoint_preserves_committed_wal_before_restore_replacement(self):
        writer = sqlite3.connect(self.database)
        self.addCleanup(writer.close)
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE TABLE wal_evidence (id TEXT)")
        writer.execute("INSERT INTO wal_evidence VALUES ('must-survive')")
        writer.commit()
        self.assertGreater(Path(str(self.database) + "-wal").stat().st_size, 0)
        maintenance.checkpoint_database(self.database)
        self.assertEqual(Path(str(self.database) + "-wal").stat().st_size, 0)
        # Standalone base file must contain the committed evidence without replaying WAL.
        isolated = self.local / "checkpoint-copy.db"
        isolated.write_bytes(self.database.read_bytes())
        with sqlite3.connect(isolated) as database:
            self.assertEqual(database.execute("SELECT id FROM wal_evidence").fetchall(), [("must-survive",)])

    def test_bad_snapshot_and_uncertain_worker_never_restore(self):
        old = self.release("schema-v1")
        self.local.joinpath("current").symlink_to(old)
        with patch.object(maintenance, "idle_scheduler"):
            backup = Path(maintenance.snapshot(self.local)["snapshot"])
            self.write(backup / "agent.db", "broken")
            with self.assertRaisesRegex(ValueError, "integrity"):
                maintenance.restore(self.local, backup)
        journal = self.shared / "materials/audits/run-test"
        journal.mkdir(parents=True, mode=0o700)
        self.write(journal / "slurm.json", '{"phase":"recovery-required","jobId":"42"}')
        with self.assertRaisesRegex(ValueError, "terminal proof"):
            maintenance.idle_workers(self.shared)

    def test_auto_retention_does_not_stop_busy_agent(self):
        with patch.dict(os.environ, {"KQ_AUTOMATIC_GC": "1"}), patch.object(maintenance, "idle_database", side_effect=ValueError("busy")), patch.object(maintenance.subprocess, "run") as command:
            self.assertIn("skipped", maintenance.auto_collect(self.local, self.shared))
        command.assert_not_called()

    def test_auto_retention_requires_atomic_agent_permit(self):
        with patch.dict(os.environ, {"KQ_AUTOMATIC_GC": "1"}), patch.object(maintenance, "idle_database"), patch.object(maintenance, "idle_scheduler"), patch.object(maintenance, "retention_plan", return_value={"candidates": [1]}), patch.object(maintenance.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as command, patch.object(maintenance, "maintenance_request", return_value={"ok": False}):
            self.assertEqual(maintenance.auto_collect(self.local, self.shared)["skipped"], "agent-has-in-flight-work")
        self.assertFalse(any("stop" in call.args[0] for call in command.call_args_list))

    def test_lost_drain_response_attempts_resume_without_stopping(self):
        requests = []
        def control(local, action, lease):
            requests.append((action, lease))
            if action == "drain":
                raise TimeoutError("response lost")
            return {"ok": True, "lease": lease, "reason": "MAINTENANCE_RESUMED"}
        with patch.dict(os.environ, {"KQ_AUTOMATIC_GC": "1"}), patch.object(maintenance, "idle_database"), patch.object(maintenance, "idle_scheduler"), patch.object(maintenance, "retention_plan", return_value={"candidates": [1]}), patch.object(maintenance.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as command, patch.object(maintenance, "maintenance_request", side_effect=control):
            self.assertEqual(maintenance.auto_collect(self.local, self.shared)["skipped"], "maintenance-permit-unavailable")
        self.assertEqual([r[0] for r in requests], ["drain", "resume"])
        self.assertEqual(requests[0][1], requests[1][1])
        self.assertFalse(any("stop" in call.args[0] or "start" in call.args[0] for call in command.call_args_list))

    def test_retention_keeps_receipt_when_deletion_is_interrupted(self):
        release = self.release("expired")
        old = time.time() - 40 * 86400
        for path in [*release.iterdir(), release]:
            os.utime(path, (old, old))
        with patch.object(maintenance, "idle_scheduler"), patch.object(maintenance.shutil, "rmtree", side_effect=OSError("injected I/O failure")):
            with self.assertRaises(OSError):
                maintenance.collect(self.local, self.shared, apply=True)
        first = list((self.local / "retention-receipts").iterdir())
        self.assertEqual(len(first), 1)
        self.assertNotIn("appliedAt", json.loads(first[0].read_text()))
        with patch.object(maintenance, "idle_scheduler"):
            maintenance.collect(self.local, self.shared, apply=True)
        self.assertEqual(len(list((self.local / "retention-receipts").iterdir())), 2)
        self.assertTrue(first[0].exists())

    def test_restore_preserves_nonce_replay_fence_and_registration_identity(self):
        old = self.release("schema-v1")
        self.local.joinpath("current").symlink_to(old)
        registration = self.local / "registration"
        registration.mkdir(mode=0o700)
        self.write(registration / "agent.env", '{"AGENT_ID":"same-agent"}')
        with patch.object(maintenance, "idle_scheduler"):
            backup = Path(maintenance.snapshot(self.local)["snapshot"])
            self.write(registration / "agent.env", '{"AGENT_ID":"another-agent"}')
            with self.assertRaisesRegex(ValueError, "identity"):
                maintenance.restore(self.local, backup)
            self.write(registration / "agent.env", '{"AGENT_ID":"same-agent"}')
            with sqlite3.connect(self.database) as db:
                db.execute("INSERT INTO sandbox_replay_nonces VALUES ('new-nonce','job',9999999999999,1)")
            with self.assertRaisesRegex(ValueError, "lose state"):
                maintenance.restore(self.local, backup)

    def test_shared_record_change_blocks_restore_even_when_local_database_is_unchanged(self):
        old = self.release("schema-v1")
        self.local.joinpath("current").symlink_to(old)
        store = self.shared / "store"
        store.mkdir(mode=0o700)
        profile = self.shared / "site-profile.json"
        self.write(profile, json.dumps({"version": 1, "storeRoot": str(store)}))
        self.write(old / "agent.env", "export AGENT_SPACK_INSTALL_ENABLED=true\nexport AGENT_SPACK_INSTALL_SITE_PROFILE_PATH=" + str(profile) + "\nexport AGENT_SPACK_INSTALL_SITE_PROFILE_SHA256=" + hashlib.sha256(profile.read_bytes()).hexdigest() + "\n")
        with patch.object(maintenance, "idle_scheduler"):
            snapshot = Path(maintenance.snapshot(self.local)["snapshot"])
            before = self.database.read_bytes()
            records = store / "records"
            records.mkdir(mode=0o700)
            record = records / "record.json"
            self.write(record, '{"workerStopped":{"noRequeue":true},"resumedFrom":{"operationId":"new"}}')
            record_bytes = record.read_bytes()
            with self.assertRaisesRegex(ValueError, "Shared Spack recovery state changed"):
                maintenance.restore(self.local, snapshot)
            self.assertEqual(self.database.read_bytes(), before)
            self.assertEqual(record.read_bytes(), record_bytes)
            self.assertFalse((self.local / "restore-intent.json").exists())
            self.assertEqual((self.local / "current").resolve(), old)

    def test_restore_refuses_legacy_snapshot_without_shared_evidence(self):
        old = self.release("schema-v1")
        self.local.joinpath("current").symlink_to(old)
        with patch.object(maintenance, "idle_scheduler"):
            snapshot = Path(maintenance.snapshot(self.local)["snapshot"])
            record = json.loads((snapshot / "snapshot.json").read_text())
            del record["sharedState"]
            self.write(snapshot / "snapshot.json", json.dumps(record))
            before = self.database.read_bytes()
            with self.assertRaisesRegex(ValueError, "legacy snapshot lacks evidence"):
                maintenance.restore(self.local, snapshot)
            self.assertEqual(self.database.read_bytes(), before)

    def test_large_terminal_history_has_bounded_snapshot_evidence(self):
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO local_jobs (job_id,status,command,cpus,memory_mb,submitted_at,updated_at) VALUES ('large-job','completed',?,1,1,0,0)", ("a" * (9 * 1024 * 1024),))
        evidence = maintenance.database_evidence(self.database)
        self.assertLess(len(json.dumps(evidence)), 4096)
        self.assertEqual(evidence["local_jobs"]["rows"], 1)


if __name__ == "__main__":
    unittest.main()

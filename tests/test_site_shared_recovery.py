"""Shared recovery evidence and the real Agent generation protocol; no scheduler mocking."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).resolve().parents[1] / 'examples/slurm-user-site/maintenance.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class SharedRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.local = self.root / 'local'
        self.shared = self.root / 'shared'
        self.store = self.shared / 'store'
        self.release = self.local / 'releases' / ('a' * 64)
        for p in [self.local, self.shared, self.store, self.local / 'releases', self.release]:
            p.mkdir(mode=0o700, exist_ok=True)
        (self.local / 'current').symlink_to(self.release)
        self.profile = self.shared / 'profile.json'
        self.write(self.profile, json.dumps({'version': 1, 'storeRoot': str(self.store)}))
        self.write(self.release / 'agent.env', 'export AGENT_SPACK_INSTALL_ENABLED=true\nexport AGENT_SPACK_INSTALL_SITE_PROFILE_PATH=' + str(self.profile) + '\nexport AGENT_SPACK_INSTALL_SITE_PROFILE_SHA256=' + hashlib.sha256(self.profile.read_bytes()).hexdigest() + '\n')
        old = os.environ.get('KQ_SHARED')
        os.environ['KQ_SHARED'] = str(self.shared)
        self.addCleanup(lambda: os.environ.pop('KQ_SHARED', None) if old is None else os.environ.__setitem__('KQ_SHARED', old))

    def write(self, p, value):
        p.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        p.write_text(value)
        p.chmod(0o600)

    def evidence(self):
        with m.shared_writer(self.local) as store:
            return m.shared_evidence(store)

    def test_real_protocol_fences_concurrent_writer_and_releases_after_exception(self):
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            with m.shared_writer(self.local) as store:
                owner = json.loads((store['generation'] / 'owner.json').read_text())
                self.assertEqual(owner['version'], 1)
                self.assertEqual(set(owner['identity']), {'host', 'boot', 'start', 'pid', 'token', 'instance'})
                with self.assertRaisesRegex(ValueError, 'active or requires recovery'):
                    with m.shared_writer(self.local):
                        self.fail('same real generation fence must exclude a second writer')
                raise RuntimeError('injected')
        with m.shared_writer(self.local):
            pass

    def test_maintenance_generations_do_not_invalidate_unchanged_snapshot(self):
        self.assertEqual(self.evidence(), self.evidence())

    def test_shared_v5_record_attempt_stop_receipt_and_journal_are_not_sqlite_state(self):
        paths = [self.store / 'records' / 'record.json', self.store / 'attempts' / 'id' / 'old.json', self.shared / 'materials' / 'installs' / 'run-test' / 'slurm.json']
        for p in paths:
            with self.subTest(path=p):
                baseline = self.evidence()
                self.write(p, json.dumps({'workerStopped': {'noRequeue': True}, 'resumedFrom': {'operationId': 'new'}}))
                self.assertNotEqual(self.evidence(), baseline)
                p.unlink()
        baseline = self.evidence()
        # Stop proof/worker history participates even when no record/SQLite row changed.
        with m.shared_writer(self.local) as state:
            history = state['generation'].parent
        token = str(uuid.uuid4())
        generation = history / str(len(list(history.iterdir()))).zfill(16)
        self.write(generation / 'owner.json', json.dumps({'version': 1, 'identity': {'host': None, 'boot': None, 'start': None, 'pid': os.getpid(), 'instance': str(uuid.uuid4()), 'token': token}}))
        self.write(generation / 'worker-finished.json', '{"proof":"fixture-stop-receipt"}')
        self.write(generation / 'released.json', json.dumps(token))
        self.assertNotEqual(self.evidence(), baseline)

    def test_unknown_or_unreleased_protocol_never_becomes_idle(self):
        self.evidence()
        history = self.store / '.writer-lock/generations'
        generation = sorted(history.iterdir())[-1]
        (generation / 'released.json').unlink()
        with self.assertRaisesRegex(ValueError, 'active or requires recovery'):
            self.evidence()

    def test_profile_digest_owner_and_symlink_are_checked(self):
        self.write(self.profile, '{"version":1,"storeRoot":"/wrong"}')
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            self.evidence()
        self.write(self.profile, json.dumps({'version': 1, 'storeRoot': str(self.store)}))
        self.store.chmod(0o777)
        with self.assertRaisesRegex(ValueError, 'owned and not writable'):
            self.evidence()
        self.store.chmod(0o700)
        target = self.shared / 'other'
        self.store.rename(target)
        self.store.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'canonical'):
            self.evidence()


if __name__ == '__main__':
    unittest.main()

"""Pure metadata tests. Executed only by GitHub Actions; never run Spack."""

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_SPEC = importlib.util.spec_from_file_location(
    "target_probe", Path(__file__).with_name("probe.py")
)
probe = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(probe)


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "delivery"
        self.root.mkdir()
        files = {
            "recipes.bundle": b"fixture-bundle",
            "spack.lock": b"fixture-lock",
            "sources/hello/hello-2.12.1.tar.gz": b"fixture-source",
        }
        self.metadata = {
            "version": 1, "profile": "ubuntu24",
            "target": "linux-ubuntu24.04-x86_64", "spec": "hello@2.12.1",
            "rootHash": "a" * 32, "recipeCommit": "b" * 40,
            "spackCommit": probe.SPACK_COMMIT,
            "files": {},
        }
        for name, content in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            self.metadata["files"][name] = {
                "sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)
            }
        self.write_metadata()

    def write_metadata(self):
        (self.root / "metadata.json").write_text(json.dumps(self.metadata))

    def test_valid_inventory(self):
        self.assertEqual(probe.validate_delivery(self.root, "ubuntu24"), self.metadata)

    def test_wrong_profile_and_target(self):
        with self.assertRaises(probe.ProbeError):
            probe.validate_delivery(self.root, "ubuntu26")
        self.metadata["target"] = "linux-ubuntu26.04-x86_64"
        self.write_metadata()
        with self.assertRaises(probe.ProbeError):
            probe.validate_delivery(self.root, "ubuntu24")

    def test_missing_corrupt_and_extra_source(self):
        path = self.root / "sources/hello/hello-2.12.1.tar.gz"
        path.unlink()
        with self.assertRaises(probe.ProbeError):
            probe.validate_delivery(self.root, "ubuntu24")
        path.write_bytes(b"tampered-value")
        with self.assertRaises(probe.ProbeError):
            probe.validate_delivery(self.root, "ubuntu24")
        path.write_bytes(b"fixture-source")
        (path.parent / "extra").write_text("unexpected")
        with self.assertRaises(probe.ProbeError):
            probe.validate_delivery(self.root, "ubuntu24")

    def test_reject_symlink_and_hardlink(self):
        path = self.root / "spack.lock"
        path.unlink()
        path.symlink_to(self.root / "recipes.bundle")
        with self.assertRaises(probe.ProbeError):
            probe.validate_delivery(self.root, "ubuntu24")
        path.unlink()
        path.hardlink_to(self.root / "recipes.bundle")
        with self.assertRaises(probe.ProbeError):
            probe.validate_delivery(self.root, "ubuntu24")

    def test_unknown_fields_and_invalid_sizes(self):
        for changes in ({"extra": True}, {"spackCommit": "c" * 40}):
            original = dict(self.metadata)
            self.metadata.update(changes)
            self.write_metadata()
            with self.assertRaises(probe.ProbeError):
                probe.validate_delivery(self.root, "ubuntu24")
            self.metadata = original
        self.metadata["files"]["spack.lock"]["bytes"] = True
        self.write_metadata()
        with self.assertRaises(probe.ProbeError):
            probe.validate_delivery(self.root, "ubuntu24")

    def test_traversal_and_duplicate_json_keys(self):
        self.metadata["files"]["../outside"] = {"sha256": "a" * 64, "bytes": 1}
        self.write_metadata()
        with self.assertRaises(probe.ProbeError):
            probe.validate_delivery(self.root, "ubuntu24")
        (self.root / "metadata.json").write_text('{"version":1,"version":1}')
        with self.assertRaises(probe.ProbeError):
            probe.validate_delivery(self.root, "ubuntu24")

    def test_missing_source_negative_preserves_original(self):
        work = Path(self.temp.name) / "work"
        work.mkdir()
        probe.missing_source_check(self.root, "ubuntu24", self.metadata, work)
        self.assertEqual(probe.validate_delivery(self.root, "ubuntu24"), self.metadata)
        self.assertEqual(list(work.iterdir()), [])

    def test_profile_allowlist(self):
        self.assertEqual(probe.target("centos7"), "linux-centos7-x86_64")
        self.assertEqual(probe.target("ubuntu26"), "linux-ubuntu26.04-x86_64")
        for profile in ("", "ubuntu", "ubuntu20", "../centos7"):
            with self.assertRaises(probe.ProbeError):
                probe.target(profile)


if __name__ == "__main__":
    unittest.main()

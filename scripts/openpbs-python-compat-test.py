"""Check the PBS-only backport without building images or starting services."""
import hashlib
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PATCH = ROOT / "deploy/schedulers/pbs/openpbs-python-compat.patch"
SOURCES = ("src/lib/Libpython/pbs_python_external.c", "src/lib/Libpython/shared_python_utils.c",
           "src/resmom/mom_main.c", "src/scheduler/fifo.cpp")


class OpenPbsPythonCompatibilityTests(unittest.TestCase):
    def apply_build_step(self, ref, patch_status=0):
        text = (ROOT / "deploy/schedulers/pbs/Dockerfile").read_text()
        start = text.index('if [[ "${OPENPBS_REF}" == v23.06.06 ]]')
        end = text.index("  && ./autogen.sh", start)
        script = text[start:end].rstrip().removesuffix("\\").rstrip()
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "patch-called"
            script = script.replace("/tmp/openpbs-python-compat.patch", str(PATCH))
            env = {**os.environ, "OPENPBS_REF": ref, "PATCH_STATUS": str(patch_status), "MARKER": str(marker)}
            result = subprocess.run(["bash", "-o", "pipefail", "-c",
                                     'patch() { touch "$MARKER"; return "$PATCH_STATUS"; }\n' + script],
                                    env=env, capture_output=True, text=True, timeout=5)
            return result.returncode, marker.exists()

    def test_only_default_source_is_backported_and_failure_stops_build(self):
        self.assertEqual(self.apply_build_step("v23.06.06"), (0, True))
        self.assertEqual(self.apply_build_step("other-explicit-ref"), (0, False))
        self.assertEqual(self.apply_build_step("v23.06.06", patch_status=1), (1, True))

    def test_backport_applies_to_pinned_source_without_fuzz_and_keeps_python_hooks(self):
        archive = Path(os.environ.get("OPENPBS_SOURCE_ARCHIVE", ROOT / "temp/federation-pbs/openpbs.tar.gz"))
        if not archive.is_file():
            self.skipTest("Provide OPENPBS_SOURCE_ARCHIVE for the pinned OpenPBS 23.06.06 source")
        self.assertIn(hashlib.sha256(archive.read_bytes()).hexdigest(), {
            "297ea4d5933e867b51366b213184a5251a41261f16079ffde86511e0bbc6606c",  # commit archive
            "689df6caa101422237118d81f9cfb0e6cad432209c77a6b3b8021cf984a91a90",  # tag archive
        })
        with tempfile.TemporaryDirectory() as directory, tarfile.open(archive) as source:
            root = Path(directory)
            for name in SOURCES:
                members = [item for item in source.getmembers() if item.isfile() and item.name.endswith("/" + name)]
                self.assertEqual(len(members), 1)
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.extractfile(members[0]).read())
            result = subprocess.run(["patch", "--batch", "--forward", "--fuzz=0", "-p1", "-i", str(PATCH)],
                                    cwd=root, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotIn("fuzz", result.stdout)
            external = (root / SOURCES[0]).read_text()
            self.assertIn("#include <Python.h>", external)
            self.assertNotIn("#include <eval.h>", external)
            self.assertIn("initialize_python_config(1)", external)
            self.assertIn("initialize_python_config(0)", external)
            for name in (SOURCES[0], SOURCES[2], SOURCES[3]):
                text = (root / name).read_text()
                for setting in ("use_environment = 0", "isolated = 1", "site_import = 0"):
                    self.assertIn(setting, text)
                self.assertIn("Py_InitializeFromConfig(&py_config)", text)
            repeated = subprocess.run(["patch", "--batch", "--forward", "--fuzz=0", "-p1", "-i", str(PATCH)],
                                       cwd=root, capture_output=True, text=True, timeout=5)
            self.assertNotEqual(repeated.returncode, 0)
        dockerfile = (ROOT / "deploy/schedulers/pbs/Dockerfile").read_text()
        self.assertIn("./configure --prefix=/opt/pbs --with-python=/usr", dockerfile)


if __name__ == "__main__":
    unittest.main()

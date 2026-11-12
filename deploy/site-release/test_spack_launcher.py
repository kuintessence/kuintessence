"""Offline launcher contract checks; no container or cluster process is started."""

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "spack_launcher", Path(__file__).with_name("spack-launcher.py")
)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.shared = Path(self.temp.name).resolve()
        self.release = self.shared / "releases" / ("a" * 64)
        self.release.mkdir(parents=True)
        (self.release / "spack").write_text("fixture launcher")
        (self.release / "runtime.sif").write_text("fixture runtime")
        self.state = self.shared / "spack-cli"

    def run_launcher(self):
        with patch.object(launcher, "__file__", str(self.release / "spack")), patch(
            "sys.argv", ["spack", "find", "--json"]
        ), patch.object(launcher.os, "execv") as fake_apptainer:
            previous = Path.cwd()
            try:
                launcher.main()
                self.assertEqual(Path.cwd(), self.state)
                return fake_apptainer.call_args.args
            finally:
                os.chdir(previous)

    def test_argv_and_persistent_private_state(self):
        binary, argv = self.run_launcher()
        self.assertEqual(binary, "/usr/bin/apptainer")
        self.assertEqual(argv, [
            binary, "exec", "--containall", "--userns", "--cleanenv", "--no-home",
            "--net", "--network", "none", "--pwd", "/kq/cli",
            "--bind", f"{self.state}:/kq/cli",
            "--env", "HOME=/kq/cli/home",
            "--env", "SPACK_DISABLE_LOCAL_CONFIG=1",
            "--env", "SPACK_USER_CONFIG_PATH=/kq/cli/config",
            "--env", "SPACK_USER_CACHE_PATH=/kq/cli/cache",
            str(self.release / "runtime.sif"), "/opt/spack/bin/spack",
            "-c", "config:install_tree:root:/kq/cli/store",
            "-c", "bootstrap:enable:false", "find", "--json",
        ])
        sentinel = self.state / "store" / "fixture-db"
        sentinel.write_text("retained database")
        self.run_launcher()
        self.assertEqual(sentinel.read_text(), "retained database")
        for path in [self.state, *(self.state / n for n in ("home", "config", "cache", "store"))]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        self.assertEqual(sorted(p.name for p in self.release.iterdir()), ["runtime.sif", "spack"])

    def test_rejects_symlinked_state_and_children(self):
        for child in (None, "home", "config", "cache", "store"):
            with self.subTest(child=child):
                if child is None:
                    self.state.symlink_to(self.shared, target_is_directory=True)
                    with self.assertRaises(ValueError):
                        self.run_launcher()
                    self.state.unlink()
                else:
                    self.run_launcher()
                    target = self.state / child
                    target.rmdir()
                    target.symlink_to(self.shared, target_is_directory=True)
                    with self.assertRaises(ValueError):
                        self.run_launcher()
                    target.unlink()
                    target.mkdir(mode=0o700)

    def test_rejects_permissive_state_and_foreign_owner(self):
        self.run_launcher()
        self.state.chmod(0o755)
        with self.assertRaises(ValueError):
            self.run_launcher()
        self.state.chmod(0o700)
        with patch.object(launcher.os, "getuid", return_value=self.state.stat().st_uid + 1):
            with self.assertRaises(ValueError):
                self.run_launcher()


if __name__ == "__main__":
    unittest.main()

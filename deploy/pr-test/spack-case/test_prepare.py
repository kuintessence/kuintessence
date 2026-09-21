"""Offline metadata regressions; run in CI with Python unittest and local Git."""

import ast
import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch


module_spec = importlib.util.spec_from_file_location(
    "case_prepare", Path(__file__).with_name("prepare.py")
)
prepare = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(prepare)


def record(path, data=b"fixture\n", mode="100644", kind="blob", digest=None, size=None):
    digest = digest or hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    size = str(len(data)) if size is None else size
    return f"{mode} {kind} {digest} {size}\t{path}\0".encode()


class TreeParserTests(unittest.TestCase):
    def test_case_mirror_preserves_release_and_independent_checksum(self):
        tree = ast.parse(Path(__file__).with_name("hello").joinpath("package.py").read_text())
        package = next(node for node in tree.body if isinstance(node, ast.ClassDef))
        url = next(
            node.value for node in package.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "url" for target in node.targets)
        )
        self.assertEqual(
            ast.literal_eval(url),
            "https://mirrors.ocf.berkeley.edu/gnu/hello/hello-2.12.1.tar.gz",
        )
        versions = [
            node.value for node in package.body if isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
            and node.value.func.id == "version"
        ]
        self.assertEqual(len(versions), 1)
        self.assertEqual([ast.literal_eval(arg) for arg in versions[0].args], ["2.12.1"])
        self.assertEqual(
            {item.arg: ast.literal_eval(item.value) for item in versions[0].keywords},
            {"sha256": "8d99142afd92576f30b0cd7cb42a8dc6809998bc5d607d88761f512e26c7db20"},
        )

    def licenses(self):
        return b"".join(record(name) for name in prepare.LICENSES)

    def test_regular_executable_empty_blobs_and_license_boundary(self):
        data = self.licenses() + b"".join((
            record("repos/example/package.py"),
            record("repos/example/helper", b"", mode="100755"),
            record("README.md"),
            record("LICENSE-unselected"),
            record("repos-other/ignored"),
        ))
        entries = prepare.parse_tree(data)
        self.assertEqual(set(entries), {
            *prepare.LICENSES, "repos/example/package.py", "repos/example/helper",
        })
        self.assertEqual(entries["repos/example/helper"]["mode"], "100755")
        self.assertEqual(entries["repos/example/helper"]["size"], 0)

    def test_rejects_malformed_paths_modes_types_hashes_and_sizes(self):
        invalid = (
            b"100644 blob missing-fields\trepos/file\0",
            b"100644 blob " + b"a" * 40 + b" 1 repos/file\0",
            record("repos/file", mode="120000"),
            record("repos/file", mode="160000", kind="commit", size="-"),
            record("repos/file", kind="tree", mode="040000", size="-"),
            record("repos/file", mode="100600"),
            record("repos/file", digest="not-a-hash"),
            record("repos/file", size="-1"),
            record("repos/file", size="x"),
            record("repos/../escape"),
            record("repos/.git/config"),
            record("repos/file\twith-tab"),
            record("repos/file\nwith-newline"),
        )
        for entry in invalid:
            with self.subTest(entry=entry), self.assertRaises(RuntimeError):
                prepare.parse_tree(self.licenses() + entry)

    def test_rejects_truncation_duplicates_missing_licenses_and_budgets(self):
        valid = self.licenses() + record("repos/file")
        for data in (b"", valid[:-1], valid + record("repos/file"),
                     record("repos/file"), valid + b"\0"):
            with self.subTest(data=data), self.assertRaises(RuntimeError):
                prepare.parse_tree(data)
        with patch.object(prepare, "MAX_TREE_BYTES", len(valid) - 1):
            with self.assertRaisesRegex(RuntimeError, "metadata budget"):
                prepare.parse_tree(valid)
        with patch.object(prepare, "MAX_FILES", len(prepare.LICENSES)):
            with self.assertRaisesRegex(RuntimeError, "file budget"):
                prepare.parse_tree(valid)


class CheckoutTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="kq-prepare-test-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.upstream = self.base / "upstream"
        self.upstream.mkdir()
        self.destination = self.base / "recipes"
        self.environment = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.environment.update({
            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        })
        self.git("init")
        self.contents = {
            **{name: (name + "\n").encode() for name in prepare.LICENSES},
            "repos/example/repo.yaml": b"repo:\n  namespace: example\n",
            "repos/example/packages/demo/package.py": b"# fixture only\n",
            "repos/example/helper": b"fixture executable, never executed\n",
            "README.md": b"not published\n",
        }
        for name, data in self.contents.items():
            path = self.upstream / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o755 if name.endswith("/helper") else 0o644)
        self.git("add", "--", ".")
        self.tree = self.git("write-tree").decode().strip()
        self.commit = self.git("commit-tree", self.tree, "-m", "fixture").decode().strip()
        self.git("update-ref", "HEAD", self.commit)
        for name, value in (
            ("UPSTREAM", self.upstream), ("UPSTREAM_COMMIT", self.commit),
            ("UPSTREAM_TREE", self.tree),
        ):
            mocked = patch.object(prepare, name, value)
            mocked.start()
            self.addCleanup(mocked.stop)

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.upstream, env=self.environment, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15,
        ).stdout

    def test_real_git_tree_and_copy_preserve_content_modes_and_license_boundary(self):
        entries = prepare.official_tree()
        expected = {name for name in self.contents if name != "README.md"}
        self.assertEqual(set(entries), expected)
        for name in expected:
            data = self.contents[name]
            entry = entries[name]
            self.assertEqual(entry["size"], len(data))
            self.assertEqual(entry["sha"], hashlib.sha1(
                b"blob " + str(len(data)).encode() + b"\0" + data
            ).hexdigest())
        prepare.copy_recipes(self.destination)
        for name in expected:
            copied = self.destination / name
            self.assertEqual(copied.read_bytes(), self.contents[name])
            self.assertEqual(stat.S_IMODE(copied.stat().st_mode),
                             0o755 if name.endswith("/helper") else 0o644)
        self.assertFalse((self.destination / ".git").exists())
        self.assertFalse((self.destination / "README.md").exists())
        self.assertTrue((self.destination / prepare.ROOTS[0] / "packages/hello/package.py").is_file())
        self.assertTrue((self.destination / "upstream.json").is_file())

    def test_rejects_wrong_commit_and_tree_pins(self):
        for name, message in (("UPSTREAM_COMMIT", "commit"), ("UPSTREAM_TREE", "tree")):
            with self.subTest(pin=name), patch.object(prepare, name, "0" * 40):
                with self.assertRaisesRegex(RuntimeError, "Incorrectly pinned upstream " + message):
                    prepare.copy_recipes(self.destination)
                self.assertFalse(self.destination.exists())

    def test_shallow_fetch_of_exact_commit_uses_only_local_file_transport(self):
        commit = self.git("commit-tree", self.tree, "-p", self.commit, "-m", "child").decode().strip()
        self.git("update-ref", "HEAD", commit)
        source = self.upstream.as_uri()
        checkout = self.base / "shallow"
        checkout.mkdir()
        with patch.object(self, "upstream", checkout), patch.object(prepare, "UPSTREAM", checkout):
            with patch.object(prepare, "UPSTREAM_COMMIT", commit):
                self.git("init")
                self.git("fetch", "--depth=1", "--no-tags", source, commit)
                self.git("checkout", "--detach", commit)
                self.assertEqual(self.git("rev-parse", "--is-shallow-repository").strip(), b"true")
                self.assertEqual(self.git("rev-list", "--count", "HEAD").strip(), b"1")
                prepare.copy_recipes(self.destination)
        self.assertEqual(
            (self.destination / "repos/example/helper").read_bytes(),
            self.contents["repos/example/helper"],
        )

    def test_rejects_tampered_blob_size_and_mode(self):
        source = self.upstream / "repos/example/packages/demo/package.py"
        original = source.read_bytes()
        for failure, message in (("bytes", "Git blob"), ("size", "file size"), ("mode", "file mode")):
            with self.subTest(failure=failure):
                source.write_bytes(original)
                source.chmod(0o644)
                if failure == "bytes":
                    source.write_bytes(b"x" * len(original))
                elif failure == "size":
                    source.write_bytes(original + b"x")
                else:
                    source.chmod(0o755)
                with self.assertRaisesRegex(RuntimeError, message + " mismatch"):
                    prepare.copy_recipes(self.base / failure)

    def test_rejects_missing_extra_symlink_and_special_recipe_files(self):
        source = self.upstream / "repos/example/packages/demo/package.py"
        original = source.read_bytes()
        source.unlink()
        with self.assertRaisesRegex(RuntimeError, "Local recipes differ"):
            prepare.copy_recipes(self.destination)
        source.symlink_to(self.upstream / "README.md")
        with self.assertRaisesRegex(RuntimeError, "Non-regular recipe"):
            prepare.copy_recipes(self.destination)
        source.unlink()
        os.mkfifo(source)
        with self.assertRaisesRegex(RuntimeError, "Non-regular recipe"):
            prepare.copy_recipes(self.destination)
        source.unlink()
        source.write_bytes(original)
        source.chmod(0o644)
        (self.upstream / "repos/extra").write_bytes(b"untracked\n")
        with self.assertRaisesRegex(RuntimeError, "Local recipes differ"):
            prepare.copy_recipes(self.destination)

    def test_rejects_missing_symlinked_or_tampered_license(self):
        source = self.upstream / prepare.LICENSES[0]
        original = source.read_bytes()
        source.unlink()
        with self.assertRaises(FileNotFoundError):
            prepare.copy_recipes(self.destination)
        source.symlink_to(self.upstream / "README.md")
        with self.assertRaisesRegex(RuntimeError, "not a regular file"):
            prepare.copy_recipes(self.destination)
        source.unlink()
        source.write_bytes(b"x" * len(original))
        source.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "Git blob mismatch"):
            prepare.copy_recipes(self.destination)

    def test_metadata_and_copy_budgets(self):
        with patch.object(prepare, "MAX_TREE_BYTES", 10):
            with self.assertRaisesRegex(RuntimeError, "metadata budget"):
                prepare.upstream_git("ls-tree", "-r", "-l", "-z", self.tree)
        with patch.object(prepare, "MAX_RECIPE_BYTES", 1):
            with self.assertRaisesRegex(RuntimeError, "Recipe byte budget"):
                prepare.copy_recipes(self.destination)

    def test_git_failures_do_not_fall_back_to_network(self):
        with patch.object(prepare.subprocess, "run", side_effect=subprocess.CalledProcessError(
            128, ["git", "rev-parse"]
        )):
            with self.assertRaises(subprocess.CalledProcessError):
                prepare.official_tree()

    def test_dockerfile_fetches_and_checks_out_the_pinned_commit(self):
        dockerfile = Path(__file__).with_name("materials.Dockerfile").read_text()
        self.assertIn("fetch --depth=1 --no-tags", dockerfile)
        self.assertIn("https://github.com/spack/spack-packages.git", dockerfile)
        # The fixture changes runtime constants, not the production pin in the source.
        source = Path(__file__).with_name("prepare.py").read_text()
        pinned = "32c54f0906004d7fd1f72fd1b5970bf2bf094e26"
        self.assertIn('UPSTREAM_COMMIT = "' + pinned + '"', source)
        self.assertIn('UPSTREAM_TREE = "f117b6bf72ee6d9c2951922f4afd31f461b02b0d"', source)
        self.assertIn("checkout --detach " + pinned, dockerfile)
        self.assertNotIn("api.github.com", source + dockerfile)
        self.assertNotIn("urllib.request", source)
        self.assertNotIn("spack-packages/archive/", dockerfile)


if __name__ == "__main__":
    unittest.main()

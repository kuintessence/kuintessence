"""Offline metadata regressions; run in CI with Python unittest and local Git."""

import ast
from contextlib import ExitStack, contextmanager, nullcontext
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


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

    def test_samtools_copy_preserves_upstream_without_custom_recipe_overlay(self):
        prepare.copy_recipes(self.destination, "samtools")
        expected = {name for name in self.contents if name != "README.md"}
        copied = {
            path.relative_to(self.destination).as_posix()
            for path in prepare.files(self.destination)
        }
        self.assertEqual(copied, expected | {"upstream.json"})
        for name in expected:
            self.assertEqual((self.destination / name).read_bytes(), self.contents[name])
        self.assertFalse((self.destination / prepare.ROOTS[0]).exists())
        self.assertEqual(json.loads((self.destination / "upstream.json").read_text()), {
            "repository": "spack/spack-packages", "commit": self.commit,
        })

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
        self.assertIn("ARG KQ_PR_SPACK_CASE=hello", dockerfile)
        self.assertIn('prepare.py /case "$KQ_PR_SPACK_CASE"', dockerfile)


class CaseTests(unittest.TestCase):
    def test_prepare_checks_scope_and_canonical_spec_before_solving(self):
        class StopBeforeSolve(Exception):
            pass

        for case, canonical in (
            ("hello", True), ("samtools", True), ("hello", False), ("samtools", False),
        ):
            with self.subTest(case=case, canonical=canonical), tempfile.TemporaryDirectory() as directory:
                work = Path(directory) / "work"
                output = Path(directory) / "output"
                work.mkdir()
                output.mkdir()
                modules = {
                    name: ModuleType(name) for name in (
                        "spack", "spack.config", "spack.detection", "spack.environment",
                        "spack.fetch_strategy", "spack.mirrors", "spack.mirrors.utils",
                        "spack.paths", "spack.repo", "spack.spec", "spack.store",
                        "clingo", "clingo.ast",
                    )
                }
                for name, module in modules.items():
                    module.__path__ = []
                    if "." in name:
                        parent, attribute = name.rsplit(".", 1)
                        setattr(modules[parent], attribute, module)
                modules["spack"].__version__ = "1.0.0"
                modules["clingo"].__version__ = "5.7.1"
                modules["spack.paths"].etc_path = "/unexpected-spack-defaults"
                scope = SimpleNamespace(name="kq-case", data=None)
                active = False

                def internal_scope(name, data):
                    self.assertEqual(name, scope.name)
                    scope.data = data
                    return scope

                @contextmanager
                def use_configuration(*scopes):
                    nonlocal active
                    self.assertEqual(scopes, (scope,))
                    active = True
                    try:
                        yield
                    finally:
                        active = False

                detected = {
                    name: [SimpleNamespace(external_path="/usr")]
                    for name in prepare.case_definition(case)["externals"]
                }

                def update_configuration(entries, **kwargs):
                    self.assertTrue(active)
                    self.assertEqual(kwargs, {"scope": scope.name, "buildable": False})
                    self.assertEqual(entries, detected)
                    # Spack's update_config rewrites the section without its override marker.
                    packages = scope.data.pop("packages:")
                    scope.data["packages"] = packages
                    for name, externals in entries.items():
                        packages[name]["externals"] = externals

                def get_config(path):
                    self.assertTrue(active)
                    section, name, field = path.split(":")
                    return scope.data[section][name][field]

                def concretize(**kwargs):
                    self.assertTrue(active)
                    self.assertEqual(kwargs, {"tests": False})
                    packages = scope.data["packages"]
                    self.assertEqual(set(packages), {"all", "glibc", *detected})
                    self.assertEqual(packages["all"], {"require": ["arch=" + prepare.TARGET]})
                    for config in packages.values():
                        self.assertNotIn("providers", config)
                        self.assertNotIn("prefer", config)
                    self.assertEqual(
                        scope.data["concretizer"].get("duplicates", {}).get("strategy", "none"),
                        "none",
                    )
                    raise StopBeforeSolve()

                config = modules["spack.config"]
                config.InternalConfigScope = Mock(side_effect=internal_scope)
                config.use_configuration = Mock(side_effect=use_configuration)
                config.get = Mock(side_effect=get_config)
                detection = modules["spack.detection"]
                detection.by_path = Mock(return_value=detected)
                detection.update_configuration = Mock(side_effect=update_configuration)
                environment = SimpleNamespace(concretize=Mock(side_effect=concretize))
                modules["spack.environment"].Environment = Mock(
                    return_value=nullcontext(environment),
                )
                modules["spack.repo"].use_repositories = Mock(return_value=nullcontext())
                modules["spack.store"].use_store = Mock(return_value=nullcontext())
                spec = prepare.case_definition(case)["spec"]
                native_spec = Mock(return_value=spec if canonical else spec + " ")
                modules["spack.spec"].Spec = native_spec
                with ExitStack() as stack:
                    stack.enter_context(patch.dict(prepare.sys.modules, modules))
                    stack.enter_context(patch.object(prepare, "copy_recipes"))
                    stack.enter_context(patch.object(prepare, "bundle_recipes", return_value="a" * 40))
                    fetch = stack.enter_context(patch.object(prepare, "fetch_sources"))
                    if canonical:
                        with self.assertRaises(StopBeforeSolve):
                            prepare.prepare(output, work, case)
                    else:
                        with self.assertRaisesRegex(RuntimeError, "Material spec is not canonical"):
                            prepare.prepare(output, work, case)
                    fetch.assert_not_called()
                native_spec.assert_called_once_with(spec)
                config.use_configuration.assert_called_once_with(scope)
                detection.by_path.assert_called_once_with(
                    ["builtin." + name for name in detected],
                    path_hints=["/usr/bin"], max_workers=2,
                )
                detection.update_configuration.assert_called_once()
                if canonical:
                    environment.concretize.assert_called_once_with(tests=False)
                else:
                    environment.concretize.assert_not_called()
                    modules["spack.environment"].Environment.assert_not_called()
                    self.assertFalse((work / "env").exists())
                self.assertFalse(active)

    def test_default_hello_and_samtools_metadata_bind_exact_specs_and_roots(self):
        self.assertEqual(prepare.case_definition(), prepare.case_definition("hello"))
        for case, spec, roots in (
            ("hello", "hello@2.12.1", prepare.ROOTS),
            ("samtools",
             "samtools@1.19.2 ^htslib@1.19.1~libcurl~libdeflate"
             " ^ncurses+symlinks %pkgconf ^zlib@1.3.1",
             ["repos/spack_repo/builtin"]),
        ):
            with self.subTest(case=case):
                sources = [{"path": "source.tar.gz", "file": "sources/source.tar.gz"}]
                metadata = prepare.material_metadata(case, prepare.TARGET, "a" * 40, sources)
                self.assertEqual(metadata, {
                    "case": case, "spec": spec, "target": "linux-ubuntu20.04-x86_64",
                    "commit": "a" * 40, "roots": roots, "sources": sources,
                    "lockfile": "spack.lock",
                })
                metadata["roots"].clear()
                self.assertTrue(prepare.case_definition(case)["roots"])

    def test_unknown_case_fails_before_filesystem_or_spack_work(self):
        for case in ("", "HELLO", "../hello", "samtools@1.19.2", "hello;id"):
            with self.subTest(case=case), patch.object(prepare, "official_tree") as tree:
                with self.assertRaisesRegex(RuntimeError, "Unsupported material case"):
                    prepare.copy_recipes(Path("/unused"), case)
                tree.assert_not_called()
                with self.assertRaisesRegex(RuntimeError, "Unsupported material case"):
                    prepare.prepare(Path("/unused"), Path("/unused"), case)
                with patch.object(prepare.sys, "argv", ["prepare.py", "/unused", case]):
                    with patch.object(prepare.Path, "mkdir") as mkdir:
                        with self.assertRaisesRegex(RuntimeError, "Unsupported material case"):
                            prepare.main()
                        mkdir.assert_not_called()

    def test_cli_defaults_to_hello_and_publishes_only_after_prepare_success(self):
        for extra, case in (([], "hello"), (["hello"], "hello"), (["samtools"], "samtools")):
            with self.subTest(case=case, extra=extra), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "output"

                def prepared(destination, work, selected):
                    self.assertEqual((destination, selected), (output.resolve(), case))
                    self.assertTrue(work.is_dir())
                    self.assertFalse((destination / "metadata.json").exists())
                    for name in ("spack.lock", "recipes.bundle"):
                        (destination / name).write_bytes(b"fixture")
                    return prepare.material_metadata(case, prepare.TARGET, "a" * 40, [])

                with patch.object(prepare.sys, "argv", ["prepare.py", str(output), *extra]):
                    with patch.object(prepare, "prepare", side_effect=prepared) as native:
                        with patch("builtins.print"), patch.object(prepare.os, "umask"):
                            with patch.object(prepare.sys, "dont_write_bytecode", True):
                                prepare.main()
                    native.assert_called_once()
                metadata = json.loads((output / "metadata.json").read_text())
                self.assertEqual(metadata["case"], case)
                self.assertEqual(metadata["spec"], prepare.case_definition(case)["spec"])
                self.assertEqual(stat.S_IMODE((output / "metadata.json").stat().st_mode), 0o644)
                self.assertFalse(list(output.glob(".prepare-*")))

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "failed"
            with patch.object(prepare.sys, "argv", ["prepare.py", str(output), "samtools"]):
                with patch.object(prepare, "prepare", side_effect=RuntimeError("fetch failed")):
                    with patch.object(prepare.os, "umask"):
                        with patch.object(prepare.sys, "dont_write_bytecode", True):
                            with self.assertRaisesRegex(RuntimeError, "fetch failed"):
                                prepare.main()
            self.assertFalse((output / "metadata.json").exists())
            self.assertFalse(list(output.iterdir()))

    def test_cli_rejects_missing_output_and_extra_arguments(self):
        for args in (["prepare.py"], ["prepare.py", "/unused", "hello", "extra"]):
            with self.subTest(args=args), patch.object(prepare.sys, "argv", args):
                with self.assertRaisesRegex(RuntimeError, "Usage:"):
                    prepare.main()

    def test_case_configuration_bounds_source_dependencies_and_system_externals(self):
        hello = prepare.configuration(Path("/work"))
        self.assertEqual(hello, prepare.configuration(Path("/work"), "hello"))
        self.assertNotIn("python", hello["packages:"])
        samtools = prepare.configuration(Path("/work"), "samtools")
        packages = samtools["packages:"]
        self.assertEqual(
            {name for name, config in packages.items() if config.get("buildable") is False},
            {"gcc", "gmake", "glibc", "python", "perl"},
        )
        self.assertEqual(set(packages), {"all", "gcc", "gmake", "glibc", "python", "perl"})
        self.assertNotIn("providers", packages["all"])
        self.assertEqual(prepare.case_definition("samtools")["compiled"], {
            "samtools": "1.19.2", "htslib": "1.19.1", "zlib": "1.3.1",
            "ncurses": None, "bzip2": None, "xz": None,
            "pkgconf": None, "diffutils": None, "libiconv": None,
        })
        for configuration in (hello, samtools):
            self.assertEqual(configuration["packages:"]["all"]["require"],
                             ["arch=linux-ubuntu20.04-x86_64"])
            self.assertFalse(configuration["bootstrap:"]["enable"])
            self.assertFalse(configuration["concretizer"]["reuse"])
            self.assertTrue(configuration["config"]["checksum"])
            self.assertTrue(configuration["config"]["verify_ssl"])

    def dag(self, case):
        selected = prepare.case_definition(case)
        nodes = [
            SimpleNamespace(
                name=name, version=version or "fixture-default", namespace="builtin",
                architecture=prepare.TARGET, external=False, satisfies=lambda _: True,
            )
            for name, version in selected["compiled"].items()
        ]
        nodes.extend(
            SimpleNamespace(
                name=name, namespace="builtin", architecture=prepare.TARGET, external=True,
                external_path="/usr", external_modules=[],
            )
            for name in (*selected["externals"], "glibc")
        )
        root = nodes[0]
        root.namespace = selected["namespace"]
        root.traverse = lambda: iter(nodes)
        return root, nodes

    def test_native_dag_accepts_both_cases_without_changing_resource_caps(self):
        self.assertEqual(prepare.MAX_DAG_NODES, 16)
        self.assertEqual(prepare.MAX_SOURCES, 128)
        self.assertEqual(prepare.MAX_SOURCE_BYTES, 64 * 1024 ** 2)
        for case in ("hello", "samtools"):
            with self.subTest(case=case):
                root, nodes = self.dag(case)
                nodes.extend(
                    SimpleNamespace(
                        name=name, namespace="builtin", architecture=prepare.TARGET,
                        external=False,
                    )
                    for name in prepare.RUNTIME_PACKAGES
                )
                self.assertEqual(prepare.validate_dag(root, case),
                                 [node for node in nodes if not node.external])
                self.assertLessEqual(len(nodes), prepare.MAX_DAG_NODES)

    def test_unpinned_support_versions_remain_solver_output(self):
        root, nodes = self.dag("samtools")
        for node in nodes:
            if node.name in {"ncurses", "xz", "bzip2", "pkgconf", "diffutils", "libiconv"}:
                node.version = "another-upstream-default"
        nodes.remove(next(node for node in nodes if node.name == "libiconv"))
        self.assertEqual(prepare.validate_dag(root, "samtools"),
                         [node for node in nodes if not node.external])

    def test_samtools_requires_pkgconf_and_ncurses_symlinks(self):
        root, nodes = self.dag("samtools")
        ncurses = next(node for node in nodes if node.name == "ncurses")
        ncurses.satisfies = Mock(return_value=True)
        prepare.validate_dag(root, "samtools")
        ncurses.satisfies.assert_called_once_with("+symlinks %pkgconf")
        failures = {
            "missing-pkgconf": lambda nodes: nodes.remove(
                next(node for node in nodes if node.name == "pkgconf"),
            ),
            "replacement-pkg-config": lambda nodes: setattr(
                next(node for node in nodes if node.name == "pkgconf"), "name", "pkg-config",
            ),
            "missing-ncurses": lambda nodes: nodes.remove(
                next(node for node in nodes if node.name == "ncurses"),
            ),
            "ncurses-hardlinks": lambda nodes: setattr(
                next(node for node in nodes if node.name == "ncurses"),
                "satisfies", lambda spec: "+symlinks" not in spec,
            ),
            "ncurses-missing-direct-provider": lambda nodes: setattr(
                next(node for node in nodes if node.name == "ncurses"),
                "satisfies", lambda spec: "%pkgconf" not in spec,
            ),
        }
        for failure, change in failures.items():
            with self.subTest(failure=failure):
                root, nodes = self.dag("samtools")
                change(nodes)
                with self.assertRaises(RuntimeError):
                    prepare.validate_dag(root, "samtools")

    def test_dag_rejects_changed_identity_architecture_dependencies_and_externals(self):
        failures = {
            "root-version": lambda root, nodes: setattr(root, "version", "1.20"),
            "root-external": lambda root, nodes: setattr(root, "external", True),
            "root-namespace": lambda root, nodes: setattr(root, "namespace", "kq_case"),
            "root-arch": lambda root, nodes: setattr(
                root, "architecture", "linux-ubuntu22.04-x86_64",
            ),
            "build-tool-arch": lambda root, nodes: setattr(
                next(node for node in nodes if node.name == "gmake"),
                "architecture", "linux-ubuntu20.04-skylake",
            ),
            "source-version": lambda root, nodes: setattr(nodes[1], "version", "1.20"),
            "zlib-version": lambda root, nodes: setattr(
                next(node for node in nodes if node.name == "zlib"), "version", "1.3.2",
            ),
            "compiled-build-tool-arch": lambda root, nodes: setattr(
                next(node for node in nodes if node.name == "pkgconf"),
                "architecture", "linux-ubuntu20.04-skylake",
            ),
            "source-namespace": lambda root, nodes: setattr(nodes[1], "namespace", "custom"),
            "source-external": lambda root, nodes: setattr(nodes[1], "external", True),
            "extra-source": lambda root, nodes: nodes.append(SimpleNamespace(
                name="curl", external=False, architecture=prepare.TARGET,
            )),
            "missing-runtime": lambda root, nodes: nodes.remove(
                next(node for node in nodes if node.name == "python"),
            ),
            "extra-external": lambda root, nodes: nodes.append(SimpleNamespace(
                name="openssl", external=True, architecture=prepare.TARGET,
            )),
            "python-prefix": lambda root, nodes: setattr(
                next(node for node in nodes if node.name == "python"),
                "external_path", "/usr/local",
            ),
            "perl-module": lambda root, nodes: setattr(
                next(node for node in nodes if node.name == "perl"),
                "external_modules", ["perl"],
            ),
            "htslib-features": lambda root, nodes: setattr(
                nodes[1], "satisfies", lambda _: False,
            ),
            "node-budget": lambda root, nodes: nodes.extend([root] * prepare.MAX_DAG_NODES),
        }
        for failure, change in failures.items():
            with self.subTest(failure=failure):
                root, nodes = self.dag("samtools")
                change(root, nodes)
                with self.assertRaises(RuntimeError):
                    prepare.validate_dag(root, "samtools")


class SourceTests(unittest.TestCase):
    class Bundle:
        pass

    class URL:
        def __init__(self, digest="a" * 64):
            self.digest = digest

    class Expanded(URL):
        pass

    def node(self, name, fetcher, skip=False):
        stage = SimpleNamespace(default_fetcher=fetcher, skip_checksum_for_mirror=skip)
        return SimpleNamespace(name=name, package=SimpleNamespace(stage=[stage]))

    def fetch(self, nodes, create):
        strategies = SimpleNamespace(
            BundleFetchStrategy=self.Bundle, URLFetchStrategy=self.URL,
            FetchAndVerifyExpandedFile=self.Expanded,
        )
        prepare.fetch_sources(Path("/mirror"), nodes, strategies, create)

    def test_only_checksummed_sources_and_compiler_bundles_reach_native_mirror(self):
        nodes = [
            self.node("samtools", self.URL()), self.node("htslib", self.URL()),
            self.node("compiler-wrapper", self.Bundle()), self.node("gcc-runtime", self.Bundle()),
        ]
        create = Mock(return_value=([], [], []))
        self.fetch(nodes, create)
        create.assert_called_once_with("/mirror", nodes)

    def test_rejects_unchecked_expanded_vcs_bundle_and_empty_sources_before_fetch(self):
        empty = SimpleNamespace(name="samtools", package=SimpleNamespace(stage=[]))
        over = self.node("samtools", self.URL())
        over.package.stage *= prepare.MAX_SOURCES + 1
        for node in (
            self.node("samtools", self.URL(None)),
            self.node("samtools", self.URL(), skip=True),
            self.node("samtools", self.Expanded()),
            self.node("samtools", object()),
            self.node("samtools", self.Bundle()), empty, over,
        ):
            with self.subTest(node=node):
                create = Mock()
                with self.assertRaises(RuntimeError):
                    self.fetch([node], create)
                create.assert_not_called()

    def test_mirror_failure_never_becomes_a_successful_export(self):
        for create in (
            Mock(return_value=([], [], ["failed source"])),
            Mock(side_effect=RuntimeError("checksum mismatch")),
        ):
            with self.subTest(create=create), self.assertRaises(RuntimeError):
                self.fetch([self.node("samtools", self.URL())], create)

    def test_stage_budget_is_aggregate_and_checked_before_native_fetch(self):
        first = self.node("samtools", self.URL())
        first.package.stage *= prepare.MAX_SOURCES
        create = Mock()
        with self.assertRaisesRegex(RuntimeError, "Source stage budget"):
            self.fetch([first, self.node("htslib", self.URL())], create)
        create.assert_not_called()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="kq-source-test-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.mirror = self.base / "mirror"
        self.mirror.mkdir()
        self.output = self.base / "output"

    def test_internal_aliases_export_regular_files_with_stable_metadata(self):
        source = self.mirror / "archive.tar.gz"
        source.write_bytes(b"fixture")
        (self.mirror / "alias.tar.gz").symlink_to(source.name)
        self.assertEqual(prepare.export_sources(self.mirror, self.output), [
            {"path": name, "file": "sources/" + name}
            for name in ("alias.tar.gz", "archive.tar.gz")
        ])
        for name in ("alias.tar.gz", "archive.tar.gz"):
            output = self.output / "sources" / name
            self.assertFalse(output.is_symlink())
            self.assertEqual(output.read_bytes(), b"fixture")
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o644)

    def test_source_aliases_count_toward_both_byte_and_entry_budgets(self):
        source = self.mirror / "archive.tar.gz"
        source.write_bytes(b"1234")
        (self.mirror / "alias.tar.gz").symlink_to(source.name)
        for name, maximum in (("MAX_SOURCE_BYTES", 7), ("MAX_SOURCES", 1)):
            with self.subTest(budget=name), patch.object(prepare, name, maximum):
                with self.assertRaisesRegex(RuntimeError, "Source budget exceeded"):
                    prepare.export_sources(self.mirror, self.output)

    def test_missing_empty_escaping_symlink_and_special_sources_fail_closed(self):
        with self.assertRaisesRegex(RuntimeError, "real source mirror"):
            prepare.export_sources(self.base / "missing", self.output)
        with self.assertRaisesRegex(RuntimeError, "Empty native source mirror"):
            prepare.export_sources(self.mirror, self.output)
        outside = self.base / "outside"
        outside.write_bytes(b"private")
        source = self.mirror / "source"
        source.symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, "escapes"):
            prepare.export_sources(self.mirror, self.output)
        source.unlink()
        source.symlink_to(self.base, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "directory symlink"):
            prepare.export_sources(self.mirror, self.output)
        source.unlink()
        os.mkfifo(source)
        with self.assertRaisesRegex(RuntimeError, "not a file"):
            prepare.export_sources(self.mirror, self.output)
        source.unlink()
        alias = self.base / "mirror-alias"
        alias.symlink_to(self.mirror, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "real source mirror"):
            prepare.export_sources(alias, self.output)


if __name__ == "__main__":
    unittest.main()

"""CI-only probe regressions; subprocesses and readiness notifications are fake."""

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import signal
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location(
    "legacy_probe", Path(__file__).with_name("legacy-probe.py"),
)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)

MARKER = (
    r"\Aci-legacy-find:result=(ok|nonzero|spawn|timeout|output-limit) "
    r"reason=(none|store-permission|repo-init|config-permission|"
    r"cache-permission|permission-other|other) "
    r"json=(empty-array|array|non-array|invalid|unavailable)\n\Z"
)
SECRET = "private-spec-token-and-path"


class UnprintableError(OSError):
    def __str__(self):
        raise AssertionError("Exception text must not be read")

    def __repr__(self):
        raise AssertionError("Exception representation must not be read")


class FakeSelector:
    def __init__(self):
        self.keys = {}
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def register(self, stream, events, name):
        self.keys[stream.fd] = SimpleNamespace(
            fd=stream.fd, fileobj=stream, data=name,
        )

    def unregister(self, stream):
        del self.keys[stream.fd]

    def get_map(self):
        return self.keys

    def select(self, timeout):
        return [(key, probe.selectors.EVENT_READ) for key in self.keys.values()]


class LegacyProbeTests(unittest.TestCase):
    @contextlib.contextmanager
    def process_fixture(self, stdout=b"[]", stderr=b"", exit_code=0, clock=None):
        streams = {1: bytearray(stdout), 2: bytearray(stderr)}
        process = Mock(
            pid=12345,
            stdout=SimpleNamespace(fd=1, close=Mock()),
            stderr=SimpleNamespace(fd=2, close=Mock()),
        )
        process.wait.return_value = exit_code
        selector = FakeSelector()
        reads = []

        def read(fd, size):
            reads.append((fd, size))
            chunk = bytes(streams[fd][:size])
            del streams[fd][:size]
            return chunk

        with contextlib.ExitStack() as stack:
            spawn = stack.enter_context(patch.object(probe.subprocess, "Popen", return_value=process))
            stack.enter_context(patch.object(probe.selectors, "DefaultSelector", return_value=selector))
            reader = stack.enter_context(patch.object(probe.os, "read", side_effect=read))
            kill = stack.enter_context(patch.object(probe.os, "killpg"))
            stack.enter_context(patch.object(
                probe.time, "monotonic", side_effect=clock, return_value=0,
            ))
            yield SimpleNamespace(
                process=process, spawn=spawn, selector=selector, reader=reader,
                kill=kill, reads=reads,
            )

    def assert_marker(self, line):
        self.assertRegex(line, MARKER)
        self.assertNotIn(SECRET, line)

    def test_json_shapes_and_single_inherited_context_call(self):
        for raw, shape in (
            (b"[]", "empty-array"),
            (b'[{"name":"private-spec-token-and-path"}]', "array"),
            (b"{}", "non-array"),
            (SECRET.encode(), "invalid"),
            (b"\xff", "invalid"),
        ):
            with self.subTest(shape=shape, raw=raw), self.process_fixture(stdout=raw) as state:
                line = probe.probe("/configured/spack")
                self.assertEqual(line, probe.marker("ok", shape=shape))
                self.assert_marker(line)
                state.spawn.assert_called_once_with(
                    ["/configured/spack", "find", "--json"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, start_new_session=True,
                )
                state.process.wait.assert_called_once_with(timeout=15)
                state.kill.assert_not_called()
                self.assertTrue(state.selector.closed)
                state.process.stdout.close.assert_called_once()
                state.process.stderr.close.assert_called_once()

    def test_failure_classification_is_fixed_and_location_specific(self):
        for error, reason in (
            ("Permission denied: '/opt/spack/opt/spack/.spack-db'", "store-permission"),
            ("Permission denied: '/opt/spack/opt'", "store-permission"),
            ("Read-only file system: '/opt/spack/opt/spack'", "store-permission"),
            ("cannot create lock '/opt/spack/opt/spack/.spack-db/lock': "
             "file does not exist and location is not writable", "store-permission"),
            ("Permission denied: '/opt/spack/etc/spack/config.yaml'", "config-permission"),
            ("Permission denied: '/home/kq/.spack/config.yaml'", "config-permission"),
            ("Permission denied: '/home/kq/.spack/abc/cache/index'", "cache-permission"),
            ("Permission denied: '/unrelated/file'", "permission-other"),
            ("Permission denied: '/opt/spack/optional/file'", "permission-other"),
            ("warning: /opt/spack/opt/spack\nPermission denied: '/unrelated'", "permission-other"),
            ("NoRepoConfiguredError", "repo-init"),
            ("Error constructing repository: warning only", "other"),
            ("unclassified", "other"),
        ):
            with self.subTest(reason=reason, error=error):
                with self.process_fixture(stderr=f"{error}\n{SECRET}".encode(), exit_code=1):
                    line = probe.probe("/configured/spack")
                self.assertEqual(line, probe.marker("nonzero", reason, "empty-array"))
                self.assert_marker(line)

    def test_both_streams_allow_exact_limit(self):
        with self.process_fixture(
            stdout=b"[]" + b" " * (probe.STREAM_LIMIT - 2),
            stderr=b"x" * probe.STREAM_LIMIT,
        ) as state:
            self.assertEqual(probe.probe("/spack"), probe.marker("ok", shape="empty-array"))
            self.assertTrue(all(0 < size <= 4096 for _, size in state.reads))
            self.assertEqual({fd for fd, _ in state.reads}, {1, 2})
            state.kill.assert_not_called()

    def test_either_stream_over_limit_kills_group_and_reaps(self):
        for stream in ("stdout", "stderr"):
            with self.subTest(stream=stream), self.process_fixture(
                **{stream: b"x" * (probe.STREAM_LIMIT + 1)},
            ) as state:
                line = probe.probe("/spack")
                self.assertEqual(line, probe.marker("output-limit", "other"))
                self.assert_marker(line)
                state.kill.assert_called_once_with(12345, signal.SIGKILL)
                state.process.wait.assert_called_once_with(timeout=probe.REAP_TIMEOUT_SECONDS)
                state.process.stdout.close.assert_called_once()
                state.process.stderr.close.assert_called_once()

    def test_deadline_while_pipes_open_kills_and_reaps(self):
        with self.process_fixture(clock=[0, 15]) as state:
            self.assertEqual(probe.probe("/spack"), probe.marker("timeout", "other"))
            state.reader.assert_not_called()
            state.kill.assert_called_once_with(12345, signal.SIGKILL)
            state.process.wait.assert_called_once_with(timeout=probe.REAP_TIMEOUT_SECONDS)

    def test_wait_after_pipe_eof_has_remaining_deadline(self):
        with self.process_fixture(stdout=b"", clock=[0, 1, 2]) as state:
            state.process.wait.side_effect = [subprocess.TimeoutExpired("secret", 13), 0]
            self.assertEqual(probe.probe("/spack"), probe.marker("timeout", "other"))
            self.assertEqual(state.process.wait.call_args_list[0].kwargs, {"timeout": 13})
            state.kill.assert_called_once_with(12345, signal.SIGKILL)
            self.assertEqual(state.process.wait.call_count, 2)

    def test_spawn_and_read_errors_never_format_exceptions(self):
        with patch.object(probe.subprocess, "Popen", side_effect=UnprintableError()):
            self.assertEqual(probe.probe("/spack"), probe.marker("spawn", "other"))
        with self.process_fixture() as state:
            state.reader.side_effect = UnprintableError()
            self.assertEqual(probe.probe("/spack"), probe.marker("nonzero", "other"))
            state.kill.assert_called_once_with(12345, signal.SIGKILL)
            state.process.wait.assert_called_once_with(timeout=probe.REAP_TIMEOUT_SECONDS)

    def test_already_exited_group_still_reaps(self):
        with self.process_fixture(clock=[0, 15]) as state:
            state.kill.side_effect = ProcessLookupError()
            self.assertEqual(probe.probe("/spack"), probe.marker("timeout", "other"))
            state.process.wait.assert_called_once_with(timeout=probe.REAP_TIMEOUT_SECONDS)

    def test_cleanup_timeout_preserves_fixed_diagnostic(self):
        with self.process_fixture(clock=[0, 15]) as state:
            state.process.wait.side_effect = subprocess.TimeoutExpired(SECRET, 2)
            self.assertEqual(probe.probe("/spack"), probe.marker("timeout", "other"))
            state.process.wait.assert_called_once_with(timeout=probe.REAP_TIMEOUT_SECONDS)
            state.process.stdout.close.assert_called_once()
            state.process.stderr.close.assert_called_once()

    def test_main_is_ci_uid_guarded_and_status_write_is_nonfatal(self):
        with patch.dict(os.environ, {"KQ_PR_TEST": "1", "AGENT_SPACK_PATH": "/chosen/spack"}):
            with patch.object(probe.os, "getuid", return_value=1000):
                for fails in (False, True):
                    with self.subTest(write_fails=fails):
                        line = probe.marker("spawn", "other")
                        with patch.object(probe, "probe", return_value=line) as run:
                            with patch.object(
                                probe, "write_status",
                                side_effect=UnprintableError() if fails else None,
                            ) as write:
                                stdout, stderr = io.StringIO(), io.StringIO()
                                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                                    self.assertIsNone(probe.main())
                                run.assert_called_once_with("/chosen/spack")
                                write.assert_called_once_with(line)
                                self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")
        for ci, uid in (("0", 1000), ("1", 0)):
            with patch.dict(os.environ, {"KQ_PR_TEST": ci}):
                with patch.object(probe.os, "getuid", return_value=uid):
                    with patch.object(probe, "probe") as run, patch.object(probe, "write_status") as write:
                        probe.main()
                        run.assert_not_called()
                        write.assert_not_called()

    def test_status_file_contains_only_latest_fixed_line_and_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "status"
            with patch.object(probe, "STATUS_PATH", str(path)):
                probe.write_status(probe.marker("nonzero", "store-permission"))
                line = probe.marker("ok", shape="empty-array")
                probe.write_status(line)
                self.assertEqual(path.read_text(), line)
                self.assert_marker(path.read_text())
                path.unlink()
                target = Path(directory) / "target"
                target.write_text(SECRET)
                path.symlink_to(target)
                with self.assertRaises(OSError):
                    probe.write_status(line)
                self.assertEqual(target.read_text(), SECRET)

    def test_agent_hook_order_and_nonfatal_invocation(self):
        script = Path(__file__).with_name("agent.sh").read_text()
        invocation = "python3 -I -B /workspace/deploy/pr-test/spack-managed/legacy-probe.py"
        self.assertIn(invocation, script)
        self.assertLess(script.index("source /etc/kuintessence/managed/runtime.env"), script.index(invocation))
        self.assertLess(script.index('source "${KQ_AGENT_ENV_FILE}"'), script.index(invocation))
        self.assertLess(script.index('source "/var/lib/kuintessence/agent/${AGENT_ID}/agent.env"'), script.index(invocation))
        self.assertLess(script.index("cd /workspace/packages/agent"), script.index(invocation))
        self.assertIn("timeout --signal=TERM --kill-after=2s 20s", script)
        self.assertIn(") >/dev/null 2>&1 || :", script)
        self.assertLess(script.index(invocation), script.index("exec /usr/local/bin/kq-start-agent"))


if __name__ == "__main__":
    unittest.main()

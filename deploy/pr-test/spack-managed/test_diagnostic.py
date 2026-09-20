"""CI-only tracing contract tests; never invoke main or a Spack worker."""

import io
import resource
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch

import diagnostic


PHASES = (
    "source-audit", "configuration", "solve", "tree", "installed",
    "native-setup", "native-ground", "native-result",
)
MARKER = (
    r"\Aci-worker-phase:(source-audit|configuration|solve|tree|installed|"
    r"native-setup|native-ground|native-result) "
    r"event=(start|returned) rss-kib=([0-9]{1,12}|unavailable)\Z"
)


class UnprintableError(RuntimeError):
    def __str__(self):
        raise AssertionError("Worker exceptions must not be formatted")

    def __repr__(self):
        raise AssertionError("Worker exceptions must not be represented")


class TracedCallTests(unittest.TestCase):
    def setUp(self):
        self.fd = 987
        self.writes = []
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()
        self.start_patch(patch("sys.stdout", self.stdout))
        self.start_patch(patch("sys.stderr", self.stderr))
        self.rss = self.start_patch(
            patch.object(
                diagnostic.resource,
                "getrusage",
                return_value=SimpleNamespace(ru_maxrss=12345),
            )
        )
        self.write = self.start_patch(
            patch.object(diagnostic.os, "write", side_effect=self.capture_write)
        )

    def start_patch(self, patcher):
        self.addCleanup(patcher.stop)
        return patcher.start()

    def capture_write(self, fd, data):
        self.assertEqual(fd, self.fd)
        self.assertIsInstance(data, bytes)
        data.decode("ascii")
        self.writes.append((fd, data))
        return len(data)

    def reset_observations(self):
        self.writes.clear()
        self.write.reset_mock()
        self.rss.reset_mock()

    def assert_markers(self, phase, expected):
        self.assertEqual(len(self.writes), len(expected))
        for (fd, data), (event, rss) in zip(self.writes, expected):
            self.assertEqual(fd, self.fd)
            # Permit a line terminator, but no extra whitespace or injected lines.
            marker = data[:-1] if data.endswith(b"\n") else data
            text = marker.decode("ascii")
            self.assertRegex(text, MARKER)
            self.assertEqual(
                text,
                "ci-worker-phase:{} event={} rss-kib={}".format(phase, event, rss),
            )
        self.assertEqual(
            self.rss.call_args_list,
            [call(resource.RUSAGE_SELF)] * len(expected),
        )
        self.assertEqual(self.stdout.getvalue(), "")
        self.assertEqual(self.stderr.getvalue(), "")

    def test_forwards_argument_identity_and_returns_original_object(self):
        positional = (object(), ["private-argument"])
        keyword_values = {"option": object(), "settings": {"private": object()}}
        result = object()
        received = []
        self.rss.side_effect = [
            SimpleNamespace(ru_maxrss=1024),
            SimpleNamespace(ru_maxrss=2048),
        ]

        def function(*args, **kwargs):
            self.assert_markers("solve", [("start", 1024)])
            received.append((args, kwargs))
            return result

        wrapper = diagnostic.traced_call(function, "solve", self.fd)
        self.assertTrue(callable(wrapper))
        self.assertEqual(received, [])
        self.write.assert_not_called()
        self.rss.assert_not_called()
        self.assertIs(wrapper(*positional, **keyword_values), result)
        self.assertEqual(len(received), 1)
        args, kwargs = received[0]
        self.assertEqual(len(args), len(positional))
        for actual, original in zip(args, positional):
            self.assertIs(actual, original)
        self.assertEqual(set(kwargs), set(keyword_values))
        for name, original in keyword_values.items():
            self.assertIs(kwargs[name], original)
        self.assert_markers("solve", [("start", 1024), ("returned", 2048)])

    def test_all_legal_phases_emit_only_fixed_markers(self):
        for phase in PHASES:
            with self.subTest(phase=phase):
                self.reset_observations()
                result = object()
                function = Mock(return_value=result)
                wrapper = diagnostic.traced_call(function, phase, self.fd)
                self.assertIs(wrapper(), result)
                function.assert_called_once_with()
                self.assert_markers(phase, [("start", 12345), ("returned", 12345)])

    def test_wrapper_can_be_called_more_than_once(self):
        first_argument, second_argument = object(), object()
        first_result, second_result = object(), object()
        function = Mock(side_effect=[first_result, second_result])
        wrapper = diagnostic.traced_call(function, "tree", self.fd)
        self.assertIs(wrapper(first_argument), first_result)
        self.assertIs(wrapper(second_argument), second_result)
        self.assertEqual(function.call_count, 2)
        self.assertIs(function.call_args_list[0].args[0], first_argument)
        self.assertIs(function.call_args_list[1].args[0], second_argument)
        self.assert_markers(
            "tree",
            [
                ("start", 12345), ("returned", 12345),
                ("start", 12345), ("returned", 12345),
            ],
        )

    def test_preserves_exception_identity_without_returned_marker_or_leaks(self):
        secret = "private-error-token-must-not-be-emitted"
        errors = (
            RuntimeError(secret),
            OSError(secret),
            SystemExit(secret),
            KeyboardInterrupt(secret),
            UnprintableError(secret),
        )
        for error in errors:
            with self.subTest(kind=type(error).__name__):
                self.reset_observations()
                argument = object()
                function = Mock(side_effect=error)
                wrapper = diagnostic.traced_call(function, "installed", self.fd)
                with self.assertRaises(type(error)) as caught:
                    wrapper(argument, option=argument)
                self.assertIs(caught.exception, error)
                function.assert_called_once_with(argument, option=argument)
                self.assert_markers("installed", [("start", 12345)])
                self.assertNotIn(secret.encode("ascii"), b"".join(
                    data for _, data in self.writes
                ))

    def test_invalid_phases_are_rejected_before_call_or_output(self):
        invalid = (
            "", "audit", "install", "verify", "load", "SOLVE",
            " solve", "solve ", "../solve", "tree\x00",
            "source-audit\nci-worker-phase:installed",
            "solve\revent=returned", "solve event=returned",
        )
        for phase in invalid:
            with self.subTest(phase=phase):
                self.reset_observations()
                function = Mock()
                with self.assertRaises(ValueError):
                    diagnostic.traced_call(function, phase, self.fd)
                function.assert_not_called()
                self.write.assert_not_called()
                self.rss.assert_not_called()
                self.assertEqual(self.stdout.getvalue(), "")
                self.assertEqual(self.stderr.getvalue(), "")

    def test_rss_accepts_one_to_twelve_digit_integer_boundaries(self):
        for value in (0, 1, 9, 12345, 999_999_999_999):
            with self.subTest(rss=value):
                self.reset_observations()
                self.rss.return_value = SimpleNamespace(ru_maxrss=value)
                function = Mock(return_value=None)
                wrapper = diagnostic.traced_call(function, "configuration", self.fd)
                self.assertIsNone(wrapper())
                function.assert_called_once_with()
                self.assert_markers(
                    "configuration", [("start", value), ("returned", value)]
                )

    def test_out_of_range_rss_is_unavailable_without_changing_result(self):
        for value in (-1, -10**12, 10**12, 10**30):
            with self.subTest(rss=value):
                self.reset_observations()
                self.rss.return_value = SimpleNamespace(ru_maxrss=value)
                result = object()
                function = Mock(return_value=result)
                wrapper = diagnostic.traced_call(function, "source-audit", self.fd)
                self.assertIs(wrapper(), result)
                function.assert_called_once_with()
                self.assert_markers(
                    "source-audit",
                    [("start", "unavailable"), ("returned", "unavailable")],
                )

    def test_non_int_rss_is_unavailable_without_coercion(self):
        class IntegerSubclass(int):
            pass

        cases = (
            ("true", True),
            ("false", False),
            ("integral-float", 42.0),
            ("fractional-float", 42.5),
            ("nan", float("nan")),
            ("infinity", float("inf")),
            ("negative-infinity", float("-inf")),
            ("numeric-string", "42"),
            ("numeric-bytes", b"42"),
            ("none", None),
            ("int-subclass", IntegerSubclass(42)),
            ("opaque-object", object()),
            ("unprintable-object", UnprintableError("private-rss-value")),
        )
        for label, value in cases:
            with self.subTest(kind=label):
                self.reset_observations()
                self.rss.return_value = SimpleNamespace(ru_maxrss=value)
                result = object()
                function = Mock(return_value=result)
                wrapper = diagnostic.traced_call(function, "native-result", self.fd)
                self.assertIs(wrapper(), result)
                function.assert_called_once_with()
                self.assert_markers(
                    "native-result",
                    [("start", "unavailable"), ("returned", "unavailable")],
                )

    def test_rss_oserror_is_unavailable_for_either_marker(self):
        for failing_event in ("start", "returned", "both"):
            with self.subTest(event=failing_event):
                self.reset_observations()
                readings = []
                expected = []
                for event in ("start", "returned"):
                    fails = failing_event in (event, "both")
                    readings.append(
                        OSError("private-rss-error-must-not-be-emitted")
                        if fails else SimpleNamespace(ru_maxrss=42)
                    )
                    expected.append((event, "unavailable" if fails else 42))
                self.rss.side_effect = readings
                result = object()
                function = Mock(return_value=result)
                wrapper = diagnostic.traced_call(function, "tree", self.fd)
                self.assertIs(wrapper(), result)
                function.assert_called_once_with()
                self.assert_markers("tree", expected)

    def test_rss_oserror_does_not_mask_original_worker_exception(self):
        error = UnprintableError("private-worker-error-must-not-be-emitted")
        self.rss.side_effect = OSError("private-rss-error-must-not-be-emitted")
        function = Mock(side_effect=error)
        wrapper = diagnostic.traced_call(function, "installed", self.fd)
        with self.assertRaises(UnprintableError) as caught:
            wrapper()
        self.assertIs(caught.exception, error)
        function.assert_called_once_with()
        self.assert_markers("installed", [("start", "unavailable")])

    def test_marker_write_failure_preserves_result_and_exception(self):
        self.write.side_effect = OSError("private-pipe-error-must-not-be-emitted")
        result = object()
        function = Mock(return_value=result)
        self.assertIs(diagnostic.traced_call(function, "solve", self.fd)(), result)
        function.assert_called_once_with()
        self.assertEqual(self.write.call_count, 2)
        self.write.reset_mock()
        error = UnprintableError("private-worker-error-must-not-be-emitted")
        function = Mock(side_effect=error)
        with self.assertRaises(UnprintableError) as caught:
            diagnostic.traced_call(function, "solve", self.fd)()
        self.assertIs(caught.exception, error)
        function.assert_called_once_with()
        self.assertEqual(self.write.call_count, 1)
        self.assertEqual(self.stdout.getvalue(), "")
        self.assertEqual(self.stderr.getvalue(), "")


if __name__ == "__main__":
    unittest.main()

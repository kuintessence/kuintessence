"""CI-only tracing contract tests; never invoke main or a Spack worker."""

from collections.abc import Sequence
import contextlib
import copy
import io
import resource
import sys
from types import ModuleType, SimpleNamespace
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
SOLVER_MARKER = (
    r"\A(?:ci-compiler-candidates:accepted=[0-9]{1,5} rejected=[0-9]{1,5} "
    r"gcc=(?:accepted|rejected|absent)|"
    r"ci-compiler-probe:(?:verbose|libc) result=(?:present|missing)|"
    r"ci-solver-error:kind=(?:external-condition|external-selection|os-not-buildable|compiler-external|other) "
    r"package=(?:gcc|gmake|glibc|hello|other) "
    r"attribute=(?:namespace|version|platform|os|target|variant|flags|other) "
    r"variant=(?:languages|build_system|other)|"
    r"ci-target-check:stage=(?:candidates|model) present=(?:true|false|unavailable) "
    r"matches=(?:true|false|unavailable)|"
    r"ci-target-model:reason=(?:ok|shape|limit|read) "
    r"at=(?:model|length|item|symbol-type|symbol-name|attribute-arity|attribute-name|"
    r"node-type|node-name|node-arity|node-id|node-package|value|complete) "
    r"container=(?:list|tuple|sequence|iterator|text|other|unavailable) "
    r"size=(?:[0-9]{1,5}|over-limit|unavailable) scanned=[0-9]{1,5} "
    r"attributes=[0-9]{1,5} targets=[0-9]{1,5} gmake=[0-9]{1,5} "
    r"kind=(?:function|string|number|other|unavailable) arity=(?:[0-9]|many|unavailable)|"
    r"ci-target-error:mode=(?:exact|range) matches=(?:true|false|unavailable)|"
    r"ci-solved-lock:status=(?:ok|limit|unavailable) "
    r"solved=(?:[0-9]{1,2}|over-limit|unavailable) "
    r"expected=(?:[0-9]{1,2}|over-limit|unavailable) root-hash=(?:true|false|unavailable)|"
    r"ci-solved-node:package=(?:hello|gcc|gmake|glibc|compiler-wrapper|gcc-runtime|"
    r"samtools|htslib|zlib|ncurses|bzip2|xz|pkgconf|pkg-config|diffutils|libiconv|python|perl|other) "
    r"match=(?:unique|missing|ambiguous) hash=(?:true|false|unavailable) "
    r"version=(?:true|false|unavailable) namespace=(?:true|false|unavailable) "
    r"arch-profile=(?:true|false|unavailable) arch-lock=(?:true|false|unavailable) "
    r"target-profile=(?:true|false|unavailable) target-lock=(?:true|false|unavailable) "
    r"parameters=(?:true|false|unavailable) external=(?:true|false|unavailable) "
    r"package-hash=(?:true|false|unavailable) dependencies=(?:true|false|unavailable)|"
    r"ci-compiler-execution:(?:missing-file|permission|readonly|missing-library|linker|"
    r"no-space|unsupported-option|other))\Z"
)


@contextlib.contextmanager
def replace_attribute(owner, name, replacement):
    original = getattr(owner, name)
    setattr(owner, name, replacement)
    try:
        yield original
    finally:
        setattr(owner, name, original)


class UnprintableError(RuntimeError):
    def __str__(self):
        raise AssertionError("Worker exceptions must not be formatted")

    def __repr__(self):
        raise AssertionError("Worker exceptions must not be represented")


SYMBOL_TYPE = SimpleNamespace(Function=object(), String=object(), Number=object())


class FakeSymbol:
    """Reject property access that would be invalid for a clingo Symbol type."""

    def __init__(self, kind, value, arguments=()):
        self.type = kind
        self.value = value
        self._arguments = arguments

    @property
    def name(self):
        if self.type != SYMBOL_TYPE.Function:
            raise RuntimeError("Not a function")
        return self.value

    @property
    def arguments(self):
        if self.type != SYMBOL_TYPE.Function:
            raise RuntimeError("Not a function")
        return self._arguments

    @property
    def string(self):
        if self.type != SYMBOL_TYPE.String:
            raise RuntimeError("Not a string")
        return self.value

    def __str__(self):
        raise AssertionError("Symbols must not be formatted")

    def __repr__(self):
        raise AssertionError("Symbols must not be represented")


def target_symbol(package, target, index=0):
    return FakeSymbol(SYMBOL_TYPE.Function, "attr", (
        FakeSymbol(SYMBOL_TYPE.String, "node_target"),
        FakeSymbol(SYMBOL_TYPE.Function, "node", (
            FakeSymbol(SYMBOL_TYPE.Number, index),
            FakeSymbol(SYMBOL_TYPE.String, package),
        )),
        FakeSymbol(SYMBOL_TYPE.String, target),
    ))


class SymbolSequence(Sequence):
    """Non-list sequence with observable length and indexed reads."""

    def __init__(self, values):
        self.length = Mock(side_effect=lambda: len(values))
        self.read = Mock(side_effect=values.__getitem__)

    def __len__(self):
        return self.length()

    def __getitem__(self, index):
        return self.read(index)


class SolvedSpec:
    def __init__(self, name, digest):
        self._hash = digest
        self.data = {
            "name": name, "version": "1.0", "namespace": "private_namespace",
            "arch": {"platform": "linux", "platform_os": "privateos",
                     "target": {"name": "privatecpu"}},
            "parameters": {"cflags": (), "build_system": "generic"},
            "package_hash": "private-package-hash", "dependencies": [],
        }
        self.nodes = [self]
        self.traverse = Mock(side_effect=lambda: iter(self.nodes))
        self.to_node_dict = Mock(return_value=self.data)
        self.dag_hash = Mock(side_effect=AssertionError("Do not reconstruct hashes"))

    def __str__(self):
        raise AssertionError("Do not format native specs")

    def __repr__(self):
        raise AssertionError("Do not represent native specs")


class DiagnosticTestCase(unittest.TestCase):
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


class TracedCallTests(DiagnosticTestCase):
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


class SolverDiagnosticTests(DiagnosticTestCase):
    def assert_diagnostics(self, expected):
        lines = []
        for _, data in self.writes:
            self.assertTrue(data.endswith(b"\n"))
            lines.append(data[:-1].decode("ascii"))
        self.assertEqual(lines, expected)
        for line in lines:
            self.assertRegex(line, SOLVER_MARKER)
            if line.startswith("ci-target-model:"):
                fields = dict(item.split("=") for item in line.split(":", 1)[1].split())
                for key in ("size", "scanned", "attributes", "targets", "gmake"):
                    if fields[key] not in ("over-limit", "unavailable"):
                        self.assertLessEqual(int(fields[key]), 65536)
            if line.startswith("ci-solved-lock:"):
                fields = dict(item.split("=") for item in line.split(":", 1)[1].split())
                for key in ("solved", "expected"):
                    if fields[key] not in ("over-limit", "unavailable"):
                        self.assertLessEqual(int(fields[key]), 64)
        self.assertEqual(self.stdout.getvalue(), "")
        self.assertEqual(self.stderr.getvalue(), "")
        self.rss.assert_not_called()

    def assert_model_diagnostics(
        self, *, reason, at, container="sequence", size=1, scanned=0,
        attributes=0, targets=0, gmake=0, kind="unavailable", arity="unavailable",
        present="unavailable", matches="unavailable",
    ):
        self.assert_diagnostics([
            f"ci-target-check:stage=model present={present} matches={matches}",
            f"ci-target-model:reason={reason} at={at} container={container}"
            f" size={size} scanned={scanned} attributes={attributes}"
            f" targets={targets} gmake={gmake} kind={kind} arity={arity}",
        ])

    def test_profile_target_uses_only_solve_profile_without_mutating_inputs(self):
        profile = {"target": "linux-privateos-privatecpu", "private": object()}
        snapshot = dict(profile)
        self.assertEqual(diagnostic.solve_target((object(), object(), profile), {}), "privatecpu")
        self.assertEqual(diagnostic.solve_target((), {"profile": profile}), "privatecpu")
        self.assertEqual(profile, snapshot)
        for value in (None, {}, {"target": None}, {"target": object()},
                      {"target": "privatecpu"}, {"target": "linux--privatecpu"},
                      {"target": "linux-os-cpu-extra"}):
            self.assertIsNone(diagnostic.solve_target((), {"profile": value}))
        self.assertIsNone(diagnostic.solve_target((), {}))
        self.assertIsNone(diagnostic.solve_target((None, None, profile), {"profile": None}))
        self.assert_diagnostics([])

    def test_target_defaults_observed_only_after_original_return(self):
        for values, expected, present, matches in (
            ([(0, "privatecpu"), (100, "othercpu")], "privatecpu", "true", "true"),
            ([(0, "othercpu")], "privatecpu", "true", "false"),
            ([], "privatecpu", "false", "unavailable"),
            ([(0, "privatecpu")], None, "true", "unavailable"),
            (None, "privatecpu", "unavailable", "unavailable"),
            ([(0, object())], "privatecpu", "unavailable", "unavailable"),
            ([(0, "privatecpu"), ("bad", "othercpu")],
             "privatecpu", "unavailable", "unavailable"),
        ):
            self.reset_observations()
            owner, result, specs = SimpleNamespace(), object(), object()

            def original(actual_owner, *args, **kwargs):
                self.assertIs(actual_owner, owner)
                self.write.assert_not_called()
                actual_owner.default_targets = values
                return result

            function = Mock(side_effect=original)
            wrapper = diagnostic.diagnosed_target_defaults(function, expected, self.fd)
            self.assertIs(wrapper(owner, specs, option=specs), result)
            function.assert_called_once_with(owner, specs, option=specs)
            self.assertIs(owner.default_targets, values)
            self.assert_diagnostics([
                f"ci-target-check:stage=candidates present={present} matches={matches}",
            ])
        self.reset_observations()
        for error in (UnprintableError("private"), SystemExit("private"), KeyboardInterrupt()):
            function = Mock(side_effect=error)
            with self.assertRaises(type(error)) as caught:
                diagnostic.diagnosed_target_defaults(function, "privatecpu", self.fd)(owner)
            self.assertIs(caught.exception, error)
            function.assert_called_once_with(owner)
        self.assert_diagnostics([])

    def test_model_observation_handles_symbol_types_and_all_gmake_nodes(self):
        match = target_symbol("gmake", "privatecpu")
        mismatch = target_symbol("gmake", "othercpu", index=1)
        ignored = [
            FakeSymbol(SYMBOL_TYPE.Number, 42),
            FakeSymbol(SYMBOL_TYPE.String, "private\n/path"),
            FakeSymbol(SYMBOL_TYPE.Function, "private"),
            target_symbol("gcc", "othercpu"),
        ]
        for model, expected, present, matches in (
            ([*ignored, match], "privatecpu", "true", "true"),
            ([match, target_symbol("gmake", "privatecpu", index=1)],
             "privatecpu", "true", "true"),
            ([mismatch], "privatecpu", "true", "false"),
            ([match, mismatch], "privatecpu", "true", "false"),
            (ignored, "privatecpu", "false", "unavailable"),
            ([], "privatecpu", "false", "unavailable"),
            ([match], None, "true", "unavailable"),
            (None, "privatecpu", "unavailable", "unavailable"),
            ([match, object()], "privatecpu", "unavailable", "unavailable"),
            ([FakeSymbol(SYMBOL_TYPE.Function, "attr", (
                FakeSymbol(SYMBOL_TYPE.String, "node_target"),
                FakeSymbol(SYMBOL_TYPE.String, "gmake"),
                FakeSymbol(SYMBOL_TYPE.String, "privatecpu"),
            ))], "privatecpu", "unavailable", "unavailable"),
            ([FakeSymbol(SYMBOL_TYPE.Function, "attr", (
                FakeSymbol(SYMBOL_TYPE.String, "node_target"),
                match.arguments[1], FakeSymbol(SYMBOL_TYPE.Number, 1),
            ))], "privatecpu", "unavailable", "unavailable"),
        ):
            self.reset_observations()
            owner, errors, result = SimpleNamespace(model=model), [], object()
            snapshot = tuple(model) if type(model) is list else None
            function = Mock(return_value=result)
            wrapper = diagnostic.diagnosed_message(
                function, self.fd,
                lambda handler: diagnostic.emit_target_check(
                    "model", lambda: diagnostic.model_target_names(handler, SYMBOL_TYPE),
                    expected, self.fd,
                ),
            )
            self.assertIs(wrapper(owner, errors), result)
            function.assert_called_once_with(owner, errors)
            self.assertIs(owner.model, model)
            if snapshot is not None:
                self.assertEqual(tuple(model), snapshot)
            self.assert_diagnostics([
                f"ci-target-check:stage=model present={present} matches={matches}",
            ])

    def test_unreadable_targets_are_unavailable_without_consuming_iterators(self):
        symbol = target_symbol("gmake", "privatecpu")
        model = iter([symbol])
        candidates = iter([(0, "privatecpu")])
        for stage, reader in (
            ("candidates", lambda: diagnostic.default_target_names(
                SimpleNamespace(default_targets=candidates))),
            ("model", lambda: diagnostic.model_target_names(
                SimpleNamespace(model=model), SYMBOL_TYPE)),
            ("candidates", lambda: diagnostic.default_target_names(object())),
            ("model", lambda: diagnostic.model_target_names(object(), SYMBOL_TYPE)),
        ):
            self.reset_observations()
            diagnostic.emit_target_check(stage, reader, "privatecpu", self.fd)
            self.assert_diagnostics([
                f"ci-target-check:stage={stage} present=unavailable matches=unavailable",
            ])
        self.assertIs(next(model), symbol)
        self.assertEqual(next(candidates), (0, "privatecpu"))

    def test_model_limit_accepts_boundary_and_rejects_oversize_before_traversal(self):
        self.assertEqual(diagnostic.TARGET_MODEL_LIMIT, 65536)
        ignored = FakeSymbol(SYMBOL_TYPE.String, "private")
        match = target_symbol("gmake", "privatecpu")
        model = [ignored] * (diagnostic.TARGET_MODEL_LIMIT - 1) + [match]
        diagnostic.emit_target_check(
            "model", lambda: diagnostic.model_target_names(
                SimpleNamespace(model=model), SYMBOL_TYPE),
            "privatecpu", self.fd,
        )
        self.assert_diagnostics([
            "ci-target-check:stage=model present=true matches=true",
        ])
        self.reset_observations()
        access = Mock(side_effect=AssertionError("Oversize models must not be traversed"))

        class UnreadableSymbol:
            @property
            def type(self):
                return access()

        model = [UnreadableSymbol()] * (diagnostic.TARGET_MODEL_LIMIT + 1)
        diagnostic.emit_target_check(
            "model", lambda: diagnostic.model_target_names(
                SimpleNamespace(model=model), SYMBOL_TYPE),
            "privatecpu", self.fd,
        )
        access.assert_not_called()
        self.assert_diagnostics([
            "ci-target-check:stage=model present=unavailable matches=unavailable",
        ])

    def test_non_list_symbol_sequence_normal_empty_and_limit(self):
        match = target_symbol("gmake", "privatecpu")
        mismatch = target_symbol("gmake", "othercpu")
        for values, present, matches in (
            ((match,), "true", "true"),
            ((match, mismatch), "true", "false"),
            ((), "false", "unavailable"),
            ((match,) * diagnostic.TARGET_MODEL_LIMIT, "true", "true"),
            ((match,) * (diagnostic.TARGET_MODEL_LIMIT + 1), "unavailable", "unavailable"),
        ):
            self.reset_observations()
            model = SymbolSequence(values)
            owner, errors, result = SimpleNamespace(model=model), [], object()
            function = Mock(return_value=result)
            wrapper = diagnostic.diagnosed_message(
                function, self.fd,
                lambda handler: diagnostic.emit_target_model(
                    handler, SYMBOL_TYPE, "privatecpu", self.fd),
            )
            self.assertIs(wrapper(owner, errors), result)
            function.assert_called_once_with(owner, errors)
            self.assertIs(owner.model, model)
            model.length.assert_called_once_with()
            if len(values) > diagnostic.TARGET_MODEL_LIMIT:
                model.read.assert_not_called()
            else:
                self.assertEqual(model.read.call_count, len(values))
                if values:
                    self.assertEqual(model.read.call_args_list[0], call(0))
                    self.assertEqual(model.read.call_args_list[-1], call(len(values) - 1))
            over_limit = len(values) > diagnostic.TARGET_MODEL_LIMIT
            count = 0 if over_limit else len(values)
            self.assert_model_diagnostics(
                reason="limit" if over_limit else "ok",
                at="length" if over_limit else "complete",
                size="over-limit" if over_limit else len(values),
                scanned=count, attributes=count, targets=count, gmake=count,
                present=present, matches=matches,
            )

    def test_model_details_container_rejection_never_reads_or_consumes_it(self):
        symbol = target_symbol("gmake", "privatecpu")
        iterator = iter((symbol,))
        for model, container in (
            ("private\n/path", "text"), (b"private", "text"), (bytearray(), "text"),
            (iterator, "iterator"), ({"private": symbol}, "other"), (None, "other"),
        ):
            self.reset_observations()
            diagnostic.emit_target_model(SimpleNamespace(model=model), SYMBOL_TYPE, "privatecpu", self.fd)
            self.assert_model_diagnostics(
                reason="shape", at="model", container=container, size="unavailable",
            )
        self.assertIs(next(iterator), symbol)
        for model, container in (([symbol], "list"), ((symbol,), "tuple")):
            self.reset_observations()
            diagnostic.emit_target_model(SimpleNamespace(model=model), SYMBOL_TYPE, "privatecpu", self.fd)
            self.assert_model_diagnostics(
                reason="ok", at="complete", container=container, scanned=1,
                attributes=1, targets=1, gmake=1, present="true", matches="true",
            )
        self.reset_observations()
        model = SymbolSequence(())
        model.length.side_effect = None
        model.length.return_value = 10 ** 9
        diagnostic.emit_target_model(SimpleNamespace(model=model), SYMBOL_TYPE, "privatecpu", self.fd)
        model.read.assert_not_called()
        self.assert_model_diagnostics(reason="limit", at="length", size="over-limit")

    def test_model_details_distinguish_attribute_node_and_value_shapes(self):
        symbol = target_symbol("gmake", "privatecpu")
        attribute, node, target = symbol.arguments
        node_id, package = node.arguments
        cases = (
            ((attribute, node), "attribute-arity", "string", 2, 0),
            ((attribute, node, target, target), "attribute-arity", "string", 4, 0),
            ((attribute,) * 10, "attribute-arity", "string", "many", 0),
            ((attribute, package, target), "node-type", "string", "unavailable", 0),
            ((attribute, FakeSymbol(SYMBOL_TYPE.Function, "private\n/path"), target),
             "node-name", "function", "unavailable", 0),
            ((attribute, FakeSymbol(SYMBOL_TYPE.Function, "node", (node_id,)), target),
             "node-arity", "function", 1, 0),
            ((attribute, FakeSymbol(SYMBOL_TYPE.Function, "node", (package, package)), target),
             "node-id", "string", "unavailable", 0),
            ((attribute, FakeSymbol(SYMBOL_TYPE.Function, "node", (node_id, node_id)), target),
             "node-package", "number", "unavailable", 0),
            ((attribute, node, node_id), "value", "number", "unavailable", 1),
        )
        for args, location, kind, arity, gmake in cases:
            self.reset_observations()
            model = SymbolSequence((FakeSymbol(SYMBOL_TYPE.Function, "attr", args),))
            diagnostic.emit_target_model(SimpleNamespace(model=model), SYMBOL_TYPE, "privatecpu", self.fd)
            model.length.assert_called_once_with()
            model.read.assert_called_once_with(0)
            self.assert_model_diagnostics(
                reason="shape", at=location, scanned=1, attributes=1, targets=1,
                gmake=gmake, kind=kind, arity=arity,
            )

    def test_model_details_count_irrelevant_attributes_without_reporting_their_values(self):
        symbol = target_symbol("gmake", "privatecpu")
        model = SymbolSequence((
            FakeSymbol(SYMBOL_TYPE.Number, 42),
            FakeSymbol(SYMBOL_TYPE.Function, "private\n/path"),
            FakeSymbol(SYMBOL_TYPE.Function, "attr", (
                FakeSymbol(SYMBOL_TYPE.String, "private\n/path"),)),
            target_symbol("gcc", "private-other-target"),
            symbol,
        ))
        diagnostic.emit_target_model(SimpleNamespace(model=model), SYMBOL_TYPE, "privatecpu", self.fd)
        self.assertEqual(model.read.call_args_list, [call(index) for index in range(5)])
        self.assert_model_diagnostics(
            reason="ok", at="complete", size=5, scanned=5, attributes=3, targets=2,
            gmake=1, present="true", matches="true",
        )

    def test_model_details_read_failures_identify_location_without_exception_text(self):
        class UnreadableSymbol(FakeSymbol):
            def __init__(self, original, field):
                super().__init__(original.type, original.value, original._arguments)
                self.field = field

            def __getattribute__(self, name):
                if name == object.__getattribute__(self, "field"):
                    raise UnprintableError("private\nci-injected:/path")
                return super().__getattribute__(name)

        original = target_symbol("gmake", "privatecpu")
        attribute, node, value = original.arguments
        node_id, package = node.arguments
        cases = [
            (UnreadableSymbol(original, "type"), "symbol-type", "unavailable", 0, 0, 0),
            (UnreadableSymbol(original, "name"), "symbol-name", "function", 0, 0, 0),
            (UnreadableSymbol(original, "arguments"), "attribute-arity", "function", 1, 0, 0),
        ]
        for args, location, kind, gmake in (
            ((UnreadableSymbol(attribute, "string"), node, value), "attribute-name", "string", 0),
            ((attribute, UnreadableSymbol(node, "arguments"), value), "node-arity", "function", 0),
            ((attribute, FakeSymbol(SYMBOL_TYPE.Function, "node", (
                UnreadableSymbol(node_id, "type"), package)), value), "node-id", "unavailable", 0),
            ((attribute, FakeSymbol(SYMBOL_TYPE.Function, "node", (
                node_id, UnreadableSymbol(package, "string"))), value), "node-package", "string", 0),
            ((attribute, node, UnreadableSymbol(value, "string")), "value", "string", 1),
        ):
            cases.append((
                FakeSymbol(SYMBOL_TYPE.Function, "attr", args), location, kind, 1,
                0 if location == "attribute-name" else 1, gmake,
            ))
        for symbol, location, kind, attributes, targets, gmake in cases:
            self.reset_observations()
            diagnostic.emit_target_model(
                SimpleNamespace(model=SymbolSequence((symbol,))), SYMBOL_TYPE, "privatecpu", self.fd,
            )
            self.assert_model_diagnostics(
                reason="read", at=location, scanned=1, attributes=attributes,
                targets=targets, gmake=gmake, kind=kind,
            )

    def test_model_details_partial_reads_and_missing_model_preserve_formatter_behavior(self):
        class UnreadableHandler:
            @property
            def model(self):
                raise UnprintableError("private model")

        for location in ("model", "length", "item"):
            for failure in (None, UnprintableError("private formatter")):
                self.reset_observations()
                model = SymbolSequence((target_symbol("gmake", "privatecpu"), object()))
                if location == "length":
                    model.length.side_effect = UnprintableError("private length")
                elif location == "item":
                    model.read.side_effect = [
                        target_symbol("gmake", "privatecpu"), UnprintableError("private item"),
                    ]
                owner = UnreadableHandler() if location == "model" else SimpleNamespace(model=model)
                result, errors = object(), []
                function = Mock(return_value=result, side_effect=failure)
                wrapper = diagnostic.diagnosed_message(
                    function, self.fd,
                    lambda handler: diagnostic.emit_target_model(
                        handler, SYMBOL_TYPE, "privatecpu", self.fd),
                )
                if failure is None:
                    self.assertIs(wrapper(owner, errors), result)
                else:
                    with self.assertRaises(UnprintableError) as caught:
                        wrapper(owner, errors)
                    self.assertIs(caught.exception, failure)
                function.assert_called_once_with(owner, errors)
                count = 1 if location == "item" else 0
                self.assert_model_diagnostics(
                    reason="read", at=location,
                    container="unavailable" if location == "model" else "sequence",
                    size=2 if location == "item" else "unavailable",
                    scanned=count, attributes=count, targets=count, gmake=count,
                )
                if location != "item":
                    model.read.assert_not_called()
                else:
                    self.assertEqual(model.read.call_args_list, [call(0), call(1)])

    def test_symbol_sequence_read_errors_are_unavailable_and_preserve_formatter(self):
        match = target_symbol("gmake", "privatecpu")
        for location in ("length", "item"):
            for failure in (None, UnprintableError("private formatter")):
                self.reset_observations()
                model = SymbolSequence((match, match))
                if location == "length":
                    model.length.side_effect = UnprintableError("private length")
                else:
                    model.read.side_effect = [match, UnprintableError("private read")]
                owner, errors, result = SimpleNamespace(model=model), [], object()
                function = Mock(return_value=result, side_effect=failure)
                wrapper = diagnostic.diagnosed_message(
                    function, self.fd,
                    lambda handler: diagnostic.emit_target_check(
                        "model", lambda: diagnostic.model_target_names(handler, SYMBOL_TYPE),
                        "privatecpu", self.fd,
                    ),
                )
                if failure is None:
                    self.assertIs(wrapper(owner, errors), result)
                else:
                    with self.assertRaises(UnprintableError) as caught:
                        wrapper(owner, errors)
                    self.assertIs(caught.exception, failure)
                function.assert_called_once_with(owner, errors)
                model.length.assert_called_once_with()
                if location == "length":
                    model.read.assert_not_called()
                else:
                    self.assertEqual(model.read.call_args_list, [call(0), call(1)])
                self.assert_diagnostics([
                    "ci-target-check:stage=model present=unavailable matches=unavailable",
                ])

    def test_model_rejects_text_bytes_and_sequence_iterators_before_reading(self):
        class IteratorSequence(SymbolSequence):
            def __iter__(self):
                return self

            def __next__(self):
                raise AssertionError("Diagnostic must not consume an iterator")

        sequence_iterator = IteratorSequence((target_symbol("gmake", "privatecpu"),))
        for model in ("", "private", b"", b"private", bytearray(), sequence_iterator):
            self.reset_observations()
            diagnostic.emit_target_check(
                "model", lambda: diagnostic.model_target_names(
                    SimpleNamespace(model=model), SYMBOL_TYPE),
                "privatecpu", self.fd,
            )
            self.assert_diagnostics([
                "ci-target-check:stage=model present=unavailable matches=unavailable",
            ])
        sequence_iterator.length.assert_not_called()
        sequence_iterator.read.assert_not_called()

    def test_target_closed_pipe_preserves_results_and_original_formatter_error(self):
        self.write.side_effect = BrokenPipeError("private pipe")
        owner = SimpleNamespace(default_targets=[(0, "privatecpu")], model=[])
        result, errors = object(), []
        function = Mock(return_value=result)
        self.assertIs(diagnostic.diagnosed_target_defaults(
            function, "privatecpu", self.fd,
        )(owner), result)
        function.assert_called_once_with(owner)
        for failure in (None, UnprintableError("private formatter")):
            function = Mock(return_value=result, side_effect=failure)
            wrapper = diagnostic.diagnosed_message(
                function, self.fd,
                lambda handler: diagnostic.emit_target_check(
                    "model", lambda: diagnostic.model_target_names(handler, SYMBOL_TYPE),
                    "privatecpu", self.fd,
                ),
            )
            if failure is None:
                self.assertIs(wrapper(owner, errors), result)
            else:
                with self.assertRaises(UnprintableError) as caught:
                    wrapper(owner, errors)
                self.assertIs(caught.exception, failure)
            function.assert_called_once_with(owner, errors)
        self.assertEqual(self.write.call_count, 3)
        self.assert_diagnostics([])

    def test_return_observer_forwards_identity_once_and_preserves_exceptions(self):
        argument, keyword, result = object(), object(), object()
        function, observer = Mock(return_value=result), Mock()
        wrapper = diagnostic.observed_return(function, observer)
        function.assert_not_called()
        observer.assert_not_called()
        self.assertIs(wrapper(argument, option=keyword), result)
        function.assert_called_once_with(argument, option=keyword)
        observer.assert_called_once_with(result)
        for error in (UnprintableError("secret"), SystemExit("secret"), KeyboardInterrupt()):
            with self.subTest(kind=type(error).__name__):
                function, observer = Mock(side_effect=error), Mock()
                with self.assertRaises(type(error)) as caught:
                    diagnostic.observed_return(function, observer)(argument, option=keyword)
                self.assertIs(caught.exception, error)
                function.assert_called_once_with(argument, option=keyword)
                observer.assert_not_called()
        observer = Mock(side_effect=UnprintableError("private-observer-failure"))
        self.assertIs(diagnostic.observed_return(Mock(return_value=result), observer)(), result)
        self.assert_diagnostics([])

    def test_candidates_have_bounded_counts_and_fixed_gcc_states(self):
        gcc = SimpleNamespace(name="gcc")
        private = SimpleNamespace(name="private\nci-injected:/private/path")
        for accepted, rejected, state in (
            ([], [], "absent"),
            ([private], [private], "absent"),
            ([gcc], [], "accepted"),
            ([], [gcc], "rejected"),
            ([gcc], [gcc], "accepted"),
            ([gcc] * 99999, [], "accepted"),
            ([], [gcc] * 99999, "rejected"),
        ):
            with self.subTest(accepted=len(accepted), rejected=len(rejected), state=state):
                self.reset_observations()
                result = (accepted, rejected)
                function = Mock(return_value=result)
                wrapper = diagnostic.observed_return(
                    function, lambda value: diagnostic.emit_compiler_candidates(value, self.fd),
                )
                self.assertIs(wrapper(configuration=private), result)
                function.assert_called_once_with(configuration=private)
                self.assert_diagnostics([
                    f"ci-compiler-candidates:accepted={len(accepted)}"
                    f" rejected={len(rejected)} gcc={state}",
                ])
        for result in (([gcc] * 100000, []), ([], [gcc] * 100000), object()):
            self.reset_observations()
            wrapper = diagnostic.observed_return(
                Mock(return_value=result),
                lambda value: diagnostic.emit_compiler_candidates(value, self.fd),
            )
            self.assertIs(wrapper(), result)
            self.assert_diagnostics([])

    def test_probe_observes_optional_return_without_formatting_or_extra_calls(self):
        for kind in ("verbose", "libc"):
            for result, state in (
                (None, "missing"), ("", "present"),
                ("private compiler output\n/path", "present"),
                (UnprintableError("private libc spec"), "present"),
            ):
                with self.subTest(kind=kind, state=state):
                    self.reset_observations()
                    function = Mock(return_value=result)
                    wrapper = diagnostic.observed_return(
                        function,
                        lambda value: diagnostic.emit_compiler_probe(kind, value, self.fd),
                    )
                    self.assertIs(wrapper(), result)
                    function.assert_called_once_with()
                    self.assert_diagnostics([f"ci-compiler-probe:{kind} result={state}"])
        self.reset_observations()
        diagnostic.emit_compiler_probe("verbose\nprivate", object(), self.fd)
        self.assert_diagnostics([])

    @staticmethod
    def external_error(attributes):
        return (
            "Attempted to build package {0} which is not buildable and does not have a satisfying external\n"
            "        " + attributes
            + " is an external constraint for {0} which was not satisfied"
        )

    def test_structured_errors_match_official_templates_and_argument_positions(self):
        cases = [
            (self.external_error("attr('{1}', '{2}')"),
             ["gcc", "node", "gcc"], "external-condition", "gcc", "other", "other"),
            (self.external_error("attr('{1}', '{2}', '{3}', '{4}')"),
             ["gcc", "variant_value", "gcc", "languages", "private-value"],
             "external-condition", "gcc", "variant", "languages"),
            (self.external_error("attr('{1}', '{2}', '{3}', '{4}', '{5}')"),
             ["gmake", "node_flag", "gmake", "private-flag", "private-value", "/private"],
             "external-condition", "gmake", "flags", "other"),
            ("Attempted to build package {0} which is not buildable and does not have a satisfying external\n"
             "        'Spec({0} {1}={2})' is an external constraint for {0} which was not satisfied\n"
             "        'Spec({0} {1}={3})' required",
             ["gcc", "build_system", "private-old", "private-new", "startcauses", "/private", "1"],
             "external-condition", "gcc", "variant", "build_system"),
            ("Cannot select '{0} os={1}' (operating system '{1}' is not buildable)",
             ["hello", "private-os"], "os-not-buildable", "hello", "os", "other"),
            ("Only external, or concrete, compilers are allowed for the {0} language",
             ["gcc"], "compiler-external", "other", "other", "other"),
        ]
        for name, attribute in (
            ("namespace", "namespace"), ("version", "version"),
            ("node_version_satisfies", "version"), ("node_platform", "platform"),
            ("node_os", "os"), ("node_target", "target"), ("node_target_satisfies", "target"),
        ):
            cases.append((
                self.external_error("attr('{1}', '{2}', '{3}')"),
                ["glibc", name, "glibc", "private-value"],
                "external-condition", "glibc", attribute, "other",
            ))
        for name in ("node_target", "node_target_satisfies"):
            cases.append((
                self.external_error("attr('{1}', '{2}', '{3}')"),
                ["gmake", name, "gmake", "private-value"],
                "external-condition", "gmake", "target", "other",
            ))
        for template, args, kind, package, attribute, variant in cases:
            for escaped in (False, True):
                with self.subTest(kind=kind, attribute=attribute, variant=variant, escaped=escaped):
                    self.reset_observations()
                    errors = [(0, template.replace("\n", "\\n") if escaped else template, args)]
                    owner, result = object(), object()
                    function = Mock(return_value=result)
                    self.assertIs(
                        diagnostic.diagnosed_message(function, self.fd)(owner, errors=errors),
                        result,
                    )
                    function.assert_called_once_with(owner, errors)
                    self.assertIs(function.call_args.args[1], errors)
                    expected = [
                        f"ci-solver-error:kind={kind} package={package}"
                        f" attribute={attribute} variant={variant}",
                    ]
                    if package == "gmake" and attribute == "target":
                        mode = "exact" if args[1] == "node_target" else "range"
                        expected.append(f"ci-target-error:mode={mode} matches=unavailable")
                    self.assert_diagnostics(expected)

    def test_target_error_uses_only_literal_equality_for_exact_and_range_modes(self):
        template = self.external_error("attr('{1}', '{2}', '{3}')")
        for attribute, mode in (("node_target", "exact"), ("node_target_satisfies", "range")):
            for value, expected, matches in (
                ("privatecpu", "privatecpu", "true"),
                ("othercpu", "privatecpu", "false"),
                ("privatecpu:", "privatecpu", "false"),
                ("private\n/path", "privatecpu", "false"),
                ("privatecpu", None, "unavailable"),
                (UnprintableError("private value"), "privatecpu", "unavailable"),
                ("privatecpu", UnprintableError("private expected"), "unavailable"),
            ):
                self.reset_observations()
                args = ["gmake", attribute, "gmake", value]
                errors = [(0, template, args)]
                result, owner = object(), object()
                function = Mock(return_value=result)
                wrapper = diagnostic.diagnosed_message(function, self.fd, expected_target=expected)
                self.assertIs(wrapper(owner, errors), result)
                function.assert_called_once_with(owner, errors)
                self.assertIs(function.call_args.args[1], errors)
                self.assertIs(errors[0][2], args)
                self.assert_diagnostics([
                    "ci-solver-error:kind=external-condition package=gmake attribute=target variant=other",
                    f"ci-target-error:mode={mode} matches={matches}",
                ])

    def test_target_error_rejects_nonexact_templates_positions_and_shapes(self):
        class StringSubclass(str):
            pass

        template = self.external_error("attr('{1}', '{2}', '{3}')")
        args = ["gmake", "node_target", "gmake", "privatecpu"]
        iterator = iter(args)
        for error in (
            object(), (0, template),
            (0, template + "\nprivate", args),
            (0, "private", args),
            (0, "x" * 4097, args),
            (0, StringSubclass(template), args),
            (0, UnprintableError("private template"), args),
            (0, self.external_error("attr('{1}', '{2}')"), args),
            (0, template, args[:-1]),
            (0, template, [*args, "private"]),
            (0, template, ["gcc", "node_target", "gmake", "privatecpu"]),
            (0, template, ["gmake", "node_target", "gcc", "privatecpu"]),
            (0, template, ["gmake", "node_os", "gmake", "privatecpu"]),
            (0, template, [StringSubclass("gmake"), "node_target", "gmake", "privatecpu"]),
            (0, template, ["gmake", object(), "gmake", "privatecpu"]),
            (0, template, iterator),
        ):
            diagnostic.emit_target_error(error, "privatecpu", self.fd)
        self.assertEqual(next(iterator), args[0])
        self.assert_diagnostics([])

    def test_target_error_keeps_64_limit_and_does_not_consume_error_iterators(self):
        template = self.external_error("attr('{1}', '{2}', '{3}')")
        errors = [(0, template, ["gmake", "node_target", "gmake", "privatecpu"])] * 65
        owner, result = object(), object()
        function = Mock(return_value=result)
        wrapper = diagnostic.diagnosed_message(function, self.fd, expected_target="privatecpu")
        self.assertIs(wrapper(owner, errors), result)
        function.assert_called_once_with(owner, errors)
        self.assertEqual(len(errors), 65)
        self.assert_diagnostics([
            "ci-solver-error:kind=external-condition package=gmake attribute=target variant=other",
            "ci-target-error:mode=exact matches=true",
        ] * 64)
        self.reset_observations()
        function.reset_mock()
        iterator = iter(errors)
        self.assertIs(wrapper(owner, iterator), result)
        function.assert_called_once_with(owner, iterator)
        self.assertIs(next(iterator), errors[0])
        self.assert_diagnostics([])

    def test_target_error_remains_available_when_model_exceeds_limit(self):
        model = SymbolSequence(())
        model.length.side_effect = None
        model.length.return_value = diagnostic.TARGET_MODEL_LIMIT + 1
        owner = SimpleNamespace(model=model)
        template = self.external_error("attr('{1}', '{2}', '{3}')")
        errors = [(0, template, ["gmake", "node_target", "gmake", "privatecpu"])]
        result = object()
        function = Mock(return_value=result)
        wrapper = diagnostic.diagnosed_message(
            function, self.fd,
            lambda handler: diagnostic.emit_target_model(handler, SYMBOL_TYPE, "privatecpu", self.fd),
            expected_target="privatecpu",
        )
        self.assertIs(wrapper(owner, errors), result)
        function.assert_called_once_with(owner, errors)
        model.length.assert_called_once_with()
        model.read.assert_not_called()
        self.assert_diagnostics([
            "ci-target-check:stage=model present=unavailable matches=unavailable",
            "ci-target-model:reason=limit at=length container=sequence size=over-limit"
            " scanned=0 attributes=0 targets=0 gmake=0 kind=unavailable arity=unavailable",
            "ci-solver-error:kind=external-condition package=gmake attribute=target variant=other",
            "ci-target-error:mode=exact matches=true",
        ])

    def test_new_target_markers_pipe_failures_preserve_original_results_and_exceptions(self):
        self.write.side_effect = BrokenPipeError("private pipe")
        template = self.external_error("attr('{1}', '{2}', '{3}')")
        errors = [(0, template, ["gmake", "node_target", "gmake", "privatecpu"])]
        for failure in (None, UnprintableError("private formatter"), SystemExit("private")):
            self.write.reset_mock()
            model = SymbolSequence((target_symbol("gmake", "privatecpu"),))
            owner, result = SimpleNamespace(model=model), object()
            function = Mock(return_value=result, side_effect=failure)
            wrapper = diagnostic.diagnosed_message(
                function, self.fd,
                lambda handler: diagnostic.emit_target_model(
                    handler, SYMBOL_TYPE, "privatecpu", self.fd),
                expected_target="privatecpu",
            )
            if failure is None:
                self.assertIs(wrapper(owner, errors), result)
            else:
                with self.assertRaises(type(failure)) as caught:
                    wrapper(owner, errors)
                self.assertIs(caught.exception, failure)
            function.assert_called_once_with(owner, errors)
            model.length.assert_called_once_with()
            model.read.assert_called_once_with(0)
            self.assertEqual(self.write.call_count, 4)
            self.assert_diagnostics([])

    def test_unknown_and_malformed_errors_never_emit_raw_values(self):
        secret = "private\nci-solver-error:kind=external-condition /secret -private-flag"
        template = self.external_error("attr('{1}', '{2}', '{3}', '{4}')")
        errors = [
            (0, template, [secret, "variant_value", secret, secret, secret]),
            (0, template, [secret, secret, secret, secret, secret]),
            (0, template, ["gcc", "variant_value"]),
            (0, template + secret, ["gcc", "variant_value", "gcc", "languages", secret]),
            (0, secret, ["gcc", secret]),
            (0, UnprintableError(secret), [secret]),
            (0, template, {"private": secret}),
            (0, template, [object(), object(), object(), object(), object()]),
            (0, "x" * 4097, []),
            object(),
        ]
        result, owner = object(), object()
        function = Mock(return_value=result)
        self.assertIs(diagnostic.diagnosed_message(function, self.fd)(owner, errors), result)
        function.assert_called_once_with(owner, errors)
        other = "ci-solver-error:kind=other package=other attribute=other variant=other"
        self.assert_diagnostics([
            "ci-solver-error:kind=external-condition package=other attribute=variant variant=other",
            "ci-solver-error:kind=external-condition package=other attribute=other variant=other",
            other, other, other, other, other,
            "ci-solver-error:kind=external-condition package=other attribute=other variant=other",
            other, other,
        ])

    def test_external_selection_requires_exact_official_template_and_one_argument(self):
        for suffix, attribute in (
            ("any configured external spec version", "version"),
            ("a unique configured external spec version", "version"),
            ("any configured external spec", "other"),
        ):
            template = "Attempted to use external for '{0}' which does not satisfy " + suffix
            for args, package in ((["gmake"], "gmake"), (["private\n/path"], "other")):
                self.reset_observations()
                errors = [(100, template, args)]
                result, owner = object(), object()
                function = Mock(return_value=result)
                self.assertIs(diagnostic.diagnosed_message(function, self.fd)(owner, errors), result)
                function.assert_called_once_with(owner, errors)
                self.assert_diagnostics([
                    f"ci-solver-error:kind=external-selection package={package}"
                    f" attribute={attribute} variant=other",
                ])
            for message, args in (
                (template + " private", ["gmake"]), (template, []),
                (template, ["gmake", "private"]), (template.format("gmake"), ["gmake"]),
            ):
                self.assertEqual(
                    diagnostic.solver_error_fields((100, message, args)),
                    ("other", "other", "other", "other"),
                )

    def test_error_limit_preserves_full_input_and_does_not_consume_iterators(self):
        errors = [(0, "private", [])] * 65
        function = Mock(return_value=object())
        wrapper = diagnostic.diagnosed_message(function, self.fd)
        owner = object()
        wrapper(owner, errors)
        self.assertIs(function.call_args.args[1], errors)
        self.assertEqual(len(errors), 65)
        self.assert_diagnostics([
            "ci-solver-error:kind=other package=other attribute=other variant=other",
        ] * 64)
        self.reset_observations()
        iterator = iter(errors)
        wrapper(owner, iterator)
        self.assertIs(function.call_args.args[1], iterator)
        self.assertIs(next(iterator), errors[0])
        self.assert_diagnostics([])

    def test_closed_pipe_preserves_helper_results_and_formatter_exception(self):
        self.write.side_effect = BrokenPipeError("private pipe")
        for emitter, result in (
            (diagnostic.emit_compiler_candidates, ([], [])),
            (lambda value, fd: diagnostic.emit_compiler_probe("verbose", value, fd), object()),
            (lambda value, fd: diagnostic.emit_compiler_probe("libc", value, fd), None),
        ):
            function = Mock(return_value=result)
            self.assertIs(diagnostic.observed_return(
                function, lambda value: emitter(value, self.fd),
            )(), result)
            function.assert_called_once_with()
        errors = [(0, "private", [])]
        result, owner = object(), object()
        self.assertIs(
            diagnostic.diagnosed_message(Mock(return_value=result), self.fd)(owner, errors),
            result,
        )
        error = UnprintableError("private original")
        function = Mock(side_effect=error)
        with self.assertRaises(UnprintableError) as caught:
            diagnostic.diagnosed_message(function, self.fd)(owner, errors)
        self.assertIs(caught.exception, error)
        function.assert_called_once_with(owner, errors)
        self.assert_diagnostics([])

    def test_execution_classification_is_scoped_and_preserves_caught_process_error(self):
        class ProcessError(UnprintableError):
            pass

        for message, category in (
            ("No such file or directory", "missing-file"),
            ("Permission denied", "permission"),
            ("Read-only file system", "readonly"),
            ("error while loading shared libraries: No such file or directory", "missing-library"),
            ("cannot find -lprivate; ld returned 1 exit status", "missing-library"),
            ("undefined reference to private", "linker"),
            ("No space left on device", "no-space"),
            ("unrecognized command-line option '-private'", "unsupported-option"),
            ("private unknown failure", "other"),
            (UnprintableError("private long message"), "other"),
        ):
            with self.subTest(category=category):
                self.reset_observations()
                error = ProcessError("private short message")
                error.long_message = message
                executable_call = Mock(side_effect=error)

                class Executable:
                    def __call__(self, *args, **kwargs):
                        return executable_call(self, *args, **kwargs)

                original = Executable.__call__
                executable = SimpleNamespace(Executable=Executable, ProcessError=ProcessError)
                command, argument, keyword, owner = Executable(), object(), object(), object()
                result = object()

                def compile_source(actual_owner, *, option):
                    self.assertIs(actual_owner, owner)
                    self.assertIs(option, keyword)
                    try:
                        command(argument, option=keyword)
                    except ProcessError as caught:
                        self.assertIs(caught, error)
                        return result
                    self.fail("Original ProcessError was swallowed")

                function = Mock(side_effect=compile_source)
                wrapper = diagnostic.diagnosed_compilation(
                    function, replace_attribute, executable, self.fd,
                )
                self.assertIs(Executable.__call__, original)
                self.assertIs(wrapper(owner, option=keyword), result)
                function.assert_called_once_with(owner, option=keyword)
                executable_call.assert_called_once_with(command, argument, option=keyword)
                self.assertIs(Executable.__call__, original)
                self.assert_diagnostics(["ci-compiler-execution:" + category])
                with self.assertRaises(ProcessError) as caught:
                    command()
                self.assertIs(caught.exception, error)
                self.assert_diagnostics(["ci-compiler-execution:" + category])

    def test_compilation_restores_call_on_success_and_uncaught_exceptions_with_closed_pipe(self):
        class ProcessError(UnprintableError):
            @property
            def long_message(self):
                raise AssertionError("No error formatting")

        executable_call = Mock()

        class Executable:
            def __call__(self, *args, **kwargs):
                return executable_call(self, *args, **kwargs)

        original = Executable.__call__
        command = Executable()
        executable = SimpleNamespace(Executable=Executable, ProcessError=ProcessError)
        wrapper = diagnostic.diagnosed_compilation(
            lambda *args, **kwargs: command(*args, **kwargs),
            replace_attribute, executable, self.fd,
        )
        result, argument = object(), object()
        executable_call.return_value = result
        self.assertIs(wrapper(argument, option=argument), result)
        executable_call.assert_called_once_with(command, argument, option=argument)
        self.assertIs(Executable.__call__, original)
        self.assert_diagnostics([])
        self.write.side_effect = BrokenPipeError("private pipe")
        process_error = ProcessError("private")
        # A separate error class exercises a real write failure after classification.
        class ReadableProcessError(ProcessError):
            long_message = "Permission denied: /private"

        readable_error = ReadableProcessError("private")
        for error in (
            process_error, readable_error, UnprintableError("private"),
            SystemExit("private"), KeyboardInterrupt(),
        ):
            executable_call.reset_mock()
            executable_call.side_effect = error
            with self.assertRaises(type(error)) as caught:
                wrapper(argument, option=argument)
            self.assertIs(caught.exception, error)
            executable_call.assert_called_once_with(command, argument, option=argument)
            self.assertIs(Executable.__call__, original)
        self.write.assert_called_once()
        self.assert_diagnostics([])

    def test_solver_installs_wrappers_only_during_solve_and_restores_on_error(self):
        modules = {name: ModuleType(name) for name in (
            "clingo", "spack", "spack.solver", "spack.solver.asp",
            "spack.compilers", "spack.compilers.libraries", "spack.util", "spack.util.executable",
        )}
        for name, module in modules.items():
            if "." in name:
                parent, child = name.rsplit(".", 1)
                setattr(modules[parent], child, module)
        asp = modules["spack.solver.asp"]
        libraries = modules["spack.compilers.libraries"]
        executable = modules["spack.util.executable"]

        class ProcessError(UnprintableError):
            long_message = "No such file or directory: /private"

        process_error = ProcessError("private")
        executable_call = Mock(side_effect=process_error)

        class Executable:
            def __call__(self, *args, **kwargs):
                return executable_call(self, *args, **kwargs)

        executable.Executable, executable.ProcessError = Executable, ProcessError
        verbose, libc = object(), object()
        probe_calls = []

        class Detector:
            def compiler_verbose_output(self):
                probe_calls.append("verbose")
                return verbose

            def default_libc(self):
                probe_calls.append("libc")
                return libc

            def _compile_dummy_c_source(self):
                probe_calls.append("compile")
                try:
                    Executable()()
                except ProcessError as caught:
                    if caught is not process_error:
                        raise AssertionError("Changed original exception")
                    return None

        libraries.CompilerPropertyDetector = Detector
        target_defaults = Mock(return_value=object())
        asp.SpackSolverSetup = type("Setup", (), {
            "setup": lambda self: None,
            "target_defaults": lambda self, specs: target_defaults(self, specs),
        })
        modules["clingo"].Control = type("Control", (), {"ground": lambda self: None})
        modules["clingo"].SymbolType = SYMBOL_TYPE
        asp.SpecBuilder = type("Builder", (), {"build_specs": lambda self: None})
        candidates = (set(), set())
        asp.possible_compilers = Mock(return_value=candidates)
        formatted = object()
        formatter = Mock(return_value=formatted)

        class ErrorHandler:
            def message(self, errors):
                return formatter(self, errors)

        asp.ErrorHandler = ErrorHandler
        owners = (
            (asp.SpackSolverSetup, "setup"), (modules["clingo"].Control, "ground"),
            (asp.SpecBuilder, "build_specs"), (asp, "possible_compilers"),
            (Detector, "compiler_verbose_output"), (Detector, "default_libc"),
            (Detector, "_compile_dummy_c_source"), (ErrorHandler, "message"),
            (asp.SpackSolverSetup, "target_defaults"),
        )
        originals = [(owner, name, getattr(owner, name)) for owner, name in owners]
        original_execute = Executable.__call__
        argument, result = object(), object()
        profile = {"target": "linux-privateos-privatecpu"}
        errors = [
            (10, "Only external, or concrete, compilers are allowed for the {0} language", ["c"]),
            (0, self.external_error("attr('{1}', '{2}', '{3}')"),
             ["gmake", "node_target", "gmake", "privatecpu"]),
        ]
        for failure in (None, UnprintableError("private solve failure")):
            with self.subTest(fails=failure is not None):
                self.reset_observations()
                probe_calls.clear()
                executable_call.reset_mock()
                formatter.reset_mock()
                target_defaults.reset_mock()
                originals[3][2].reset_mock()
                binder = Mock(return_value=result, side_effect=failure)

                def solve(value, *positional, option, **keywords):
                    self.assertIs(value, argument)
                    self.assertIs(option, argument)
                    if positional:
                        self.assertEqual(len(positional), 2)
                        self.assertIs(positional[0], argument)
                        self.assertIs(positional[1], profile)
                    else:
                        self.assertIs(keywords["profile"], profile)
                    for owner, name, original in originals:
                        self.assertIsNot(getattr(owner, name), original)
                    self.assertIs(Executable.__call__, original_execute)
                    setup = asp.SpackSolverSetup()
                    setup.default_targets = [(0, "privatecpu")]
                    self.assertIs(setup.target_defaults(argument), target_defaults.return_value)
                    target_defaults.assert_called_once_with(setup, argument)
                    self.assertIs(asp.possible_compilers(configuration=argument), candidates)
                    detector = Detector()
                    self.assertIs(detector.compiler_verbose_output(), verbose)
                    self.assertIs(detector.default_libc(), libc)
                    self.assertIsNone(detector._compile_dummy_c_source())
                    self.assertIs(Executable.__call__, original_execute)
                    handler = ErrorHandler()
                    handler.model = SymbolSequence((target_symbol("gmake", "privatecpu"),))
                    self.assertIs(handler.message(errors), formatted)
                    self.assertIsNot(worker.bind_native, binder)
                    return worker.bind_native(argument, argument, profile)

                function = Mock(side_effect=solve)
                worker = SimpleNamespace(
                    solve_lock=function, bind_native=binder, replace_attribute=replace_attribute,
                )
                with patch("builtins.__import__", side_effect=AssertionError("Premature import")):
                    wrapper = diagnostic.diagnosed_solver(worker, self.fd)
                self.write.assert_not_called()
                function.assert_not_called()
                with patch.dict(sys.modules, modules):
                    if failure is None:
                        self.assertIs(wrapper(argument, argument, profile, option=argument), result)
                    else:
                        with self.assertRaises(UnprintableError) as caught:
                            wrapper(argument, profile=profile, option=argument)
                        self.assertIs(caught.exception, failure)
                if failure is None:
                    function.assert_called_once_with(argument, argument, profile, option=argument)
                else:
                    function.assert_called_once_with(argument, profile=profile, option=argument)
                originals[3][2].assert_called_once_with(configuration=argument)
                self.assertEqual(probe_calls, ["verbose", "libc", "compile"])
                executable_call.assert_called_once()
                formatter.assert_called_once()
                self.assertIs(formatter.call_args.args[1], errors)
                for owner, name, original in originals:
                    self.assertIs(getattr(owner, name), original)
                self.assertIs(Executable.__call__, original_execute)
                binder.assert_called_once_with(argument, argument, profile)
                self.assertIs(worker.bind_native, binder)
                expected_markers = [
                    "ci-target-check:stage=candidates present=true matches=true",
                    "ci-compiler-candidates:accepted=0 rejected=0 gcc=absent",
                    "ci-compiler-probe:verbose result=present",
                    "ci-compiler-probe:libc result=present",
                    "ci-compiler-execution:missing-file",
                    "ci-target-check:stage=model present=true matches=true",
                    "ci-target-model:reason=ok at=complete container=sequence size=1"
                    " scanned=1 attributes=1 targets=1 gmake=1 kind=unavailable arity=unavailable",
                    "ci-solver-error:kind=compiler-external package=other attribute=other variant=other",
                    "ci-solver-error:kind=external-condition package=gmake attribute=target variant=other",
                    "ci-target-error:mode=exact matches=true",
                ]
                if failure is not None:
                    expected_markers.append(
                        "ci-solved-lock:status=unavailable solved=unavailable"
                        " expected=unavailable root-hash=unavailable"
                    )
                self.assert_diagnostics(expected_markers)

    @staticmethod
    def solved_fixture(names=("hello", "compiler-wrapper")):
        nodes = [SolvedSpec(name, "private-hash-" + str(index)) for index, name in enumerate(names)]
        root = nodes[0]
        root.nodes = nodes
        lock = {
            "roots": [{"hash": root._hash}],
            "concrete_specs": {node._hash: copy.deepcopy(node.data) for node in nodes},
        }
        for data in lock["concrete_specs"].values():
            data["parameters"]["cflags"] = []
        return root, lock, {"target": "linux-privateos-privatecpu"}

    @staticmethod
    def solved_node_marker(package, match="unique", **differences):
        fields = {key: "true" for key in (
            "hash", "version", "namespace", "arch-profile", "arch-lock",
            "target-profile", "target-lock", "parameters", "external", "package-hash", "dependencies",
        )}
        if match != "unique":
            for key in fields:
                if key not in ("arch-profile", "target-profile"):
                    fields[key] = "unavailable"
        fields.update(differences)
        return f"ci-solved-node:package={package} match={match} " + " ".join(
            f"{key}={value}" for key, value in fields.items()
        )

    def test_solved_known_packages_preserve_only_fixed_names(self):
        names = (
            "hello", "gcc", "gmake", "glibc", "compiler-wrapper", "gcc-runtime",
            "samtools", "htslib", "zlib", "ncurses", "bzip2", "xz", "pkgconf", "pkg-config",
            "diffutils", "libiconv", "python", "perl",
        )
        self.assertEqual(diagnostic.SOLVED_PACKAGES, set(names))
        root, lock, profile = self.solved_fixture(names)
        diagnostic.emit_solved_lock(root, lock, profile, self.fd)
        self.assert_diagnostics([
            f"ci-solved-lock:status=ok solved={len(names)} expected={len(names)} root-hash=true",
            *[self.solved_node_marker(name) for name in names],
        ])

    def test_solved_unknown_and_injected_package_names_remain_other(self):
        for name in (
            "private-package", "samtools-extra", "SAMTOOLS", " samtools", "samtools ",
            "samtools@1.19.2", "builtin.samtools", "/private/samtools", "pkg_config",
            "samtools\nci-solved-node:package=perl", "htslib\rpackage=zlib",
            "zlib\x00", "python;private-token", "\x1b[31mperl",
        ):
            with self.subTest(name=name):
                self.reset_observations()
                root, lock, profile = self.solved_fixture((name,))
                diagnostic.emit_solved_lock(root, lock, profile, self.fd)
                self.assert_diagnostics([
                    "ci-solved-lock:status=ok solved=1 expected=1 root-hash=true",
                    self.solved_node_marker("other"),
                ])
                self.assertNotRegex(self.solved_node_marker(name), SOLVER_MARKER)

    def test_bind_success_and_non_exception_failures_do_not_observe_native_inputs(self):
        argument, result = object(), object()
        with patch.object(diagnostic, "emit_solved_lock") as observer:
            function = Mock(return_value=result)
            self.assertIs(diagnostic.diagnosed_bind_native(function, self.fd)(
                argument, argument, argument), result)
            function.assert_called_once_with(argument, argument, argument)
            for error in (SystemExit("private"), KeyboardInterrupt()):
                function = Mock(side_effect=error)
                with self.assertRaises(type(error)) as caught:
                    diagnostic.diagnosed_bind_native(function, self.fd)(argument, argument, argument)
                self.assertIs(caught.exception, error)
            observer.assert_not_called()
        self.assert_diagnostics([])

    def test_bind_failure_reports_compiler_wrapper_target_drift_without_mutating_inputs(self):
        root, lock, profile = self.solved_fixture()
        child = root.nodes[1]
        root._hash = "private-different-root-hash"
        child._hash = "private-different-child-hash"
        child.data["arch"]["target"]["name"] = "private-other-target"
        snapshot = copy.deepcopy((lock, profile, [node.data for node in root.nodes]))
        error = UnprintableError("private native-root")
        function = Mock(side_effect=error)
        with self.assertRaises(UnprintableError) as caught:
            diagnostic.diagnosed_bind_native(function, self.fd)(root, lock, profile)
        self.assertIs(caught.exception, error)
        function.assert_called_once_with(root, lock, profile)
        root.traverse.assert_called_once_with()
        for node in root.nodes:
            node.to_node_dict.assert_called_once_with()
            node.dag_hash.assert_not_called()
        self.assertEqual((lock, profile, [node.data for node in root.nodes]), snapshot)
        self.assert_diagnostics([
            "ci-solved-lock:status=ok solved=2 expected=2 root-hash=false",
            self.solved_node_marker("hello", hash="false"),
            self.solved_node_marker("compiler-wrapper", **{
                "hash": "false", "arch-profile": "false", "arch-lock": "false",
                "target-profile": "false", "target-lock": "false",
            }),
        ])

    def test_solved_fixed_field_differences_and_tuple_list_normalization(self):
        for field, value, marker in (
            ("version", "private-version", "version"),
            ("namespace", "private\nnamespace", "namespace"),
            ("parameters", {"cflags": ["-private"], "build_system": "other"}, "parameters"),
            ("external", {"path": "/private/prefix"}, "external"),
            ("package_hash", "private-other-package-hash", "package-hash"),
            ("dependencies", [{"name": "private", "hash": "private",
                               "parameters": {"deptypes": ["build"], "virtuals": []}}], "dependencies"),
        ):
            self.reset_observations()
            root, lock, profile = self.solved_fixture(("hello",))
            root.data[field] = value
            diagnostic.emit_solved_lock(root, lock, profile, self.fd)
            self.assert_diagnostics([
                "ci-solved-lock:status=ok solved=1 expected=1 root-hash=true",
                self.solved_node_marker("hello", **{marker: "false"}),
            ])
        self.reset_observations()
        root, lock, profile = self.solved_fixture(("hello",))
        lock["concrete_specs"][root._hash]["arch"]["target"] = "privatecpu"
        diagnostic.emit_solved_lock(root, lock, profile, self.fd)
        self.assert_diagnostics([
            "ci-solved-lock:status=ok solved=1 expected=1 root-hash=true",
            self.solved_node_marker("hello"),
        ])

    def test_solved_matching_is_unique_by_name_and_never_guesses_duplicates(self):
        for side in ("solved", "lock", "missing"):
            self.reset_observations()
            root, lock, profile = self.solved_fixture(("hello",))
            if side == "solved":
                root.nodes.append(SolvedSpec("hello", "private-second"))
            elif side == "lock":
                lock["concrete_specs"]["private-second"] = copy.deepcopy(root.data)
            else:
                root.data["name"] = "private\nci-injected"
            diagnostic.emit_solved_lock(root, lock, profile, self.fd)
            solved, expected = len(root.nodes), len(lock["concrete_specs"])
            self.assert_diagnostics([
                f"ci-solved-lock:status=ok solved={solved} expected={expected} root-hash=true",
                *[self.solved_node_marker(
                    "other" if side == "missing" else "hello",
                    "missing" if side == "missing" else "ambiguous",
                ) for _ in root.nodes],
            ])

    def test_solved_limits_precede_serialization_and_allow_exactly_64_nodes(self):
        self.assertEqual(diagnostic.SOLVED_NODE_LIMIT, 64)
        root, lock, profile = self.solved_fixture(tuple("private" + str(i) for i in range(64)))
        diagnostic.emit_solved_lock(root, lock, profile, self.fd)
        self.assert_diagnostics([
            "ci-solved-lock:status=ok solved=64 expected=64 root-hash=true",
            *[self.solved_node_marker("other") for _ in root.nodes],
        ])
        self.reset_observations()
        root, lock, profile = self.solved_fixture(("hello",))
        yielded = []

        def oversized_traversal():
            for index in range(66):
                yielded.append(index)
                yield root

        root.traverse.side_effect = oversized_traversal
        diagnostic.emit_solved_lock(root, lock, profile, self.fd)
        self.assertEqual(len(yielded), 65)
        root.to_node_dict.assert_not_called()
        self.assert_diagnostics([
            "ci-solved-lock:status=limit solved=over-limit expected=1 root-hash=unavailable",
        ])
        self.reset_observations()
        root, lock, profile = self.solved_fixture(tuple("private" + str(i) for i in range(65)))
        diagnostic.emit_solved_lock(root, lock, profile, self.fd)
        root.traverse.assert_not_called()
        self.assert_diagnostics([
            "ci-solved-lock:status=limit solved=unavailable expected=over-limit root-hash=unavailable",
        ])

    def test_solved_metadata_budget_and_missing_hash_do_not_hide_architecture(self):
        root, lock, profile = self.solved_fixture(("hello",))
        root._hash = None
        root.data["parameters"] = {"private": [0] * 4097}
        diagnostic.emit_solved_lock(root, lock, profile, self.fd)
        root.dag_hash.assert_not_called()
        self.assert_diagnostics([
            "ci-solved-lock:status=ok solved=1 expected=1 root-hash=unavailable",
            self.solved_node_marker("hello", hash="unavailable", parameters="unavailable"),
        ])

    def test_bind_diagnostic_read_and_pipe_failures_preserve_original_exception(self):
        for failure in ("read", "pipe", "observer"):
            self.reset_observations()
            root, lock, profile = self.solved_fixture(("hello",))
            original_error = UnprintableError("private original error")
            function = Mock(side_effect=original_error)
            if failure == "read":
                root.to_node_dict.side_effect = UnprintableError("private serialized spec")
            with contextlib.ExitStack() as stack:
                if failure == "pipe":
                    stack.enter_context(patch.object(
                        diagnostic.os, "write", side_effect=BrokenPipeError("private pipe"),
                    ))
                elif failure == "observer":
                    stack.enter_context(patch.object(
                        diagnostic, "emit_solved_lock", side_effect=UnprintableError("private observer"),
                    ))
                with self.assertRaises(UnprintableError) as caught:
                    diagnostic.diagnosed_bind_native(function, self.fd)(root, lock, profile)
            self.assertIs(caught.exception, original_error)
            function.assert_called_once_with(root, lock, profile)
            self.assert_diagnostics([
                "ci-solved-lock:status=unavailable solved=1 expected=1 root-hash=unavailable",
            ] if failure == "read" else [])


if __name__ == "__main__":
    unittest.main()

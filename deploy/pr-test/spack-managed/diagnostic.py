"""CI failure diagnosis only; executes unchanged worker checks, never publishes."""
from collections.abc import Iterator, Sequence
import contextlib
import json
import os
from pathlib import Path
import resource
import sys


def traced_call(function, phase, fd):
    if phase not in {
        "source-audit", "configuration", "solve", "tree", "installed",
        "native-setup", "native-ground", "native-result",
    }:
        raise ValueError("Unsupported diagnostic phase")

    def emit(event):
        try:
            peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            rss = str(peak) if type(peak) is int and 0 <= peak < 10 ** 12 else "unavailable"
        except OSError:
            rss = "unavailable"
        try:
            os.write(fd, ("ci-worker-phase:" + phase + " event=" + event
                          + " rss-kib=" + rss + "\n").encode("ascii"))
        except OSError:
            # A closed diagnostic pipe must not replace the worker's result or error.
            return

    def traced(*args, **kwargs):
        emit("start")
        result = function(*args, **kwargs)
        emit("returned")
        return result

    return traced


def emit_diagnostic(fd, marker):
    try:
        os.write(fd, (marker + "\n").encode("ascii"))
    except OSError:
        # Diagnostics must not replace the original result or exception.
        pass


def observed_return(function, observer):
    def observed(*args, **kwargs):
        result = function(*args, **kwargs)
        try:
            observer(result)
        except Exception:
            # Inspection is best-effort; the original call is outside this handler.
            pass
        return result

    return observed


def emit_compiler_candidates(result, fd):
    accepted, rejected = result
    if not (0 <= len(accepted) <= 99999 and 0 <= len(rejected) <= 99999):
        return
    gcc = "absent"
    for candidates, state in ((rejected, "rejected"), (accepted, "accepted")):
        if any(type(spec.name) is str and spec.name == "gcc" for spec in candidates):
            gcc = state
    emit_diagnostic(fd, f"ci-compiler-candidates:accepted={len(accepted)}"
                    f" rejected={len(rejected)} gcc={gcc}")


def emit_compiler_probe(kind, result, fd):
    if kind not in ("verbose", "libc"):
        return
    state = "missing" if result is None else "present"
    emit_diagnostic(fd, f"ci-compiler-probe:{kind} result={state}")


def solve_target(args, kwargs):
    profile = kwargs.get("profile") if "profile" in kwargs else (
        args[2] if len(args) > 2 else None
    )
    if type(profile) is not dict or type(profile.get("target")) is not str:
        return None
    parts = profile["target"].split("-")
    return parts[2] if len(parts) == 3 and all(parts) else None


def default_target_names(setup):
    values = setup.default_targets
    if type(values) not in (list, tuple):
        raise ValueError("Unavailable target candidates")
    names = []
    for entry in values:
        if (type(entry) not in (list, tuple) or len(entry) != 2
                or type(entry[0]) is not int or type(entry[1]) is not str):
            raise ValueError("Unavailable target candidates")
        names.append(entry[1])
    return names


TARGET_MODEL_LIMIT = 65536


def model_symbol_kind(symbol, symbol_type, details, location):
    details.update(at=location, kind="unavailable", arity="unavailable")
    value = symbol.type
    if value == symbol_type.Function:
        kind = "function"
    elif value == symbol_type.String:
        kind = "string"
    elif value == symbol_type.Number:
        kind = "number"
    else:
        kind = "other"
    details["kind"] = kind
    return kind


def model_target_names(handler, symbol_type, details=None):
    if details is None:
        details = {}
    details.update(
        reason="read", at="model", container="unavailable", size="unavailable",
        scanned=0, attributes=0, targets=0, gmake=0, kind="unavailable", arity="unavailable",
    )

    def unavailable(location, reason="shape"):
        details.update(reason=reason, at=location)
        raise ValueError("Unavailable target model")

    model = handler.model
    if isinstance(model, (str, bytes, bytearray)):
        details["container"] = "text"
    elif isinstance(model, Iterator):
        details["container"] = "iterator"
    elif type(model) is list:
        details["container"] = "list"
    elif type(model) is tuple:
        details["container"] = "tuple"
    elif isinstance(model, Sequence):
        details["container"] = "sequence"
    else:
        details["container"] = "other"
    if details["container"] not in ("list", "tuple", "sequence"):
        unavailable("model")
    details["at"] = "length"
    size = len(model)
    details["size"] = size if size <= TARGET_MODEL_LIMIT else "over-limit"
    if size > TARGET_MODEL_LIMIT:
        unavailable("length", "limit")
    names = []
    for index in range(size):
        details.update(at="item", kind="unavailable", arity="unavailable")
        symbol = model[index]
        details["scanned"] += 1
        if model_symbol_kind(symbol, symbol_type, details, "symbol-type") != "function":
            continue
        details["at"] = "symbol-name"
        if symbol.name != "attr":
            continue
        details["attributes"] += 1
        details["at"] = "attribute-arity"
        args = symbol.arguments
        arity = len(args)
        details["arity"] = arity if arity <= 9 else "many"
        if not arity:
            continue
        details["at"] = "attribute-name"
        if model_symbol_kind(args[0], symbol_type, details, "attribute-name") != "string":
            continue
        if args[0].string != "node_target":
            continue
        details["targets"] += 1
        if arity != 3:
            details["arity"] = arity if arity <= 9 else "many"
            unavailable("attribute-arity")
        details["at"] = "node-type"
        node = args[1]
        if model_symbol_kind(node, symbol_type, details, "node-type") != "function":
            unavailable("node-type")
        details["at"] = "node-name"
        if node.name != "node":
            unavailable("node-name")
        details["at"] = "node-arity"
        node_args = node.arguments
        node_arity = len(node_args)
        details["arity"] = node_arity if node_arity <= 9 else "many"
        if node_arity != 2:
            unavailable("node-arity")
        details["at"] = "node-id"
        if model_symbol_kind(node_args[0], symbol_type, details, "node-id") != "number":
            unavailable("node-id")
        details["at"] = "node-package"
        if model_symbol_kind(node_args[1], symbol_type, details, "node-package") != "string":
            unavailable("node-package")
        if node_args[1].string != "gmake":
            continue
        details["gmake"] += 1
        details["at"] = "value"
        target = args[2]
        if model_symbol_kind(target, symbol_type, details, "value") != "string":
            unavailable("value")
        names.append(target.string)
    details.update(reason="ok", at="complete", kind="unavailable", arity="unavailable")
    return names


def emit_target_model(handler, symbol_type, expected, fd):
    details = {}
    emit_target_check(
        "model", lambda: model_target_names(handler, symbol_type, details), expected, fd,
    )
    emit_diagnostic(
        fd, "ci-target-model:"
        + " ".join(f"{key}={details[key]}" for key in (
            "reason", "at", "container", "size", "scanned", "attributes",
            "targets", "gmake", "kind", "arity",
        )),
    )


def emit_target_check(stage, read_names, expected, fd):
    if stage not in ("candidates", "model"):
        return
    present = matches = "unavailable"
    try:
        names = read_names()
        present = "true" if names else "false"
        if names and type(expected) is str:
            matched = expected in names if stage == "candidates" else all(
                name == expected for name in names
            )
            matches = "true" if matched else "false"
    except Exception:
        pass
    emit_diagnostic(fd, f"ci-target-check:stage={stage} present={present} matches={matches}")


def diagnosed_target_defaults(function, expected, fd):
    def target_defaults(self, *args, **kwargs):
        result = function(self, *args, **kwargs)
        emit_target_check("candidates", lambda: default_target_names(self), expected, fd)
        return result

    return target_defaults


# Exact Spack 1.0.0 error_messages.lp templates and positional argument counts.
EXTERNAL_ERROR_PREFIX = (
    "Attempted to build package {0} which is not buildable and does not have a satisfying external\n"
    "        "
)
EXTERNAL_ATTRIBUTE_ERRORS = {
    EXTERNAL_ERROR_PREFIX + attributes
    + " is an external constraint for {0} which was not satisfied": count
    for attributes, count in (
        ("attr('{1}', '{2}')", 3),
        ("attr('{1}', '{2}', '{3}')", 4),
        ("attr('{1}', '{2}', '{3}', '{4}')", 5),
        ("attr('{1}', '{2}', '{3}', '{4}', '{5}')", 6),
    )
}
EXTERNAL_VARIANT_ERROR = (
    EXTERNAL_ERROR_PREFIX
    + "'Spec({0} {1}={2})' is an external constraint for {0} which was not satisfied\n"
    "        'Spec({0} {1}={3})' required"
)
OS_NOT_BUILDABLE_ERROR = (
    "Cannot select '{0} os={1}' (operating system '{1}' is not buildable)"
)
COMPILER_EXTERNAL_ERROR = "Only external, or concrete, compilers are allowed for the {0} language"
# Exact concretize.lp external-selection templates; each has one package argument.
EXTERNAL_SELECTION_ERRORS = {
    "Attempted to use external for '{0}' which does not satisfy any configured external spec version":
        "version",
    "Attempted to use external for '{0}' which does not satisfy a unique configured external spec version":
        "version",
    "Attempted to use external for '{0}' which does not satisfy any configured external spec":
        "other",
}


def solver_error_fields(error):
    kind = package = attribute = variant = "other"
    if type(error) not in (tuple, list) or len(error) != 3:
        return kind, package, attribute, variant
    _, message, args = error
    if type(message) is not str or type(args) not in (tuple, list):
        return kind, package, attribute, variant
    if len(message) > 4096:
        return kind, package, attribute, variant
    message = message.replace("\\n", "\n")
    count = EXTERNAL_ATTRIBUTE_ERRORS.get(message)
    if count is not None and len(args) == count:
        kind = "external-condition"
        attributes = {
            "namespace": "namespace", "version": "version",
            "node_version_satisfies": "version", "node_platform": "platform",
            "node_os": "os", "node_target": "target", "node_target_satisfies": "target",
            "variant_value": "variant", "concrete_variant_request": "variant",
            "node_flag": "flags",
        }
        if type(args[1]) is str:
            attribute = attributes.get(args[1], "other")
        if attribute == "variant" and len(args) >= 5:
            variant = args[3]
    elif message == EXTERNAL_VARIANT_ERROR and len(args) >= 4:
        kind, attribute, variant = "external-condition", "variant", args[1]
    elif message == OS_NOT_BUILDABLE_ERROR and len(args) == 2:
        kind, attribute = "os-not-buildable", "os"
    elif message == COMPILER_EXTERNAL_ERROR and len(args) == 1:
        # This template has a language argument, not a package argument.
        kind = "compiler-external"
    elif message in EXTERNAL_SELECTION_ERRORS and len(args) == 1:
        kind, attribute = "external-selection", EXTERNAL_SELECTION_ERRORS[message]
    if kind in ("external-condition", "external-selection", "os-not-buildable"):
        if type(args[0]) is str and args[0] in ("gcc", "gmake", "glibc", "hello"):
            package = args[0]
    if type(variant) is not str or variant not in ("languages", "build_system"):
        variant = "other"
    return kind, package, attribute, variant


def emit_target_error(error, expected, fd):
    if type(error) not in (tuple, list) or len(error) != 3:
        return
    _, message, args = error
    if (type(message) is not str or len(message) > 4096
            or type(args) not in (tuple, list) or len(args) != 4):
        return
    if EXTERNAL_ATTRIBUTE_ERRORS.get(message.replace("\\n", "\n")) != 4:
        return
    if (any(type(value) is not str for value in args[:3])
            or args[0] != "gmake" or args[2] != "gmake"
            or args[1] not in ("node_target", "node_target_satisfies")):
        return
    mode = "exact" if args[1] == "node_target" else "range"
    matches = "unavailable"
    if type(args[3]) is str and type(expected) is str:
        # Literal equality only: range containment would require new spec parsing.
        matches = "true" if args[3] == expected else "false"
    emit_diagnostic(fd, f"ci-target-error:mode={mode} matches={matches}")


def diagnosed_message(function, fd, target_observer=None, expected_target=None):
    def message(self, errors):
        if target_observer is not None:
            try:
                target_observer(self)
            except Exception:
                pass
        try:
            # Do not consume iterators that the original formatter still needs.
            if type(errors) in (tuple, list):
                for error in errors[:64]:
                    kind, package, attribute, variant = solver_error_fields(error)
                    emit_diagnostic(
                        fd, f"ci-solver-error:kind={kind} package={package}"
                        f" attribute={attribute} variant={variant}",
                    )
                    emit_target_error(error, expected_target, fd)
        except Exception:
            pass
        return function(self, errors)

    return message


def compiler_execution_kind(error):
    message = getattr(error, "long_message", None)
    if type(message) is not str:
        return "other"
    message = message[:65536].lower()
    for kind, fragments in (
        ("no-space", ("no space left on device",)),
        ("readonly", ("read-only file system",)),
        ("permission", ("permission denied", "operation not permitted")),
        ("missing-library", ("error while loading shared libraries", "cannot find -l",
                             "library not found for -l")),
        ("unsupported-option", ("unrecognized command-line option", "unknown argument:",
                                "unsupported option")),
        ("missing-file", ("no such file or directory",)),
        ("linker", ("undefined reference", "ld returned", "linker command failed")),
    ):
        if any(fragment in message for fragment in fragments):
            return kind
    return "other"


def diagnosed_compilation(function, replace_attribute, executable, fd):
    def compile_source(*args, **kwargs):
        original = executable.Executable.__call__

        def execute(*call_args, **call_kwargs):
            try:
                return original(*call_args, **call_kwargs)
            except executable.ProcessError as error:
                try:
                    emit_diagnostic(fd, "ci-compiler-execution:" + compiler_execution_kind(error))
                except Exception:
                    pass
                raise

        with replace_attribute(executable.Executable, "__call__", execute):
            return function(*args, **kwargs)

    return compile_source


SOLVED_NODE_LIMIT = 64
SOLVED_PACKAGES = {
    "hello", "gcc", "gmake", "glibc", "compiler-wrapper", "gcc-runtime",
    "samtools", "htslib", "zlib", "ncurses", "bzip2", "xz", "pkgconf", "pkg-config",
    "diffutils", "libiconv", "python", "perl",
}


def comparison_value(value, budget, depth=0):
    budget[0] -= 1
    if budget[0] < 0 or depth > 16:
        raise ValueError("Comparison budget exceeded")
    if value is None or type(value) in (bool, int):
        return (type(value).__name__, value)
    if isinstance(value, str):
        if len(value) > 16384:
            raise ValueError("Comparison string budget exceeded")
        return ("string", value)
    if isinstance(value, (list, tuple)):
        if len(value) > budget[0]:
            raise ValueError("Comparison sequence budget exceeded")
        return ("sequence", tuple(comparison_value(x, budget, depth + 1) for x in value))
    if isinstance(value, dict):
        if len(value) > budget[0] or any(
            not isinstance(key, str) or len(key) > 1024 for key in value
        ):
            raise ValueError("Unavailable comparison mapping")
        return ("mapping", tuple(
            (key, comparison_value(value[key], budget, depth + 1)) for key in sorted(value)
        ))
    raise ValueError("Unavailable comparison value")


def solved_equal(left, right):
    try:
        return "true" if comparison_value(left(), [4096]) == comparison_value(right(), [4096]) else "false"
    except Exception:
        return "unavailable"


def node_architecture(data):
    arch = data["arch"]
    target = arch["target"]
    if isinstance(target, dict):
        target = target["name"]
    result = (arch["platform"], arch["platform_os"], target)
    if not all(type(value) is str and 0 < len(value) <= 1024 for value in result):
        raise ValueError("Unavailable architecture")
    return result


def profile_architecture(profile):
    target = profile["target"]
    if type(target) is not str or len(target) > 1024:
        raise ValueError("Unavailable profile architecture")
    result = tuple(target.split("-"))
    if len(result) != 3 or not all(result):
        raise ValueError("Unavailable profile architecture")
    return result


def cached_node_hash(spec):
    # Spack 1.0 stores the already-computed DAG hash here; never reconstruct it.
    value = spec._hash
    if type(value) is not str or not 0 < len(value) <= 128:
        raise ValueError("Unavailable cached hash")
    return value


def emit_solved_node(spec, data, expected, expected_digest, match, profile, fd):
    name = data.get("name")
    package = name if type(name) is str and name in SOLVED_PACKAGES else "other"
    fields = {key: "unavailable" for key in (
        "hash", "version", "namespace", "arch-profile", "arch-lock",
        "target-profile", "target-lock", "parameters", "external", "package-hash", "dependencies",
    )}
    fields["arch-profile"] = solved_equal(
        lambda: node_architecture(data), lambda: profile_architecture(profile),
    )
    fields["target-profile"] = solved_equal(
        lambda: node_architecture(data)[2], lambda: profile_architecture(profile)[2],
    )
    if expected is not None:
        for key in ("version", "namespace"):
            fields[key] = solved_equal(lambda: data[key], lambda: expected[key])
        fields["arch-lock"] = solved_equal(
            lambda: node_architecture(data), lambda: node_architecture(expected),
        )
        fields["target-lock"] = solved_equal(
            lambda: node_architecture(data)[2], lambda: node_architecture(expected)[2],
        )
        fields["parameters"] = solved_equal(
            lambda: data["parameters"], lambda: expected["parameters"],
        )
        fields["external"] = solved_equal(
            lambda: data.get("external"), lambda: expected.get("external"),
        )
        fields["package-hash"] = solved_equal(
            lambda: data.get("package_hash"), lambda: expected.get("package_hash"),
        )
        fields["dependencies"] = solved_equal(
            lambda: data.get("dependencies", []), lambda: expected.get("dependencies", []),
        )
        fields["hash"] = solved_equal(lambda: cached_node_hash(spec), lambda: expected_digest)
    emit_diagnostic(
        fd, f"ci-solved-node:package={package} match={match} "
        + " ".join(f"{key}={value}" for key, value in fields.items()),
    )


def emit_solved_lock(root, lock, profile, fd):
    summary = {
        "status": "unavailable", "solved": "unavailable", "expected": "unavailable",
        "root-hash": "unavailable",
    }
    records = []
    try:
        expected = lock["concrete_specs"]
        if not isinstance(expected, dict):
            raise ValueError("Unavailable lock nodes")
        summary["expected"] = len(expected) if len(expected) <= SOLVED_NODE_LIMIT else "over-limit"
        if len(expected) > SOLVED_NODE_LIMIT:
            summary["status"] = "limit"
        else:
            nodes = []
            for spec in root.traverse():
                if len(nodes) == SOLVED_NODE_LIMIT:
                    summary.update(status="limit", solved="over-limit")
                    break
                nodes.append(spec)
            if summary["status"] != "limit":
                summary["solved"] = len(nodes)
                for spec in nodes:
                    data = spec.to_node_dict()
                    if (not isinstance(data, dict) or type(data.get("name")) is not str
                            or len(data["name"]) > 1024):
                        raise ValueError("Unavailable native node")
                    records.append((spec, data))
                if any(type(key) is not str or len(key) > 128 or not isinstance(data, dict)
                       or type(data.get("name")) is not str or len(data["name"]) > 1024
                       for key, data in expected.items()):
                    raise ValueError("Unavailable lock node")
                summary["root-hash"] = solved_equal(
                    lambda: cached_node_hash(root), lambda: lock["roots"][0]["hash"],
                )
                summary["status"] = "ok"
    except Exception:
        summary["status"] = "unavailable"
        records.clear()
    emit_diagnostic(fd, "ci-solved-lock:" + " ".join(
        f"{key}={value}" for key, value in summary.items()
    ))
    if summary["status"] != "ok":
        return
    for spec, data in records:
        candidates = [(key, node) for key, node in expected.items() if node["name"] == data["name"]]
        same_name = sum(node["name"] == data["name"] for _, node in records)
        expected_digest = expected_data = None
        if len(candidates) > 1 or same_name > 1:
            match = "ambiguous"
        elif candidates:
            match = "unique"
            expected_digest, expected_data = candidates[0]
        else:
            match = "missing"
        emit_solved_node(spec, data, expected_data, expected_digest, match, profile, fd)


def diagnosed_bind_native(function, fd):
    def bind(root, lock, profile):
        try:
            return function(root, lock, profile)
        except Exception:
            try:
                emit_solved_lock(root, lock, profile, fd)
            except Exception:
                pass
            raise

    return bind


def diagnosed_solver(worker, fd):
    original = worker.solve_lock

    def solve(*args, **kwargs):
        import clingo
        import spack.compilers.libraries
        import spack.solver.asp
        import spack.util.executable

        expected = solve_target(args, kwargs)
        with contextlib.ExitStack() as instrumentation:
            instrumentation.enter_context(worker.replace_attribute(
                worker, "bind_native", diagnosed_bind_native(worker.bind_native, fd),
            ))
            instrumentation.enter_context(worker.replace_attribute(
                spack.solver.asp.SpackSolverSetup, "target_defaults",
                diagnosed_target_defaults(
                    spack.solver.asp.SpackSolverSetup.target_defaults, expected, fd,
                ),
            ))
            for owner, name, phase in (
                (spack.solver.asp.SpackSolverSetup, "setup", "native-setup"),
                (clingo.Control, "ground", "native-ground"),
                (spack.solver.asp.SpecBuilder, "build_specs", "native-result"),
            ):
                instrumentation.enter_context(worker.replace_attribute(
                    owner, name, traced_call(getattr(owner, name), phase, fd),
                ))
            for owner, name, observer in (
                (spack.solver.asp, "possible_compilers",
                 lambda result: emit_compiler_candidates(result, fd)),
                (spack.compilers.libraries.CompilerPropertyDetector, "compiler_verbose_output",
                 lambda result: emit_compiler_probe("verbose", result, fd)),
                (spack.compilers.libraries.CompilerPropertyDetector, "default_libc",
                 lambda result: emit_compiler_probe("libc", result, fd)),
            ):
                instrumentation.enter_context(worker.replace_attribute(
                    owner, name, observed_return(getattr(owner, name), observer),
                ))
            instrumentation.enter_context(worker.replace_attribute(
                spack.solver.asp.ErrorHandler, "message",
                diagnosed_message(
                    spack.solver.asp.ErrorHandler.message, fd,
                    lambda handler: emit_target_model(handler, clingo.SymbolType, expected, fd),
                    expected_target=expected,
                ),
            ))
            detector = spack.compilers.libraries.CompilerPropertyDetector
            instrumentation.enter_context(worker.replace_attribute(
                detector, "_compile_dummy_c_source",
                diagnosed_compilation(detector._compile_dummy_c_source, worker.replace_attribute,
                                      spack.util.executable, fd),
            ))
            return original(*args, **kwargs)

    return solve


def writable_mounts(frame):
    paths = {
        "/": "root", "/dev": "devices", "/dev/null": "null-device",
        "/dev/zero": "zero-device", "/dev/random": "random-device",
        "/dev/urandom": "urandom-device", "/dev/tty": "tty-device",
        "/etc/passwd": "passwd", "/etc/group": "group",
        "/etc/resolv.conf": "resolver", "/etc/hosts": "hosts",
        "/etc/localtime": "localtime", "/sys/fs/cgroup": "cgroups",
        "/tmp": "tmp", "/var/tmp": "var-tmp", "/kq/work": "work",
    }
    filesystems = {
        "overlay", "ext4", "xfs", "fuse.squashfuse", "fuse.squashfuse_ll",
        "fuse-overlayfs", "fuse.fuse-overlayfs", "cgroup2", "devtmpfs", "ramfs",
    }
    emitted = set()
    for path, options, filesystem in frame.f_locals.get("mounts", []):
        if ("rw" not in options or path == frame.f_locals.get("store")
                or filesystem in {"tmpfs", "proc", "sysfs", "devpts", "mqueue"}):
            continue
        location = paths.get(str(path), "other")
        kind = filesystem if filesystem in filesystems else "other"
        emitted.add("ci-writable-mount:location=" + location + " filesystem=" + kind)
    for line in sorted(emitted):
        print(line, file=sys.stderr)


def locations(error):
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        kind = type(error).__name__
        allowed = {
            "AuditError", "KeyError", "ValueError", "TypeError", "AttributeError",
            "OSError", "PermissionError", "FileNotFoundError", "InstallError", "SystemExit",
            "RuntimeError", "AssertionError", "UnsatisfiableSpecError", "SolverError",
            "InternalConcretizerError", "OutputDoesNotSatisfyInputError", "NoCompilerFoundError",
            "InvalidExternalError", "ConfigError", "ConfigFormatError", "SpackError",
            "UnknownPackageError",
        }
        print("ci-worker-error:" + (kind if kind in allowed else "Exception"), file=sys.stderr)
        if kind in allowed:
            message = str(error)
            for category, fragment in {
                "compiler-target": "incompatible with 'target=",
                "compiler-external": "Only external, or concrete, compilers are allowed",
                "host-target": "not compatible with this machine",
                "attribute-selection": "Cannot select a single",
                "version-constraint": "Cannot satisfy",
                "not-buildable": "is not buildable",
                "no-compiler": "No compilers",
                "solver-timeout": "stopping concretization",
                "solver-memory": "bad_alloc",
                "namespace-conflict": "namespaces",
            }.items():
                if fragment in message:
                    print("ci-solver-category:" + category, file=sys.stderr)
        trace = error.__traceback__
        while trace is not None:
            filename = trace.tb_frame.f_code.co_filename
            if filename in {"/kq/input/install_worker.py", "/kq/input/source_audit.py"}:
                print("ci-worker-location:" + Path(filename).name + ":" + str(trace.tb_lineno),
                      file=sys.stderr)
                if trace.tb_frame.f_code.co_name == "verify_scratch":
                    writable_mounts(trace.tb_frame)
            for module in (
                "concretize.py", "solver/asp.py", "solver/core.py", "solver/counter.py",
                "compilers/config.py", "spec.py", "config.py", "store.py", "database.py",
            ):
                if filename == "/opt/spack/lib/spack/spack/" + module:
                    print("ci-native-location:" + module + ":" + str(trace.tb_lineno),
                          file=sys.stderr)
            trace = trace.tb_next
        error = error.__cause__


def main():
    sys.path.insert(0, "/kq/input")
    try:
        saved_out, saved_err = os.dup(1), os.dup(2)
        try:
            with open(os.devnull, "w") as sink:
                os.dup2(sink.fileno(), 1)
                os.dup2(sink.fileno(), 2)
                with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                    if len(sys.argv) == 2:
                        import source_audit as worker
                        worker.verify_runtime_boundary(Path("/kq/input"))
                        result = worker.audit(Path("/kq/input"), Path("/kq/work"), sys.argv[1])
                        prefix = "KQ_SPACK_AUDIT_RESULT:"
                    else:
                        import install_worker as worker
                        with contextlib.ExitStack() as instrumentation:
                            for owner, name, phase in (
                                (worker.audit, "audit", "source-audit"),
                                (worker, "configuration", "configuration"),
                                (worker, "solve_lock", "solve"),
                                (worker, "verify_tree", "tree"),
                                (worker, "verify_installed", "installed"),
                            ):
                                function = (diagnosed_solver(worker, saved_err)
                                            if name == "solve_lock" else getattr(owner, name))
                                instrumentation.enter_context(worker.replace_attribute(
                                    owner, name, traced_call(function, phase, saved_err),
                                ))
                            with worker.native_output():
                                result = worker.run(Path("/kq/input"), Path("/kq/work"))
                        prefix = "KQ_SPACK_INSTALL_RESULT:"
        finally:
            os.dup2(saved_out, 1)
            os.dup2(saved_err, 2)
            os.close(saved_out)
            os.close(saved_err)
        print(prefix + json.dumps(result, separators=(",", ":")))
        return 1 if result.get("passed") is False else 0
    except (Exception, SystemExit) as error:
        locations(error)
        return 1


if __name__ == "__main__":
    sys.exit(main())

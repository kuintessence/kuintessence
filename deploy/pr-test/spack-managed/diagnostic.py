"""CI failure diagnosis only; executes unchanged worker checks, never publishes."""
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
    if kind in ("external-condition", "os-not-buildable"):
        if type(args[0]) is str and args[0] in ("gcc", "gmake", "glibc", "hello"):
            package = args[0]
    if type(variant) is not str or variant not in ("languages", "build_system"):
        variant = "other"
    return kind, package, attribute, variant


def diagnosed_message(function, fd):
    def message(self, errors):
        try:
            # Do not consume iterators that the original formatter still needs.
            if type(errors) in (tuple, list):
                for error in errors[:64]:
                    kind, package, attribute, variant = solver_error_fields(error)
                    emit_diagnostic(
                        fd, f"ci-solver-error:kind={kind} package={package}"
                        f" attribute={attribute} variant={variant}",
                    )
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


def diagnosed_solver(worker, fd):
    original = worker.solve_lock

    def solve(*args, **kwargs):
        import clingo
        import spack.compilers.libraries
        import spack.solver.asp
        import spack.util.executable

        with contextlib.ExitStack() as instrumentation:
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
                diagnosed_message(spack.solver.asp.ErrorHandler.message, fd),
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

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


def diagnosed_solver(worker, fd):
    original = worker.solve_lock

    def solve(*args, **kwargs):
        import clingo
        import spack.solver.asp

        with contextlib.ExitStack() as instrumentation:
            for owner, name, phase in (
                (spack.solver.asp.SpackSolverSetup, "setup", "native-setup"),
                (clingo.Control, "ground", "native-ground"),
                (spack.solver.asp.SpecBuilder, "build_specs", "native-result"),
            ):
                instrumentation.enter_context(worker.replace_attribute(
                    owner, name, traced_call(getattr(owner, name), phase, fd),
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

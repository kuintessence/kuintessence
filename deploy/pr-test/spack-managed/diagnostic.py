"""CI failure diagnosis only; executes unchanged worker checks, never publishes."""
import contextlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, "/kq/input")


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
        }
        print("ci-worker-error:" + (kind if kind in allowed else "Exception"), file=sys.stderr)
        trace = error.__traceback__
        while trace is not None:
            filename = trace.tb_frame.f_code.co_filename
            if filename in {"/kq/input/install_worker.py", "/kq/input/source_audit.py"}:
                print("ci-worker-location:" + Path(filename).name + ":" + str(trace.tb_lineno),
                      file=sys.stderr)
                if trace.tb_frame.f_code.co_name == "verify_scratch":
                    writable_mounts(trace.tb_frame)
            trace = trace.tb_next
        error = error.__cause__


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
                    with worker.native_output():
                        result = worker.run(Path("/kq/input"), Path("/kq/work"))
                    prefix = "KQ_SPACK_INSTALL_RESULT:"
    finally:
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        os.close(saved_out)
        os.close(saved_err)
    print(prefix + json.dumps(result, separators=(",", ":")))
    if result.get("passed") is False:
        raise SystemExit(1)
except (Exception, SystemExit) as error:
    locations(error)
    raise SystemExit(1) from None

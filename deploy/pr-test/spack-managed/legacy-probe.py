"""Bounded CI-only legacy inventory probe. Never emit captured process output."""

import json
import os
import selectors
import signal
import stat
import subprocess
import time


TIMEOUT_SECONDS = 15
REAP_TIMEOUT_SECONDS = 2
STREAM_LIMIT = 64 * 1024
STATUS_PATH = "/var/lib/kuintessence/legacy-probe-status"


def marker(result: str, reason: str = "none", shape: str = "unavailable") -> str:
    return f"ci-legacy-find:result={result} reason={reason} json={shape}\n"


def json_shape(stdout: bytes) -> str:
    try:
        value = json.loads(stdout)
    except (ValueError, UnicodeError, RecursionError):
        return "invalid"
    if not isinstance(value, list):
        return "non-array"
    return "array" if value else "empty-array"


def failure_reason(stderr: bytes) -> str:
    # Match location and failure on the same line; unrelated warnings are not evidence.
    lines = stderr.decode("utf-8", errors="replace").lower().splitlines()
    permission = False
    for line in lines:
        if not any(token in line for token in (
            "permission denied", "read-only file system",
            "file does not exist and location is not writable",
        )):
            continue
        permission = True
        if any(token in line for token in (
            "/opt/spack/opt/", "'/opt/spack/opt'", '"/opt/spack/opt"',
        )):
            return "store-permission"
        if "/etc/spack/" in line or ("/.spack/" in line and ".yaml" in line):
            return "config-permission"
        if "/.spack/" in line and any(token in line for token in (
            "/cache/", "/package_repos/", "/git_repos/",
        )):
            return "cache-permission"
    if permission:
        return "permission-other"
    if any(token in line for line in lines for token in (
        "norepoconfigurederror", "badrepoerror", "unknownnamespaceerror",
    )):
        return "repo-init"
    return "other"


def stop_and_reap(process: subprocess.Popen) -> None:
    # A child may still hold a pipe after the immediate process has exited.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        process.kill()
    process.wait(timeout=REAP_TIMEOUT_SECONDS)


def probe(binary: str) -> str:
    deadline = time.monotonic() + TIMEOUT_SECONDS
    try:
        process = subprocess.Popen(
            [binary, "find", "--json"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except Exception:
        return marker("spawn", "other")

    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    reaped = False
    try:
        with selectors.DefaultSelector() as selector:
            for name, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
                selector.register(stream, selectors.EVENT_READ, name)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return marker("timeout", "other")
                for key, _ in selector.select(remaining):
                    buffer = buffers[key.data]
                    chunk = os.read(key.fd, min(4096, STREAM_LIMIT - len(buffer) + 1))
                    if not chunk:
                        selector.unregister(key.fileobj)
                    elif len(buffer) + len(chunk) > STREAM_LIMIT:
                        return marker("output-limit", "other")
                    else:
                        buffer.extend(chunk)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return marker("timeout", "other")
            try:
                exit_code = process.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                return marker("timeout", "other")
            reaped = True
        shape = json_shape(bytes(buffers["stdout"]))
        if exit_code != 0:
            return marker("nonzero", failure_reason(bytes(buffers["stderr"])), shape)
        return marker("ok", shape=shape)
    except Exception:
        return marker("nonzero", "other")
    finally:
        if not reaped:
            try:
                stop_and_reap(process)
            except Exception:
                pass
        for stream in (process.stdout, process.stderr):
            try:
                stream.close()
            except Exception:
                pass


def write_status(line: str) -> None:
    fd = os.open(
        STATUS_PATH,
        os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
        0o644,
    )
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            return
        os.ftruncate(fd, 0)
        data = line.encode("ascii")
        while data:
            written = os.write(fd, data)
            if written <= 0:
                return
            data = data[written:]
    finally:
        os.close(fd)


def main() -> None:
    try:
        if os.environ.get("KQ_PR_TEST") != "1" or os.getuid() != 1000:
            return
        line = probe(os.environ.get("AGENT_SPACK_PATH", "/opt/spack/bin/spack"))
        write_status(line)
    except Exception:
        # Diagnostics must not replace the Agent outcome or expose exception text.
        pass


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Supervise Agent and its independent watchdog inside scheduler containers."""

import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time


def prepare_database(path):
    # Never follow a link or take ownership of another account's state.
    if path.resolve() != path.absolute():
        raise ValueError("Agent database path must not contain symlinks")
    for target in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
        flags = os.O_RDWR | os.O_NOFOLLOW
        if target == path:
            flags |= os.O_CREAT
        try:
            descriptor = os.open(target, flags, 0o600)
        except FileNotFoundError:
            if target != path:
                continue
            raise
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                raise ValueError("Agent database must be a private file owned by the service account")
            os.fchmod(descriptor, 0o600)
        finally:
            os.close(descriptor)


def signal_group(process, signum):
    try:
        os.killpg(process.pid, signum)
    except ProcessLookupError:
        pass


def main():
    prepare_database(Path(os.environ["AGENT_DB_PATH"]))
    entry = "/workspace/packages/agent/src/index.ts"
    commands = {"agent": ["bun", entry], "watchdog": ["bun", entry, "--federation-watchdog"]}
    processes = {}
    restart_at = {name: 0 for name in commands}
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not stopping:
            for name, command in commands.items():
                process = processes.get(name)
                if process is not None and process.poll() is not None:
                    # Reap only this child's descendants; the other service has its own session.
                    signal_group(process, signal.SIGKILL)
                    print(f"kq-supervisor: {name} exited ({process.returncode}); restarting", file=sys.stderr, flush=True)
                    del processes[name]
                    restart_at[name] = time.monotonic() + 1
                if name not in processes and time.monotonic() >= restart_at[name] and not stopping:
                    processes[name] = subprocess.Popen(command, start_new_session=True)
            time.sleep(0.1)
    finally:
        for process in processes.values():
            signal_group(process, signal.SIGTERM)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and any(p.poll() is None for p in processes.values()):
            time.sleep(0.1)
        for process in processes.values():
            signal_group(process, signal.SIGKILL)
            process.wait()


if __name__ == "__main__":
    main()

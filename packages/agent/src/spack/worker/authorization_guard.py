"""Trusted host-side guard; the isolated worker never receives the lease or notify socket."""

import json
import math
import os
import socket
import stat
import subprocess
import sys
import time


def read_lease(path, unit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > 16384):
            raise ValueError("Invalid authorization file")
        lease = json.load(source)
    if (set(lease) != {"unit", "expiresAt", "bootDeadline"} or lease["unit"] != unit
            or any(type(lease[key]) is not int or lease[key] <= 0
                   for key in ("expiresAt", "bootDeadline"))):
        raise ValueError("Invalid authorization binding")
    return lease


def remaining(lease):
    return min(lease["expiresAt"] / 1000 - time.time(),
               lease["bootDeadline"] / 1000 - time.clock_gettime(time.CLOCK_BOOTTIME))


def main():
    path, unit, deadline = sys.argv[1:4]
    deadline = int(deadline) / 1000
    if deadline > time.clock_gettime(time.CLOCK_BOOTTIME) + 24 * 60 * 60:
        raise ValueError("Invalid installation timeout")
    lease = read_lease(path, unit)
    address = os.environ["NOTIFY_SOCKET"]
    if address.startswith("@"):
        address = "\0" + address[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notify:
        notify.connect(address)

        def extend():
            seconds = min(remaining(lease), deadline - time.clock_gettime(time.CLOCK_BOOTTIME))
            if not math.isfinite(seconds) or seconds <= 0 or seconds > 30:
                raise ValueError("Installation authorization expired")
            notify.sendall(f"EXTEND_TIMEOUT_USEC={max(1, int(seconds * 1000000))}".encode())
            return seconds

        extend()
        notify.sendall(b"READY=1")
        extend()
        # env -i in the command strips NOTIFY_SOCKET before the isolated worker starts.
        child = subprocess.Popen(sys.argv[4:], close_fds=True)
        while True:
            extend()
            result = child.poll()
            if result is not None:
                return result if result >= 0 else 1
            time.sleep(min(0.1, remaining(lease) / 2))
            # Never accept an update after the previous lease expired.
            extend()
            lease = read_lease(path, unit)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError):
        sys.stderr.write("Managed installation authorization guard stopped\n")
        sys.exit(1)

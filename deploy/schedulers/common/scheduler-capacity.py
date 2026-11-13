#!/usr/bin/env python3
"""Advertise container resources, reserving memory for Agent and scheduler daemons."""
import os
from pathlib import Path


def read_limit(path):
    try:
        return path.read_text().strip()
    except FileNotFoundError:
        return "max"


def resources(root=Path("/sys/fs/cgroup"), meminfo=Path("/proc/meminfo")):
    host_mib = int(next(line.split()[1] for line in meminfo.read_text().splitlines() if line.startswith("MemTotal:"))) // 1024
    memory = host_mib * 4 // 5
    limit = read_limit(root / "memory.max")
    if limit == "max":
        limit = read_limit(root / "memory/memory.limit_in_bytes")
    if limit != "max":
        memory = min(memory, int(limit) // 1024 ** 2 - 256)
    if memory < 64:
        raise ValueError("Container needs at least 320 MiB for scheduler/Agent and a small job")
    cpus = len(os.sched_getaffinity(0))
    quota = read_limit(root / "cpu.max").split()
    if quota[0] != "max":
        cpus = min(cpus, max(1, int(quota[0]) // int(quota[1])))
    else:
        legacy = read_limit(root / "cpu/cpu.cfs_quota_us")
        if legacy not in ("max", "-1"):
            cpus = min(cpus, max(1, int(legacy) // int(read_limit(root / "cpu/cpu.cfs_period_us"))))
    return cpus, memory


if __name__ == "__main__":
    print(*resources())

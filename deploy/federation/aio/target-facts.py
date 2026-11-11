#!/usr/bin/env python3
"""Observe the delivered scheduler image without installing or solving software."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

TOOL_PATH = "/opt/spack/bin:/opt/pbs/bin:/usr/sbin:/usr/bin:/bin"


def sha256(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def command(argv):
    result = subprocess.run(argv, check=True, capture_output=True, text=True, timeout=30,
                            env={"PATH": TOOL_PATH,
                                 "HOME": "/tmp", "TMPDIR": "/tmp", "LANG": "C",
                                 "SPACK_DISABLE_LOCAL_CONFIG": "true"})
    return result.stdout.strip()


def executable(name, arguments):
    path = shutil.which(name, path=TOOL_PATH)
    if path is None:
        raise ValueError(f"Required target executable missing: {name}")
    resolved = Path(path).resolve(strict=True)
    return {"path": path, "canonicalPath": str(resolved), "sha256": sha256(resolved),
            "version": command([path, *arguments])}


def collect(scheduler):
    if scheduler not in ("slurm", "pbs"):
        raise ValueError("Select slurm or pbs")
    os_release = Path("/etc/os-release")
    release = {}
    for line in os_release.read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            if key in ("ID", "VERSION_ID"):
                release[key] = value.strip('"')
    if not all(release.get(key) for key in ("ID", "VERSION_ID")):
        raise ValueError("Target OS identity is incomplete")
    tools = {name: executable(name, args) for name, args in (
        ("gcc", ["-dumpfullversion"]), ("g++", ["-dumpfullversion"]),
        ("gfortran", ["-dumpfullversion"]), ("make", ["--version"]),
        ("python3", ["--version"]), ("spack", ["--version"]),
        # Slurm clients load cluster configuration even for --version; the daemon does not.
        ("slurmd" if scheduler == "slurm" else "qstat", ["--version"]),
    )}
    spack = tools["spack"]["path"]
    return {"version": 1, "scheduler": scheduler,
            "observedAt": datetime.now(timezone.utc).isoformat(),
            "os": {**release, "releaseSha256": sha256(os_release),
                   "libc": command(["getconf", "GNU_LIBC_VERSION"])},
            "spackArchitecture": {name: command([spack, "arch", flag]) for name, flag in (
                ("platform", "-p"), ("operatingSystem", "-o"), ("hostTarget", "-t"))},
            "executables": tools,
            "runtimeToolsPresent": {name: shutil.which(name) is not None for name in (
                "apptainer", "systemd-run", "systemctl")},
            "softwareInstallationAccepted": False}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Usage: target-facts.py slurm|pbs")
        print(json.dumps(collect(sys.argv[1]), indent=2))
    except (ValueError, OSError, subprocess.SubprocessError):
        # Tool output may contain local configuration; leave only a fixed diagnostic.
        print("Target observation failed; no profile or native lock was generated", file=sys.stderr)
        sys.exit(1)

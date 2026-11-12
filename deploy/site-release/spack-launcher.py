#!/usr/bin/env python3
"""Spack CLI entrypoint for <shared>/releases/<digest>/spack."""

import os
from pathlib import Path
import re
import stat
import sys


def private_directory(path):
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    entry = path.lstat()
    if (not stat.S_ISDIR(entry.st_mode) or entry.st_uid != os.getuid()
            or stat.S_IMODE(entry.st_mode) != 0o700 or path.resolve() != path):
        raise ValueError("Spack CLI state must be canonical, user-owned and mode 0700")


def main():
    executable = Path(os.path.abspath(__file__))
    here = executable.parent
    if (here.parent.name != "releases" or here.resolve() != here
            or not re.fullmatch(r"[A-Za-z0-9_./-]+", str(here))
            or executable.is_symlink()):
        raise ValueError("Spack CLI requires a canonical releases/<digest>/spack path")
    runtime = here / "runtime.sif"
    if not stat.S_ISREG(runtime.lstat().st_mode):
        raise ValueError("Spack CLI runtime must be a regular file")
    state = here.parent.parent / "spack-cli"
    private_directory(state)
    for name in ("home", "config", "cache", "store"):
        private_directory(state / name)
    argv = [
        "/usr/bin/apptainer", "exec", "--containall", "--userns", "--cleanenv",
        "--no-home", "--net", "--network", "none", "--pwd", "/kq/cli",
        "--bind", f"{state}:/kq/cli",
        "--env", "HOME=/kq/cli/home",
        "--env", "SPACK_DISABLE_LOCAL_CONFIG=1",
        "--env", "SPACK_USER_CONFIG_PATH=/kq/cli/config",
        "--env", "SPACK_USER_CACHE_PATH=/kq/cli/cache",
        str(runtime), "/opt/spack/bin/spack",
        "-c", "config:install_tree:root:/kq/cli/store",
        "-c", "bootstrap:enable:false", *sys.argv[1:],
    ]
    os.chdir(state)
    os.execv(argv[0], argv)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError):
        sys.exit("Spack CLI launcher could not validate or start its private runtime")

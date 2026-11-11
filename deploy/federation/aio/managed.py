#!/usr/bin/env python3
"""AIO-only boot wiring; production Agent still validates all execution authority."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import time

RUNTIME = Path("/opt/kq/runtime")
STATE = Path("/run/kq-managed/environment.json")
STORE = Path("/srv/kq/spack")
IDENTITY = {"SERVER_GRPC_URL", "SERVER_HTTP_URL", "AGENT_ID", "AGENT_SITE_NAME",
            "KQ_AGENT_ENV_FILE", "KQ_AGENT_BINARY", "KQ_AGENT_REGISTRATION_SCHEDULER",
            "KQ_AIO_MANAGED_RUNTIME", "KQ_AIO_MANAGED_STORE_BYTES", "NODE_ENV",
            "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE"}
RUNTIME_KEYS = {
    "AGENT_SPACK_AUDIT_APPTAINER_PATH", "AGENT_SPACK_AUDIT_APPTAINER_SHA256",
    "AGENT_SPACK_AUDIT_SIF_PATH", "AGENT_SPACK_AUDIT_SIF_SHA256",
    "AGENT_SPACK_INSTALL_SITE_PROFILE_PATH", "AGENT_SPACK_INSTALL_SITE_PROFILE_SHA256",
    "AGENT_SPACK_MANAGED_MEMORY_MIB", "AGENT_SPACK_INSTALL_TIMEOUT_MS",
    "AGENT_SANDBOX_PUBLIC_KEYS_JSON", "AGENT_SANDBOX_RUNTIME_CACHE_JSON",
    "AGENT_SANDBOX_SIF_PUBLIC_KEY_PATH", "AGENT_SANDBOX_SIF_PUBLIC_KEY_SHA256",
    "AGENT_SANDBOX_ATTESTATION_TTL_SEC",
    "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE",
}


def run(argv, **kwargs):
    return subprocess.run([str(part) for part in argv], check=True, timeout=120, **kwargs)


def protected(path):
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError("Runtime paths must be canonical")
    for parent in path.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("Runtime parent is not protected")
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError("Runtime file is not protected")
    return info


def read_json(path):
    if protected(path).st_size > 128 * 1024:
        raise ValueError("Runtime configuration is too large")
    return json.loads(path.read_text())


def sha256(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def runtime_environment():
    config = read_json(RUNTIME / "agent.json")
    if not isinstance(config, dict) or set(config) != {"version", "environment"} or type(config["version"]) is not int or config["version"] != 1:
        raise ValueError("Unsupported managed runtime configuration")
    env = config["environment"]
    if not isinstance(env, dict) or not set(env).issubset(RUNTIME_KEYS) or any(
            not isinstance(v, str) or not v or "\0" in v or "\n" in v or "\r" in v for v in env.values()):
        raise ValueError("Invalid managed runtime environment")
    for stem in ("AGENT_SPACK_AUDIT_APPTAINER", "AGENT_SPACK_AUDIT_SIF",
                 "AGENT_SPACK_INSTALL_SITE_PROFILE", "AGENT_SANDBOX_SIF_PUBLIC_KEY"):
        path = Path(env.get(stem + "_PATH", ""))
        expected = env.get(stem + "_SHA256", "")
        if not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise ValueError("Missing pinned runtime digest")
        info = protected(path)
        if stem.endswith("SIF") and info.st_mode & 0o222:
            raise ValueError("Runtime SIF must be read-only")
        if sha256(path) != expected:
            raise ValueError("Runtime digest mismatch")
    profile = read_json(Path(env["AGENT_SPACK_INSTALL_SITE_PROFILE_PATH"]))
    if not isinstance(profile, dict) or profile.get("storeRoot") != str(STORE):
        raise ValueError("Site profile must use the AIO bounded store")
    if not all(env.get(key) for key in ("AGENT_SANDBOX_PUBLIC_KEYS_JSON", "AGENT_SANDBOX_RUNTIME_CACHE_JSON")):
        raise ValueError("Provision the Server public keys and approved runtime cache")
    for key in ("NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE"):
        if env.get(key):
            protected(Path(env[key]))
    checker = Path("/usr/libexec/kuintessence/kq-sandbox-cgroup-check")
    seccomp = Path("/etc/kuintessence/aio-seccomp.json")
    probe = Path("/etc/kuintessence/aio-seccomp-probe.json")
    for path in (checker, seccomp, probe):
        protected(path)
    return {**env, "AGENT_SLURM_TERMINAL_STATUS_BACKEND": "sacct", "AGENT_SPACK_ENABLED": "true", "AGENT_SPACK_AUDIT_ENABLED": "true",
            "AGENT_SPACK_INSTALL_ENABLED": "true", "AGENT_SPAWNER_BACKEND": "host",
            "AGENT_SANDBOX_ENABLED": "true", "AGENT_SANDBOX_EXECUTION_MODE": "self-account",
            "AGENT_SANDBOX_ROOT_IMPERSONATION": "false", "AGENT_SANDBOX_ROOT": "/scratch/sandbox",
            "AGENT_SANDBOX_NETWORK_ISOLATION": "true", "AGENT_SANDBOX_CGROUPS": "true",
            "AGENT_SANDBOX_SECCOMP": "true", "AGENT_SANDBOX_SIF_SIGNATURE_VERIFICATION": "true",
            "AGENT_SANDBOX_APPTAINER_PATH": env["AGENT_SPACK_AUDIT_APPTAINER_PATH"],
            "AGENT_SANDBOX_CGROUP_CHECK_PATH": str(checker), "AGENT_SANDBOX_CGROUP_CHECK_SHA256": sha256(checker),
            "AGENT_SANDBOX_SECCOMP_PROFILE_PATH": str(seccomp), "AGENT_SANDBOX_SECCOMP_PROFILE_SHA256": sha256(seccomp),
            "AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_PATH": str(probe), "AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_SHA256": sha256(probe),
            "AGENT_SANDBOX_ATTESTATION_QUEUE": "debug" if os.environ["KQ_AGENT_REGISTRATION_SCHEDULER"] == "slurm" else "workq"}


def prepare_store(directory, size):
    if type(size) is not int or not 1024 ** 3 <= size <= 16 * 1024 ** 3:
        raise ValueError("AIO store size must be between 1 and 16 GiB")
    path = directory / "store.ext4"
    info = directory.lstat()
    if directory.resolve(strict=True) != directory or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError("Managed disk directory is not protected")
    if path.exists() or path.is_symlink():
        info = protected(path)
        if info.st_nlink != 1 or info.st_size != size:
            raise ValueError("Existing store identity or size differs; maintenance is required")
        return path
    if shutil.disk_usage(directory).free < size + 256 * 1024 ** 2:
        raise ValueError("Not enough space for the bounded AIO store")
    pending = directory / "store.ext4.creating"
    # A crash leaves this exclusive checkpoint; never format an unknown existing file.
    with pending.open("xb") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.truncate(size)
        stream.flush()
        os.fsync(stream.fileno())
    run(["/usr/sbin/mkfs.ext4", "-q", "-F", pending])
    with pending.open("rb") as stream:
        os.fsync(stream.fileno())
    os.link(pending, path)
    pending.unlink()
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return path


def prepare_slurm_accounting(config=Path("/etc/slurm-llnl/slurmdbd.conf")):
    password_file = RUNTIME / "slurm-db-password"
    info = protected(password_file)
    if info.st_mode & 0o077 or info.st_size > 65:
        raise ValueError("Accounting password must be a private root file")
    password = password_file.read_text().removesuffix("\n")
    if not re.fullmatch(r"[a-f0-9]{64}", password):
        raise ValueError("Accounting password must be 32 random hex-encoded bytes")
    content = ("AuthType=auth/munge\nDbdHost=localhost\nDbdPort=6819\nSlurmUser=slurm\n"
               "LogFile=/var/log/slurm/slurmdbd.log\nPidFile=/run/slurmdbd.pid\n"
               "StorageType=accounting_storage/mysql\nStorageHost=scheduler-accounting\n"
               f"StorageUser=slurm\nStoragePass={password}\nStorageLoc=slurm_acct_db\n")
    with open(config, "w", opener=lambda p, flags: os.open(p, flags | os.O_NOFOLLOW, 0o600)) as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(content)
    shutil.chown(config, user="slurm", group="slurm")


def register_slurm_accounting():
    for _ in range(30):
        result = subprocess.run(["sacctmgr", "-nP", "show", "cluster", "format=Cluster"],
                                capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            break
        time.sleep(1)
    else:
        raise ValueError("Slurm accounting did not become ready")
    # These are technical associations for the single test account, not business approval.
    for kind, filters, fields, expected, creation in (
        ("cluster", ["Cluster=kq-aio-slurm"], "Cluster", "kq-aio-slurm",
         ["cluster", "kq-aio-slurm"]),
        ("account", ["Name=kq-aio"], "Account", "kq-aio",
         ["account", "kq-aio", "Cluster=kq-aio-slurm"]),
        ("association", ["Cluster=kq-aio-slurm", "Account=kq-aio", "User=kq"], "Cluster,Account,User",
         "kq-aio-slurm|kq-aio|kq", ["user", "kq", "Account=kq-aio", "Cluster=kq-aio-slurm"]),
    ):
        query = ["sacctmgr", "-nP", "show", kind, "where", *filters, f"format={fields}"]
        values = run(query, capture_output=True, text=True).stdout.strip()
        if not values:
            run(["sacctmgr", "-i", "add", *creation], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            values = run(query, capture_output=True, text=True).stdout.strip()
        if values != expected:
            raise ValueError("Slurm accounting association requires reconciliation")


def install_pbs_hook():
    run(["systemctl", "start", "kq-pbs-jobs.slice"])
    group = run(["systemctl", "show", "--property=ControlGroup", "--value", "kq-pbs-jobs.slice"],
                capture_output=True, text=True).stdout.strip()
    if not re.fullmatch(r"/(?:[A-Za-z0-9_-]+\.slice/)*kq-pbs-jobs\.slice", group):
        raise ValueError("Invalid PBS job slice")
    Path("/run/kuintessence").mkdir(mode=0o755, exist_ok=True)
    root = Path("/sys/fs/cgroup") / group.lstrip("/")
    (root / "cgroup.subtree_control").write_text("+cpu +memory")
    jobs = root / "jobid"
    jobs.mkdir(exist_ok=True)
    (jobs / "cgroup.subtree_control").write_text("+cpu +memory")
    config = Path("/etc/kuintessence/pbs-cgroup-v2.json")
    config.write_text(json.dumps({"cgroupRoot": str(jobs), "queues": ["workq"]}) + "\n")
    config.chmod(0o644)
    hook = "/usr/local/share/kuintessence/kq-cgroup-v2.py"
    # Re-import only this fixed hook; a persistent PBS DB may already contain it.
    found = subprocess.run(["qmgr", "-c", "list hook kq_sandbox_cgroup_v2"], capture_output=True, timeout=30)
    if found.returncode:
        run(["qmgr", "-c", "create hook kq_sandbox_cgroup_v2"])
    for statement in (
        'set hook kq_sandbox_cgroup_v2 enabled=false',
        'set hook kq_sandbox_cgroup_v2 event="execjob_begin,execjob_launch,execjob_attach,execjob_end"',
        'set hook kq_sandbox_cgroup_v2 alarm=10',
        f'import hook kq_sandbox_cgroup_v2 application/x-python default {hook}',
        'set hook kq_sandbox_cgroup_v2 enabled=true',
    ):
        run(["qmgr", "-c", statement])
    for _ in range(30):
        installed = Path("/var/spool/pbs/mom_priv/hooks/kq_sandbox_cgroup_v2.PY")
        if installed.is_file() and sha256(installed) == sha256(Path(hook)):
            return
        time.sleep(1)
    raise ValueError("PBS MOM has not received the fixed cgroup hook")


def main(action):
    if os.environ.get("KQ_AIO_MANAGED_RUNTIME") != "1":
        if action == "agent":
            os.execv(sys.executable, [sys.executable, "/usr/local/lib/kuintessence/start-agent.py"])
        raise ValueError("Managed bootstrap is limited to an explicit AIO test configuration")
    if action == "init":
        if os.getuid() != 0 or os.getpid() != 1 or Path("/proc/1/cgroup").read_text().strip() != "0::/":
            raise ValueError("Managed init requires a private container cgroup namespace")
        STATE.parent.mkdir(mode=0o700)
        values = {k: v for k, v in os.environ.items() if k in IDENTITY or k.startswith("AGENT_")}
        with STATE.open("x") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(values, stream)
        os.execv("/sbin/init", ["/sbin/init"])
    elif action == "start":
        if os.getuid() != 0:
            raise ValueError("Managed setup requires container root")
        os.environ.update(read_json(STATE))
        scheduler = os.environ["KQ_AGENT_REGISTRATION_SCHEDULER"]
        if scheduler not in ("slurm", "pbs-pro"):
            raise ValueError("Unsupported managed scheduler")
        os.environ.update(runtime_environment())
        os.environ["PATH"] = "/opt/pbs/bin:/opt/pbs/sbin:/opt/spack/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
        os.environ["SLURM_CONF"] = "/etc/slurm-llnl/slurm.conf"
        if Path("/sys/fs/cgroup/memory.max").read_text().strip() == "max":
            raise ValueError("Managed scheduler requires a container memory limit")
        path = prepare_store(Path("/managed-disk"), int(os.environ["KQ_AIO_MANAGED_STORE_BYTES"]))
        run(["mount", "-o", "loop,nosuid,nodev", path, STORE])
        run(["chown", "kq:kq", STORE])
        run(["loginctl", "enable-linger", "kq"])
        run(["systemctl", "start", "user@1000.service"])
        if not Path("/run/user/1000/bus").is_socket():
            raise ValueError("Managed user service is unavailable")
        if scheduler == "slurm":
            shutil.copyfile("/usr/local/share/kuintessence/managed-slurm.conf", "/etc/slurm-llnl/slurm.conf.template")
            shutil.copyfile("/usr/local/share/kuintessence/managed-cgroup.conf", "/etc/slurm-llnl/cgroup.conf")
        os.execv("/bin/bash", ["/bin/bash", "/usr/local/bin/kq-slurm-entrypoint" if scheduler == "slurm" else "/usr/local/bin/kq-pbs-entrypoint"])
    elif action == "pbs-hook":
        if os.getuid() != 0:
            raise ValueError("PBS hook setup requires container root")
        install_pbs_hook()
    elif action in ("slurm-accounting", "slurm-accounting-register"):
        if os.getuid() != 0 or os.environ.get("KQ_AGENT_REGISTRATION_SCHEDULER") != "slurm":
            raise ValueError("Accounting setup requires the managed Slurm root bootstrap")
        if action == "slurm-accounting":
            prepare_slurm_accounting()
        else:
            register_slurm_accounting()
    elif action == "agent":
        if os.getuid() != 1000:
            raise ValueError("Managed Agent must use the isolated kq account")
        os.environ.update(runtime_environment())
        os.environ.update({"HOME": "/home/kq", "USER": "kq", "LOGNAME": "kq",
                           "XDG_RUNTIME_DIR": "/run/user/1000", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus"})
        sandbox = Path("/scratch/sandbox")
        sandbox.mkdir(mode=0o700, exist_ok=True)
        os.execv(sys.executable, [sys.executable, "/usr/local/lib/kuintessence/start-agent.py"])
    else:
        raise ValueError("Unsupported managed operation")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Select a managed operation")
        main(sys.argv[1])
    except (ValueError, KeyError, OSError, subprocess.SubprocessError):
        print("Managed AIO setup failed; preserve state and reconcile configuration", file=sys.stderr)
        sys.exit(1)

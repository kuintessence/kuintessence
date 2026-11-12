#!/bin/bash
# Single uploaded entrypoint. Generated from onboard.py; do not edit the embedded copy.
set -eo pipefail
exec 3<&0
export KQ_BOOTSTRAP_STDIN_FD=3
[[ $# -ge 1 && -f $1 ]] || { echo 'Usage: bash bootstrap.sh /absolute/site.env [check|install|stage|prepare-capabilities|activate|rollback|services|doctor|maintain ACTION]' >&2; exit 2; }
export KQ_SITE_ENV="$(realpath "$1")"
export KQ_BOOTSTRAP_SCRIPT="$(realpath "$0")"
source "$KQ_SITE_ENV"
shift
if [[ -n ${KQ_MODULE_INIT:-} ]]; then source "$KQ_MODULE_INIT"; fi
export KQ_PYTHON_MODULE_STATUS=not-tested
export KQ_APPTAINER_MODULE_STATUS=not-tested
if type module >/dev/null 2>&1; then
  module load "${KQ_PYTHON_MODULE:-bio-python/3.11-2026.07.24}"
  export KQ_PYTHON_MODULE_STATUS=passed
  if [[ ${KQ_ENABLE_SPACK:-0} == 1 ]]; then
    module load "${KQ_APPTAINER_MODULE:-apptainer/1.5.3}"
    apptainer --version >/dev/null
    export KQ_APPTAINER_MODULE_STATUS=passed
  elif [[ ${1:-check} == check ]]; then
    if ( module load "${KQ_APPTAINER_MODULE:-apptainer/1.5.3}" >/dev/null 2>&1 && apptainer --version >/dev/null 2>&1 ); then
      export KQ_APPTAINER_MODULE_STATUS=passed
    else
      export KQ_APPTAINER_MODULE_STATUS=failed
    fi
  fi
fi
umask 077
exec python3 - "$@" <<'KQ_BOOTSTRAP_PY'
"""Rootless, restartable site bootstrap. Python 3 standard library; curl/OpenSSH/OpenSSL."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit


MODULES_SMOKE = '#!/bin/bash -l\n# 用 sbatch 或 KQ 在计算节点执行；当前目录必须是本次独立共享工作目录。\nset -eo pipefail\nsource "${1:?需要 site.env 的绝对路径}"\n: "${SLURM_JOB_ID:?请通过 Slurm/KQ 提交，不要在登录节点直接执行}"\nif [[ -n ${KQ_MODULE_INIT:-} ]]; then source "$KQ_MODULE_INIT"; fi\ntype module >/dev/null 2>&1 || { echo \'请配置 KQ_MODULE_INIT\' >&2; exit 1; }\nmodule load "$KQ_PYTHON_MODULE" >/dev/null 2>&1\nexport KQ_SMOKE_COMPILER_STATUS=not-tested KQ_SMOKE_MPI_STATUS=not-tested\nif [[ -n ${KQ_SMOKE_COMPILER_MODULE:-} ]]; then\n  if module load "$KQ_SMOKE_COMPILER_MODULE" >/dev/null 2>&1; then\n    export KQ_SMOKE_COMPILER_STATUS=loaded\n  else\n    export KQ_SMOKE_COMPILER_STATUS=failed\n  fi\nfi\nif [[ -n ${KQ_SMOKE_MPI_MODULE:-} ]]; then\n  if module load "$KQ_SMOKE_MPI_MODULE" >/dev/null 2>&1; then\n    export KQ_SMOKE_MPI_STATUS=loaded\n  else\n    export KQ_SMOKE_MPI_STATUS=failed\n  fi\nfi\nexport KQ_SMOKE_APPTAINER_STATUS=not-tested\nif [[ -n ${KQ_APPTAINER_MODULE:-} ]]; then\n  if module load "$KQ_APPTAINER_MODULE" >/dev/null 2>&1; then\n    export KQ_SMOKE_APPTAINER_STATUS=loaded\n  else\n    export KQ_SMOKE_APPTAINER_STATUS=failed\n  fi\nfi\numask 077\npython3 - <<\'PY\'\nimport hashlib\nimport json\nimport shutil\nimport os\nfrom pathlib import Path\nimport platform\nimport re\nimport subprocess\nimport tempfile\nimport time\n\ndelay = int(os.environ.get(\'KQ_SMOKE_SLEEP_SEC\', \'0\'))\nif not 0 <= delay <= 120:\n    raise SystemExit(\'KQ_SMOKE_SLEEP_SEC must be between 0 and 120\')\nif Path(\'result.json\').exists():\n    raise SystemExit(\'result.json already exists; use a new working directory\')\nshared = Path(os.environ[\'KQ_SHARED\']).resolve()\ninside_shared = Path.cwd().resolve().is_relative_to(shared)\nif not inside_shared:\n    raise SystemExit(\'working directory must be inside KQ_SHARED\')\nprint(\'KQ_SMOKE_STARTED slurm_job_id=\' + os.environ[\'SLURM_JOB_ID\'], flush=True)\ntime.sleep(delay)\nwith tempfile.TemporaryFile(dir=\'.\') as probe:\n    probe.write(b\'kq-shared-probe\')\n    probe.flush()\n    os.fsync(probe.fileno())\n    probe.seek(0)\n    shared_ok = probe.read() == b\'kq-shared-probe\'\n\ndef module_label(value):\n    if re.fullmatch(r\'[A-Za-z0-9][A-Za-z0-9_+./-]{0,199}\', value) and \'..\' not in value.split(\'/\'):\n        return value\n    return \'redacted\'\n\ndef version(kind, default, allowed):\n    status = os.environ[\'KQ_SMOKE_\' + kind + \'_STATUS\']\n    if status != \'loaded\':\n        return {\'status\': status}\n    command = os.environ.get(\'KQ_SMOKE_\' + kind + \'_COMMAND\', default)\n    if command not in allowed:\n        return {\'status\': \'failed\'}\n    try:\n        result = subprocess.run([command, \'--version\'], capture_output=True, text=True, timeout=5)\n        # Retain only a version token; tool banners can contain site paths or hostnames.\n        match = re.search(r\'(?<![\\w.])\\d+\\.\\d+(?:\\.\\d+){0,2}(?![\\w.])\', result.stdout[:4096])\n        if result.returncode == 0 and match:\n            return {\'status\': \'passed\', \'module\': module_label(os.environ.get(\'KQ_SMOKE_\' + kind + \'_MODULE\', \'\')), \'command\': command, \'version\': match[0]}\n    except (OSError, subprocess.TimeoutExpired):\n        pass\n    return {\'status\': \'failed\', \'command\': command}\n\nos_release = {}\ntry:\n    for line in Path(\'/etc/os-release\').read_text()[:16384].splitlines():\n        key, _, value = line.partition(\'=\')\n        value = value.strip(\'"\\\'\')\n        if key in (\'ID\', \'VERSION_ID\') and re.fullmatch(r\'[A-Za-z0-9_.-]{1,80}\', value):\n            os_release[key] = value\nexcept OSError:\n    pass\nflags = None\ntry:\n    with open(\'/proc/cpuinfo\') as cpuinfo:\n        cpu_text = cpuinfo.read(2 * 1024 * 1024)\n    for line in cpu_text.splitlines():\n        key, _, value = line.partition(\':\')\n        if key.strip() in (\'flags\', \'Features\'):\n            current = set(value.split())\n            flags = current if flags is None else flags & current\nexcept OSError:\n    pass\nsupported = {\'sse2\', \'ssse3\', \'popcnt\', \'cx16\', \'lahf_lm\', \'sse4_1\', \'sse4_2\', \'avx\', \'avx2\', \'avx512f\', \'avx512bw\', \'avx512dq\', \'avx512vl\', \'fma\', \'aes\', \'bmi1\', \'bmi2\', \'neon\', \'asimd\', \'sve\', \'sve2\', \'atomics\', \'crc32\'}\nlibc_name, libc_version = platform.libc_ver()\ndef command_status(args):\n    try:\n        probe = subprocess.run(args, capture_output=True, text=True, timeout=15)\n        return \'passed\' if probe.returncode == 0 else \'failed\'\n    except (OSError, subprocess.TimeoutExpired):\n        return \'failed\'\n\nbudget = os.environ.get(\'KQ_SPACK_MANAGED_MEMORY_MIB\', \'4096\')\nvalid_budget = bool(re.fullmatch(r\'[0-9]{1,7}\', budget)) and 1024 <= int(budget) <= 1048576\nscratch_min = os.environ.get(\'KQ_SPACK_SCRATCH_MIN_MIB\', \'20480\')\nscratch = os.environ.get(\'KQ_COMPUTE_SCRATCH\', \'\')\ncapabilities = {\n    \'observedAt\': int(time.time()),\n    \'partition\': os.environ.get(\'SLURM_JOB_PARTITION\', \'\'),\n    \'memoryMib\': int(budget) if valid_budget else None,\n    \'abi\': {\'status\': \'passed\' if platform.machine() and libc_name == \'glibc\' and re.fullmatch(r\'[0-9]+\\.[0-9]+\', libc_version) else \'failed\'},\n    \'userManager\': {\'status\': command_status([\'systemctl\', \'--user\', \'show-environment\'])},\n    \'scratch\': {\'status\': \'not-tested\'},\n    \'isolation\': {\'status\': \'not-tested\'},\n}\nif scratch and re.fullmatch(r\'[0-9]{1,9}\', scratch_min) and 1 <= int(scratch_min) <= 1048576:\n    try:\n        scratch_path = Path(scratch)\n        if not scratch_path.is_absolute() or not scratch_path.is_dir():\n            raise ValueError(\'scratch\')\n        free = shutil.disk_usage(scratch_path).free // 1024**2\n        with tempfile.TemporaryFile(dir=scratch_path) as probe:\n            probe.write(b\'kq-scratch\')\n            probe.flush()\n            os.fsync(probe.fileno())\n        capabilities[\'scratch\'] = {\'status\': \'passed\' if free >= int(scratch_min) else \'failed\', \'availableMib\': free, \'requiredMib\': int(scratch_min)}\n    except (OSError, ValueError):\n        capabilities[\'scratch\'] = {\'status\': \'failed\'}\nsif = os.environ.get(\'KQ_CAPABILITY_SIF_PATH\', \'\')\nif sif and valid_budget:\n    try:\n        image = Path(sif)\n        if not image.is_absolute() or not image.is_file():\n            raise ValueError(\'image\')\n        digest = hashlib.sha256()\n        with image.open(\'rb\') as source:\n            for chunk in iter(lambda: source.read(1024 * 1024), b\'\'):\n                digest.update(chunk)\n        capabilities[\'runtimeSifSha256\'] = digest.hexdigest()\n        memory = int(budget) * 1024**2\n        host_net = os.readlink(\'/proc/self/ns/net\')\n        host_pid = os.readlink(\'/proc/self/ns/pid\')\n        # Verify effective controls inside the same isolation flags as managed workers.\n        code = """import os,pathlib\nassert os.readlink(\'/proc/self/ns/net\') != %r\nassert os.readlink(\'/proc/self/ns/pid\') != %r\nstatus = pathlib.Path(\'/proc/self/status\').read_text().splitlines()\nassert any(x.split() == [\'NoNewPrivs:\', \'1\'] for x in status)\nassert any(x.split() == [\'CapEff:\', \'0000000000000000\'] for x in status)\nentries = pathlib.Path(\'/proc/self/cgroup\').read_text().splitlines()\nassert len(entries) == 1 and entries[0].startswith(\'0::/\')\nroot = pathlib.Path(\'/sys/fs/cgroup\') / entries[0][3:].lstrip(\'/\')\nlimit = (root / \'memory.max\').read_text().strip()\nassert limit.isdecimal() and 0 < int(limit) <= %d\nassert (root / \'memory.swap.max\').read_text().strip() == \'0\'\npids = (root / \'pids.max\').read_text().strip()\nassert pids.isdecimal() and 0 < int(pids) <= 128\n""" % (host_net, host_pid, memory)\n        args = [os.environ.get(\'KQ_APPTAINER_PATH\') or \'apptainer\', \'exec\', \'--containall\', \'--userns\', \'--cleanenv\', \'--no-home\', \'--no-eval\', \'--disable-cache\', \'--writable-tmpfs\', \'--no-mount\', \'bind-paths,hostfs,cwd,home,sys\', \'--net\', \'--network\', \'none\', \'--drop-caps\', \'all\', \'--security\', \'no-new-privs\', \'--pids-limit\', \'128\', \'--memory\', str(memory), \'--memory-swap\', str(memory), \'--cpus\', \'2\', \'--bind\', \'/sys/fs/cgroup:/sys/fs/cgroup:ro\', str(image), \'python3\', \'-c\', code]\n        capabilities[\'isolation\'] = {\'status\': command_status(args)}\n    except (OSError, ValueError):\n        capabilities[\'isolation\'] = {\'status\': \'failed\'}\n\nresult = {\n    \'managedCapabilities\': capabilities,\n    \'schemaVersion\': 1,\n    \'kind\': \'kq-compute-inventory\',\n    \'ok\': shared_ok,\n    \'sum\': sum(range(100)),\n    \'os\': os_release,\n    \'arch\': platform.machine(),\n    \'libc\': {\'name\': libc_name, \'version\': libc_version},\n    \'cpu\': {\'supportedFlags\': sorted((flags or set()) & supported)},\n    \'python\': {\'status\': \'passed\', \'version\': platform.python_version(), \'module\': module_label(os.environ[\'KQ_PYTHON_MODULE\'])},\n    \'compiler\': version(\'COMPILER\', \'cc\', {\'cc\', \'gcc\', \'clang\', \'icx\', \'icc\'}),\n    \'mpi\': version(\'MPI\', \'mpirun\', {\'mpirun\', \'mpiexec\'}),\n    \'shared\': {\'workingDirectoryInsideShared\': inside_shared, \'writeReadDelete\': \'passed\' if shared_ok else \'failed\'},\n}\nwith open(\'result.json\', \'x\') as output:\n    json.dump(result, output, sort_keys=True)\n    output.write(\'\\n\')\nprint(json.dumps(result, sort_keys=True))\nPY\nsha256sum result.json\n'


MAINTENANCE = '"""Private site capacity, retention and stopped-Agent SQLite recovery; standard library only."""\nimport argparse\nimport contextlib\nimport fcntl\nimport hashlib\nimport json\nimport os\nfrom pathlib import Path\nimport re\nimport secrets\nimport shlex\nimport shutil\nimport socket\nimport sqlite3\nimport stat\nimport subprocess\nimport tempfile\nimport time\nimport uuid\nfrom urllib.parse import quote\n\n\ndef private(path, directory=False):\n    path = Path(path)\n    if not path.is_absolute() or path.resolve() != path:\n        raise ValueError("Maintenance paths must be absolute and contain no symlinks")\n    info = path.lstat()\n    if info.st_uid != os.getuid() or info.st_mode & 0o077:\n        raise ValueError("Maintenance data must be private and owned by the current user")\n    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):\n        raise ValueError("Unexpected maintenance file type")\n    return path\n\n\ndef digest(path):\n    value = hashlib.sha256()\n    with private(path).open("rb") as stream:\n        for block in iter(lambda: stream.read(1024 * 1024), b""):\n            value.update(block)\n    return value.hexdigest()\n\n\ndef json_file(path):\n    path = private(path)\n    if path.stat().st_size > 8 * 1024 * 1024:\n        raise ValueError("Oversized maintenance metadata")\n    return json.loads(path.read_text())\n\n\ndef write_json(path, value):\n    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:\n        temporary = Path(stream.name)\n        try:\n            stream.write((json.dumps(value, sort_keys=True) + "\\n").encode())\n            stream.flush()\n            os.fsync(stream.fileno())\n            os.replace(temporary, path)\n            sync(path.parent)\n        finally:\n            temporary.unlink(missing_ok=True)\n\n\ndef sync(path):\n    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)\n    try:\n        os.fsync(fd)\n    finally:\n        os.close(fd)\n\n\ndef capacity(path, reserve_bytes=0, reserve_inodes=128):\n    path = Path(path)\n    while not path.exists():\n        path = path.parent\n    info = os.statvfs(path)\n    available = info.f_bavail * info.f_frsize\n    inodes = info.f_favail\n    result = {"freeBytes": available, "freeInodes": inodes,\n              "requiredBytes": reserve_bytes, "requiredInodes": reserve_inodes,\n              "passed": available >= reserve_bytes and (info.f_files == 0 or inodes >= reserve_inodes)}\n    if not result["passed"]:\n        raise ValueError("Site capacity reserve is insufficient (bytes or inodes)")\n    return result\n\n\n@contextlib.contextmanager\ndef stopped(local):\n    private(local / "state", True)\n    with contextlib.ExitStack() as stack:\n        for relative in ("bootstrap.lock", "state/agent.lock"):\n            path = local / relative\n            if path.exists():\n                private(path)\n            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)\n            stream = stack.enter_context(os.fdopen(fd, "a"))\n            try:\n                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)\n            except BlockingIOError:\n                raise ValueError("Agent or bootstrap is running; maintenance was not applied") from None\n        yield\n\n\n@contextlib.contextmanager\ndef connect(path):\n    private(path)\n    with contextlib.closing(sqlite3.connect("file:" + quote(str(path), safe="/") + "?mode=ro", uri=True)) as database:\n        yield database\n\n\ndef checkpoint_database(path):\n    private(path)\n    with contextlib.closing(sqlite3.connect("file:" + quote(str(path), safe="/") + "?mode=rw", uri=True, timeout=0)) as database:\n        result = database.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()\n        if not result or result[0] != 0 or result[1] != result[2]:\n            raise ValueError("SQLite WAL is still in use; restore was not applied")\n    with path.open("rb") as stream:\n        os.fsync(stream.fileno())\n\n\ndef idle_database(path):\n    with connect(path) as db:\n        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:\n            raise ValueError("SQLite integrity check failed")\n        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type=\'table\'")}\n        checks = {\n            "active_remote_jobs": "1", "job_cleanup_intents": "1",\n            "inbound_dispatch_pending": "acked_at IS NULL",\n            "outbound_job_status": "1", "outbound_software_operation_result": "1",\n            "software_executions": "result IS NULL", "queued_operations": "1",\n            "local_jobs": "status NOT IN (\'completed\',\'failed\',\'cancelled\')",\n            "local_workflow_runs": "status NOT IN (\'completed\',\'failed\',\'cancelled\')",\n        }\n        for table, condition in checks.items():\n            if table not in tables:\n                raise ValueError("Unknown Agent schema; cannot prove maintenance is safe")\n            if db.execute(f"SELECT 1 FROM {table} WHERE {condition} LIMIT 1").fetchone():\n                raise ValueError("Agent has unfinished execution, cleanup or delivery records")\n\n\ndef idle_scheduler():\n    result = subprocess.run(["squeue", "--noheader", "--me", "--format=%i"],\n                            capture_output=True, text=True, timeout=5)\n    if result.returncode != 0 or result.stdout.strip():\n        raise ValueError("Scheduler is unavailable or the current user still has queued jobs")\n\n\ndef idle_workers(shared):\n    terminal = {"COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL", "PREEMPTED", "BOOT_FAIL", "DEADLINE"}\n    for kind in ("audits", "installs"):\n        for journal in (shared / "materials" / kind).glob("run-*/slurm.json"):\n            record = json_file(journal)\n            if record.get("noRequeue") is not True or record.get("phase") not in terminal:\n                raise ValueError("Build journal has no durable terminal proof; reconcile it before maintenance")\n\n\ndef protected_releases(local):\n    protected = set()\n    for name in ("current", "previous", "staged"):\n        pointer = local / name\n        if pointer.is_symlink():\n            target = pointer.resolve()\n            if target.parent != local / "releases":\n                raise ValueError("Unexpected release pointer")\n            protected.add(target.name)\n        elif pointer.exists():\n            protected.add(private(pointer).read_text().strip())\n    for name in ("highest.json",):\n        if (local / name).exists():\n            protected.add(json_file(local / name)["release"])\n    for backup in (local / "backups").glob("*/snapshot.json"):\n        protected.add(json_file(backup)["release"])\n    if any(not re.fullmatch(r"[a-f0-9]{64}", item) for item in protected):\n        raise ValueError("Invalid release retention reference")\n    return protected\n\n\ndef retention_plan(local, shared, days=30, now=None):\n    if not 1 <= days <= 3650:\n        raise ValueError("Retention must be between 1 and 3650 days")\n    cutoff = (now or time.time()) - days * 86400\n    protected = protected_releases(local)\n    candidates = []\n    # Transfer checkpoints, jobs and failed build journals are recovery evidence, never age-only GC.\n    for base in (local / "releases", shared / "releases"):\n        if not base.exists():\n            continue\n        private(base, True)\n        for release in base.iterdir():\n            if not re.fullmatch(r"[a-f0-9]{64}", release.name) or release.name in protected:\n                continue\n            private(release, True)\n            entries = [release, *release.rglob("*")]\n            infos = [private(p, p.is_dir()).stat() for p in entries]\n            if any(info.st_mtime >= cutoff for info in infos):\n                continue\n            candidates.append({"path": str(release), "kind": "release", "bytes": sum(s.st_size for s in infos if stat.S_ISREG(s.st_mode)),\n                               "device": infos[0].st_dev, "inode": infos[0].st_ino})\n    cache = shared / "materials" / "sha256"\n    if cache.exists():\n        private(cache, True)\n        for path in cache.iterdir():\n            # Complete immutable blobs can be fetched again; retain partials and unknown files.\n            if not re.fullmatch(r"[a-f0-9]{64}", path.name):\n                continue\n            private(path)\n            info = path.stat()\n            if info.st_mtime < cutoff:\n                candidates.append({"path": str(path), "kind": "cached-blob", "bytes": info.st_size,\n                                   "device": info.st_dev, "inode": info.st_ino})\n    for kind in ("audits", "installs"):\n        base = shared / "materials" / kind\n        if not base.exists():\n            continue\n        private(base, True)\n        for path in base.glob("run-*"):\n            private(path, True)\n            journal = path / "slurm.json"\n            if not journal.exists():\n                continue\n            record = json_file(journal)\n            if record.get("noRequeue") is not True or record.get("phase") not in {"FAILED", "CANCELLED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL", "BOOT_FAIL", "DEADLINE"}:\n                continue\n            entries = [path, *path.rglob("*")]\n            infos = [private(p, p.is_dir()).stat() for p in entries]\n            if any(info.st_mtime >= cutoff for info in infos):\n                continue\n            candidates.append({"path": str(path), "kind": "expired-failed-build", "journal": record,\n                               "bytes": sum(s.st_size for s in infos if stat.S_ISREG(s.st_mode)),\n                               "device": infos[0].st_dev, "inode": infos[0].st_ino})\n    return {"version": 1, "retentionDays": days, "protectedReleases": sorted(protected),\n            "candidates": candidates, "reclaimBytes": sum(p["bytes"] for p in candidates),\n            "retained": ["state", "registration", "jobs", "partial-materials", "transfer-checkpoints", "unresolved-builds", "installed-prefixes", "backups"]}\n\n\ndef collect(local, shared, days=30, apply=False):\n    if not apply:\n        return retention_plan(local, shared, days)\n    if os.environ.get("KQ_MAINTENANCE_WINDOW") != "1":\n        raise ValueError("Applying retention requires KQ_MAINTENANCE_WINDOW=1")\n    with stopped(local):\n        idle_database(local / "state/agent.db")\n        idle_scheduler()\n        idle_workers(shared)\n        plan = retention_plan(local, shared, days)\n        receipts = local / "retention-receipts"\n        receipts.mkdir(mode=0o700, exist_ok=True)\n        private(receipts, True)\n        receipt = receipts / (str(time.time_ns()) + "-" + secrets.token_hex(8) + ".json")\n        record = {**plan, "startedAt": int(time.time()), "receipt": str(receipt)}\n        write_json(receipt, record)\n        write_json(local / "retention-pending.json", record)\n        # Recompute under both writer locks; caller-provided paths or stale plans never authorize deletion.\n        for item in plan["candidates"]:\n            path = private(Path(item["path"]), item["kind"] != "cached-blob")\n            info = path.stat()\n            if (info.st_dev, info.st_ino) != (item["device"], item["inode"]):\n                raise ValueError("Retention candidate changed")\n            if item["kind"] != "cached-blob":\n                shutil.rmtree(path)\n            else:\n                path.unlink()\n            sync(path.parent)\n        completed = {**record, "appliedAt": int(time.time())}\n        write_json(receipt, completed)\n        write_json(local / "retention-last.json", completed)\n        (local / "retention-pending.json").unlink()\n        return plan\n\n\ndef auto_collect(local, shared, days=30):\n    if os.environ.get("KQ_AUTOMATIC_GC") != "1":\n        return {"skipped": "automatic-retention-disabled"}\n    # Both persistent work and in-memory transfers must be idle before stopping the control process.\n    try:\n        idle_database(local / "state/agent.db")\n        idle_scheduler()\n    except ValueError:\n        return {"skipped": "site-not-idle-or-unproven"}\n    service = ["systemctl", "--user"]\n    active = subprocess.run([*service, "is-active", "--quiet", "kq-agent.service"], timeout=5)\n    if active.returncode != 0:\n        return {"skipped": "agent-service-not-active"}\n    if not retention_plan(local, shared, days)["candidates"]:\n        return {"skipped": "nothing-expired"}\n    lease = secrets.token_hex(16)\n    stop_attempted = False\n    try:\n        try:\n            permit = maintenance_request(local, "drain", lease)\n        except (OSError, ValueError, TimeoutError):\n            return {"skipped": "maintenance-permit-unavailable"}\n        if permit.get("ok") is not True:\n            return {"skipped": "agent-has-in-flight-work"}\n        stop_attempted = True\n        subprocess.run([*service, "stop", "kq-agent.service"], check=True, timeout=90)\n        previous = os.environ.get("KQ_MAINTENANCE_WINDOW")\n        os.environ["KQ_MAINTENANCE_WINDOW"] = "1"\n        try:\n            return collect(local, shared, days, True)\n        finally:\n            if previous is None:\n                os.environ.pop("KQ_MAINTENANCE_WINDOW", None)\n            else:\n                os.environ["KQ_MAINTENANCE_WINDOW"] = previous\n    finally:\n        try:\n            maintenance_request(local, "resume", lease)\n        except (OSError, ValueError, TimeoutError):\n            # A stopped Agent has closed its socket; its replacement has no inherited lease.\n            pass\n        if stop_attempted:\n            subprocess.run([*service, "start", "kq-agent.service"], check=True, timeout=90)\n\n\ndef maintenance_request(local, action, lease):\n    path = local / "state/maintenance.sock"\n    private(local / "state", True)\n    info = path.lstat()\n    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:\n        raise ValueError("Maintenance control socket must be private and user-owned")\n    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:\n        client.settimeout(15)\n        client.connect(str(path))\n        client.sendall((json.dumps({"action": action, "lease": lease}) + "\\n").encode())\n        raw = b""\n        while not raw.endswith(b"\\n"):\n            chunk = client.recv(1024)\n            if not chunk or len(raw) + len(chunk) > 8192:\n                raise ValueError("Invalid maintenance control response")\n            raw += chunk\n    response = json.loads(raw)\n    if not isinstance(response, dict) or response.get("lease") != lease or type(response.get("ok")) is not bool:\n        raise ValueError("Maintenance permit binding mismatch")\n    if response["ok"] and response.get("reason") != {"drain": "MAINTENANCE_DRAINED", "resume": "MAINTENANCE_RESUMED"}.get(action):\n        raise ValueError("Maintenance permit action mismatch")\n    return response\n\n\ndef release_manifest(local, release):\n    directory = private(local / "releases" / release, True)\n    raw = private(directory / "manifest.json").read_bytes()\n    if hashlib.sha256(raw).hexdigest() != release:\n        raise ValueError("Release manifest identity mismatch")\n    manifest = json.loads(raw)\n    for artifact in manifest["files"]:\n        name = artifact["name"]\n        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}", name):\n            raise ValueError("Invalid artifact name")\n        path = private(directory / name)\n        if path.stat().st_size != artifact["size"] or digest(path) != artifact["sha256"]:\n            raise ValueError("Release artifact digest mismatch")\n    return manifest\n\n\ndef database_evidence(path):\n    evidence = {}\n    with connect(path) as db:\n        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type=\'table\'")}\n        for table in sorted(tables - {"sqlite_sequence", "agent_config", "outbound_heartbeat", "local_software"}):\n            if not re.fullmatch(r"[A-Za-z0-9_]+", table):\n                raise ValueError("Unexpected database table")\n            cursor = db.execute(f\'SELECT * FROM "{table}"\')\n            columns = [c[0] for c in cursor.description]\n            ordering = ", ".join(\'"\' + name.replace(\'"\', \'""\') + \'"\' for name in columns)\n            cursor = db.execute(f\'SELECT * FROM "{table}" ORDER BY {ordering}\')\n            count = 0\n            checksum = hashlib.sha256()\n            for values in cursor:\n                canonical = json.dumps(dict(zip(columns, values)), sort_keys=True, separators=(",", ":")).encode()\n                checksum.update(str(len(canonical)).encode() + b":" + canonical)\n                count += 1\n            # New empty tables from a schema migration carry no execution or delivery state to lose.\n            if count:\n                evidence[table] = {"rows": count, "sha256": checksum.hexdigest()}\n    return evidence\n\n\ndef state_files(local):\n    files = {}\n    for path in (local / "state").rglob("*"):\n        if path.is_dir():\n            private(path, True)\n            continue\n        if path == local / "state/maintenance.sock":\n            info = path.lstat()\n            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:\n                raise ValueError("Unexpected maintenance socket")\n            continue\n        if path.parent == local / "state" and (path.name in {"agent.db", "agent.db-wal", "agent.db-shm", "agent.lock", "agent.restore.db"} or path.name.startswith("before-restore-")):\n            continue\n        files[str(path.relative_to(local / "state"))] = digest(path)\n    return files\n\n\ndef copy_private_tree(source, destination):\n    if not source.exists():\n        return {}\n    private(source, True)\n    destination.mkdir(mode=0o700)\n    hashes = {}\n    for path in source.rglob("*"):\n        if path.is_symlink() or path.resolve() != path or path.stat().st_uid != os.getuid():\n            raise ValueError("Snapshot input must be user-owned and contain no symlinks")\n        target = destination / path.relative_to(source)\n        if path.is_dir():\n            target.mkdir(mode=0o700, exist_ok=True)\n        elif path.is_file():\n            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)\n            shutil.copyfile(path, target)\n            target.chmod(0o600)\n            hashes[str(path.relative_to(source))] = digest(target)\n        else:\n            raise ValueError("Snapshot input contains an unsupported file")\n    return hashes\n\n\ndef registration_files(local):\n    source = local / "registration"\n    if not source.exists():\n        return {}\n    private(source, True)\n    hashes = {}\n    for path in source.rglob("*"):\n        if path.is_symlink() or path.resolve() != path or path.stat().st_uid != os.getuid():\n            raise ValueError("Registration identity must be owned and contain no symlinks")\n        if path.is_file():\n            value = hashlib.sha256(path.read_bytes()).hexdigest()\n            hashes[str(path.relative_to(source))] = value\n        elif not path.is_dir():\n            raise ValueError("Unexpected registration identity file")\n    return hashes\n\n\ndef safe_shared(path, directory=False):\n    path = Path(path)\n    if not path.is_absolute() or path.resolve() != path:\n        raise ValueError("Spack recovery path must be canonical and contain no symlinks")\n    info = path.lstat()\n    for parent in path.parents:\n        ancestor = parent.lstat()\n        if (not stat.S_ISDIR(ancestor.st_mode) or ancestor.st_uid not in (0, os.getuid()) or\n                (ancestor.st_mode & 0o022 and not (ancestor.st_uid == 0 and ancestor.st_mode & stat.S_ISVTX))):\n            raise ValueError("Unsafe shared recovery ancestor")\n    if info.st_uid != os.getuid() or info.st_mode & 0o022 or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):\n        raise ValueError("Spack recovery data must be owned and not writable by others")\n    return path\n\n\ndef shared_store(local):\n    release = (local / "current").resolve()\n    if release.parent != local / "releases":\n        raise ValueError("Invalid current release for shared recovery")\n    config = {}\n    for line in private(release / "agent.env").read_text().splitlines():\n        words = shlex.split(line, comments=True)\n        if not words:\n            continue\n        if len(words) != 2 or words[0] != "export" or "=" not in words[1]:\n            raise ValueError("Invalid saved Agent environment for shared recovery")\n        key, value = words[1].split("=", 1)\n        if key in config:\n            raise ValueError("Duplicate saved Agent configuration")\n        config[key] = value\n    path = config.get("AGENT_SPACK_INSTALL_SITE_PROFILE_PATH")\n    expected = config.get("AGENT_SPACK_INSTALL_SITE_PROFILE_SHA256")\n    if not path and not expected and config.get("AGENT_SPACK_INSTALL_ENABLED") != "true":\n        if (Path(os.environ["KQ_SHARED"]) / "store").exists():\n            raise ValueError("Existing shared Spack store requires a pinned site profile")\n        return None\n    if not path or not expected or not re.fullmatch(r"[a-f0-9]{64}", expected):\n        raise ValueError("Shared Spack recovery requires a pinned site profile")\n    profile = safe_shared(Path(path))\n    if profile.stat().st_size > 8 * 1024 * 1024:\n        raise ValueError("Oversized shared recovery site profile")\n    raw = profile.read_bytes()\n    if len(raw) > 8 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != expected:\n        raise ValueError("Shared Spack recovery profile digest mismatch")\n    data = json.loads(raw)\n    if data.get("version") != 1 or not isinstance(data.get("storeRoot"), str):\n        raise ValueError("Invalid Spack recovery site profile")\n    root = safe_shared(Path(data["storeRoot"]), True)\n    return {"root": root, "profileSha256": expected}\n\n\ndef writer_owner(path):\n    value = json_file(path / "owner.json")\n    if not isinstance(value, dict) or set(value) - {"version", "identity", "operationId"} or value.get("version") != 1:\n        raise ValueError("Unknown shared Spack writer owner")\n    identity = value.get("identity")\n    if not isinstance(identity, dict) or set(identity) - {"host", "boot", "start", "pid", "token", "instance"} or not {"host", "boot", "start", "pid", "token"} <= set(identity):\n        raise ValueError("Unknown shared Spack writer identity")\n    def valid_uuid(text):\n        try:\n            return isinstance(text, str) and str(uuid.UUID(text)) == text\n        except (ValueError, AttributeError):\n            return False\n    if type(identity["pid"]) is not int or identity["pid"] <= 0 or not valid_uuid(identity["token"]) or ("instance" in identity and not valid_uuid(identity["instance"])) or ("operationId" in value and not valid_uuid(value["operationId"])):\n        raise ValueError("Invalid shared Spack writer identity")\n    if identity["host"] is None:\n        if identity["boot"] is not None or identity["start"] is not None or "instance" not in identity:\n            raise ValueError("Invalid shared Spack writer identity")\n    elif not isinstance(identity["host"], str) or not re.fullmatch(r"[a-f0-9]{64}", identity["host"]) or not valid_uuid(identity["boot"]) or not isinstance(identity["start"], str) or not identity["start"].isdigit():\n        raise ValueError("Invalid shared Spack writer identity")\n    return value\n\n\ndef maintenance_generation(path, current=None):\n    marker = path / "maintenance.json"\n    if not marker.exists():\n        return False\n    value = json_file(marker)\n    owner = writer_owner(path)\n    token = owner.get("identity", {}).get("token")\n    if value != {"version": 1, "token": token} or not isinstance(token, str):\n        raise ValueError("Invalid shared maintenance generation")\n    if set(p.name for p in path.iterdir()) - {"owner.json", "maintenance.json", "released.json"}:\n        raise ValueError("Unexpected worker state in maintenance generation")\n    if path != current and (not (path / "released.json").exists() or json_file(path / "released.json") != token):\n        raise ValueError("Shared maintenance writer has not released its fence")\n    return True\n\n\n@contextlib.contextmanager\ndef shared_writer(local):\n    store = shared_store(local)\n    if store is None:\n        yield None\n        return\n    root = store["root"]\n    lock = root / ".writer-lock"\n    # This is the Agent\'s real mkdir/generation protocol, not an unrelated flock.\n    try:\n        lock.mkdir(mode=0o700)\n    except FileExistsError:\n        pass\n    else:\n        write_json(lock / "format.json", {"version": 2})\n        sync(root)\n    private(lock, True)\n    if json_file(lock / "format.json") != {"version": 2}:\n        raise ValueError("Unknown shared Spack writer protocol")\n    history = lock / "generations"\n    history.mkdir(mode=0o700, exist_ok=True)\n    private(history, True)\n    names = sorted(p.name for p in history.iterdir())\n    if names != [str(i).zfill(16) for i in range(len(names))]:\n        raise ValueError("Invalid shared Spack writer history")\n    if names:\n        previous = private(history / names[-1], True)\n        owner = writer_owner(previous)\n        token = owner.get("identity", {}).get("token")\n        if owner.get("version") != 1 or not isinstance(token, str) or not re.fullmatch(r"[a-f0-9-]{36}", token):\n            raise ValueError("Invalid shared Spack writer owner")\n        if (previous / "uncertain.json").exists() or not (previous / "released.json").exists() or json_file(previous / "released.json") != token:\n            raise ValueError("Shared Spack writer is active or requires recovery")\n    generation = history / str(len(names)).zfill(16)\n    try:\n        generation.mkdir(mode=0o700)\n    except FileExistsError:\n        raise ValueError("Shared Spack writer raced maintenance") from None\n    sync(history)\n    token = str(uuid.uuid4())\n    # The Agent accepts this untrusted-namespace identity but cannot recover it after a crash.\n    # A crashed maintenance generation therefore remains fenced for explicit reconciliation.\n    owner = {"version": 1, "identity": {"host": None, "boot": None, "start": None,\n             "pid": os.getpid(), "token": token, "instance": str(uuid.uuid4())}}\n    write_json(generation / "owner.json", owner)\n    write_json(generation / "maintenance.json", {"version": 1, "token": token})\n    try:\n        yield {**store, "generation": generation}\n    finally:\n        write_json(generation / "released.json", token)\n\n\ndef shared_digest(path):\n    path = safe_shared(path)\n    value = hashlib.sha256()\n    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)\n    with os.fdopen(fd, "rb") as stream:\n        before = os.fstat(stream.fileno())\n        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_mode & 0o022:\n            raise ValueError("Unsafe shared recovery metadata")\n        for block in iter(lambda: stream.read(1024 * 1024), b""):\n            value.update(block)\n        after = os.fstat(stream.fileno())\n        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):\n            raise ValueError("Shared recovery metadata changed while reading")\n    return value.hexdigest()\n\n\ndef shared_evidence(store):\n    shared = private(Path(os.environ["KQ_SHARED"]), True)\n    files = {}\n    directories = []\n    def capture(path, label):\n        if not path.exists():\n            return\n        safe_shared(path, True)\n        for item in [path, *path.rglob("*")]:\n            relative = str(item.relative_to(path))\n            if item.is_dir():\n                safe_shared(item, True)\n                directories.append(label + "/" + relative)\n            else:\n                safe_shared(item)\n                files[label + "/" + relative] = shared_digest(item)\n    if store:\n        root = store["root"]\n        for name in ("records", "attempts"):\n            capture(root / name, "store/" + name)\n        lock = root / ".writer-lock"\n        files["store/.writer-lock/format.json"] = digest(lock / "format.json")\n        for generation in sorted((lock / "generations").iterdir()):\n            private(generation, True)\n            if not maintenance_generation(generation, store["generation"]):\n                capture(generation, "store/.writer-lock/generations/" + generation.name)\n    # The Slurm runner\'s durable JSON receipts live outside the store too.\n    for kind in ("audits", "installs"):\n        base = shared / "materials" / kind\n        if not base.exists():\n            continue\n        safe_shared(base, True)\n        for run in sorted(base.glob("run-*")):\n            safe_shared(run, True)\n            directories.append("materials/" + kind + "/" + run.name)\n            for item in sorted(run.rglob("*.json")):\n                safe_shared(item)\n                files["materials/" + kind + "/" + str(item.relative_to(base))] = shared_digest(item)\n    return {"version": 1, "storeRoot": str(store["root"]) if store else None,\n            "profileSha256": store["profileSha256"] if store else None,\n            "directories": sorted(directories), "files": dict(sorted(files.items()))}\n\n\ndef snapshot(local):\n    if os.environ.get("KQ_MAINTENANCE_WINDOW") != "1":\n        raise ValueError("Backup requires a stopped Agent in a maintenance window")\n    with stopped(local), shared_writer(local) as shared:\n        database = local / "state/agent.db"\n        idle_database(database)\n        idle_scheduler()\n        idle_workers(private(Path(os.environ["KQ_SHARED"]), True))\n        release = (local / "current").resolve().name\n        manifest = release_manifest(local, release)\n        backups = local / "backups"\n        backups.mkdir(mode=0o700, exist_ok=True)\n        private(backups, True)\n        directory = Path(tempfile.mkdtemp(prefix="snapshot-", dir=backups))\n        try:\n            checkpoint_state = state_files(local)\n            capacity(backups, database.stat().st_size * 2 + sum(p.stat().st_size for p in (local / "state").rglob("*") if p.is_file()) + 1024 ** 3)\n            with connect(database) as source, contextlib.closing(sqlite3.connect(directory / "agent.db")) as target:\n                source.backup(target)\n            (directory / "agent.db").chmod(0o600)\n            for name in ("agent.env",):\n                shutil.copyfile(private(local / "releases" / release / name), directory / name)\n                (directory / name).chmod(0o600)\n            record = {"version": 1, "createdAt": int(time.time()), "release": release,\n                      "stateFormat": manifest["stateFormat"], "databaseSha256": digest(directory / "agent.db"),\n                      "configSha256": digest(directory / "agent.env"),\n                      "evidence": database_evidence(directory / "agent.db"), "checkpointState": checkpoint_state,\n                      "registrationFiles": copy_private_tree(local / "registration", directory / "registration"),\n                      "sharedState": shared_evidence(shared)}\n            (directory / "state").mkdir(mode=0o700)\n            for name, expected in checkpoint_state.items():\n                target = directory / "state" / name\n                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)\n                shutil.copyfile(private(local / "state" / name), target)\n                target.chmod(0o600)\n                if digest(target) != expected:\n                    raise ValueError("Checkpoint changed during a stopped snapshot")\n            # Publish the receipt only after every backup byte and nested directory is durable.\n            entries = list(directory.rglob("*"))\n            for path in entries:\n                if path.is_file():\n                    with private(path).open("rb") as stream:\n                        os.fsync(stream.fileno())\n            for path in sorted((p for p in entries if p.is_dir()), key=lambda p: len(p.parts), reverse=True):\n                sync(private(path, True))\n            write_json(directory / "snapshot.json", record)\n            sync(directory)\n            sync(backups)\n            return {"snapshot": str(directory), "release": release, "stateFormat": record["stateFormat"]}\n        except BaseException:\n            shutil.rmtree(directory)\n            raise\n\n\ndef restore(local, directory):\n    directory = private(directory, True)\n    if directory.parent != local / "backups" or os.environ.get("KQ_MAINTENANCE_WINDOW") != "1":\n        raise ValueError("Restore requires a local snapshot and a maintenance window")\n    with stopped(local), shared_writer(local) as shared:\n        database = local / "state/agent.db"\n        idle_database(database)\n        idle_scheduler()\n        idle_workers(private(Path(os.environ["KQ_SHARED"]), True))\n        record = json_file(directory / "snapshot.json")\n        if digest(directory / "agent.db") != record["databaseSha256"] or digest(directory / "agent.env") != record["configSha256"]:\n            raise ValueError("Snapshot integrity mismatch")\n        manifest = release_manifest(local, record["release"])\n        if manifest["stateFormat"] != record["stateFormat"]:\n            raise ValueError("Snapshot stateFormat mismatch")\n        if "sharedState" not in record or shared_evidence(shared) != record["sharedState"]:\n            raise ValueError("Shared Spack recovery state changed or legacy snapshot lacks evidence; restore refused")\n        if database_evidence(database) != record["evidence"]:\n            raise ValueError("Database has changed execution or delivery records; automatic restore would lose state")\n        if state_files(local) != record["checkpointState"]:\n            raise ValueError("Transfer checkpoint state changed; restore would discard transfer progress")\n        if registration_files(local) != record["registrationFiles"]:\n            raise ValueError("Registration identity or certificate rotated; reconcile identity before state restore")\n        if private(local / "releases" / record["release"] / "agent.env").read_bytes() != (directory / "agent.env").read_bytes():\n            raise ValueError("Saved release configuration changed")\n        # Consolidate the stopped database before touching WAL sidecars, including if replacement crashes.\n        checkpoint_database(database)\n        intent = local / "restore-intent.json"\n        previous = json_file(intent) if intent.exists() else None\n        if previous and (previous.get("snapshot") != directory.name or previous.get("release") != record["release"]):\n            raise ValueError("Another interrupted restore must be reconciled first")\n        link = local / "current.restore"\n        if link.exists() or link.is_symlink():\n            if not previous or not link.is_symlink() or os.readlink(link) != str(local / "releases" / record["release"]):\n                raise ValueError("Restore link staging exists; reconcile before retry")\n            link.unlink()\n        temporary = database.with_name("agent.restore.db")\n        if temporary.exists() or temporary.is_symlink():\n            if not previous or digest(temporary) != record["databaseSha256"]:\n                raise ValueError("Previous restore staging exists; reconcile it first")\n            temporary.unlink()\n        # Preserve the migrated database before replacement; never downgrade an active writer\'s database.\n        recovery = local / "state" / ("before-restore-" + str(time.time_ns()) + ".db")\n        with connect(database) as source, contextlib.closing(sqlite3.connect(recovery)) as target:\n            source.backup(target)\n        recovery.chmod(0o600)\n        with recovery.open("rb") as stream:\n            os.fsync(stream.fileno())\n        shutil.copyfile(directory / "agent.db", temporary)\n        temporary.chmod(0o600)\n        with temporary.open("rb") as stream:\n            os.fsync(stream.fileno())\n        write_json(intent, {"snapshot": directory.name, "release": record["release"],\n                            "beforeDatabase": recovery.name, "startedAt": int(time.time())})\n        for suffix in ("-wal", "-shm"):\n            sidecar = Path(str(database) + suffix)\n            if sidecar.exists():\n                private(sidecar)\n                sidecar.unlink()\n        os.replace(temporary, database)\n        sync(database.parent)\n        link.symlink_to(local / "releases" / record["release"])\n        os.replace(link, local / "current")\n        sync(local)\n        write_json(local / "restore-last.json", {"snapshot": directory.name, "release": record["release"],\n                                                 "stateFormat": record["stateFormat"], "restoredAt": int(time.time())})\n        intent.unlink()\n        sync(local)\n        return {"release": record["release"], "stateFormat": record["stateFormat"], "startAgentExplicitly": True}\n\n\ndef main(argv=None):\n    parser = argparse.ArgumentParser(description=__doc__)\n    parser.add_argument("action", choices=("capacity", "plan", "gc", "auto", "backup", "restore"))\n    parser.add_argument("--snapshot", type=Path)\n    parser.add_argument("--retention-days", type=int, default=30)\n    args = parser.parse_args(argv)\n    local = private(Path(os.environ["KQ_LOCAL"]), True)\n    shared = private(Path(os.environ["KQ_SHARED"]), True)\n    if args.action == "capacity":\n        result = {"local": capacity(local, int(os.environ.get("KQ_LOCAL_RESERVE_BYTES", 1024 ** 3))),\n                  "shared": capacity(shared, int(os.environ.get("KQ_SHARED_RESERVE_BYTES", 2 * 1024 ** 3)))}\n    elif args.action in ("plan", "gc"):\n        result = collect(local, shared, args.retention_days, args.action == "gc")\n    elif args.action == "backup":\n        result = snapshot(local)\n    elif args.action == "auto":\n        result = auto_collect(local, shared, args.retention_days)\n    else:\n        if args.snapshot is None:\n            parser.error("restore requires --snapshot")\n        result = restore(local, args.snapshot)\n    print(json.dumps(result, sort_keys=True))\n\n\nif __name__ == "__main__":\n    main()\n'


def maintenance_module():
    namespace = {"__name__": "kq_site_maintenance"}
    exec(compile(MAINTENANCE, "maintenance.py", "exec"), namespace)
    namespace["idle_workers"] = lambda shared: check_workers()
    original_manifest = namespace["release_manifest"]
    def trusted_manifest(local, release_id):
        manifest = original_manifest(local, release_id)
        rollback_configuration(local, local / "releases" / release_id)
        return manifest
    namespace["release_manifest"] = trusted_manifest
    return namespace


def reserve_capacity(path, additional=0, shared=False):
    variable = "KQ_SHARED_RESERVE_BYTES" if shared else "KQ_LOCAL_RESERVE_BYTES"
    reserve = os.environ.get(variable, str((2 if shared else 1) * 1024 ** 3))
    if not re.fullmatch(r"[0-9]{1,16}", reserve) or not 1024 ** 2 <= int(reserve) <= 1024 ** 5:
        raise ValueError("Invalid site capacity reserve")
    return maintenance_module()["capacity"](path, int(reserve) + max(0, additional))


def install_helpers(shared):
    helpers = private_dir(shared / "helpers")
    atomic(helpers / "modules-smoke.sh", MODULES_SMOKE, 0o500)


def prepare_capabilities(local, shared, release):
    manifest = verify_release(release)
    runtime = role(release, "runtime-sif")
    target = private_dir(shared / "releases" / release.name) / runtime.name
    atomic_copy(runtime, target)
    expected = next(item["sha256"] for item in manifest["files"] if item["role"] == "runtime-sif")
    atomic(local / "capability.env", "export KQ_CAPABILITY_SIF_PATH=" + shlex.quote(str(target)) + "\n" +
           "export KQ_CAPABILITY_SIF_SHA256=" + shlex.quote(expected) + "\n")
    install_helpers(shared)
    print("Signed runtime copied to shared release; source capability.env into the private site.env before the compute capability job. No Agent registration or activation was performed.")


class BootstrapBusy(ValueError):
    pass


def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], check=True, **kwargs)


def sha(path):
    value = hashlib.sha256()
    with open(path, "rb") as source:
        for data in iter(lambda: source.read(1024 * 1024), b""):
            value.update(data)
    return value.hexdigest()


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, data, mode=0o600):
    path = Path(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
            output.write(data if isinstance(data, bytes) else data.encode())
            temporary.chmod(mode)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def atomic_copy(source, destination):
    source, destination = Path(source), Path(destination)
    if destination.is_symlink():
        raise ValueError("Refusing symlinked shared artifact")
    expected = sha(source)
    if destination.exists() and sha(destination) == expected:
        return
    reserve_capacity(destination.parent, source.stat().st_size, shared=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as output:
            temporary = Path(output.name)
            shutil.copyfile(source, temporary)
            if sha(temporary) != expected:
                raise ValueError("Shared release digest mismatch")
            temporary.chmod(source.stat().st_mode & 0o777)
            os.fsync(output.fileno())
        os.replace(temporary, destination)
        sync_directory(destination.parent)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def private_dir(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("Directory must be absolute and contain no symlinks")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError(f"Directory must be private and user-owned: {path}")
    return path


def inspect_directory(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("Directory must be absolute and contain no symlinks")
    ancestor = path
    while not ancestor.exists():
        ancestor = ancestor.parent
    if not ancestor.is_dir() or not os.access(ancestor, os.W_OK | os.X_OK):
        raise ValueError("Directory or nearest ancestor is not writable")
    if path.exists() and (path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077):
        raise ValueError("Existing directory must be private and user-owned")
    return path, ancestor


def required(name):
    value = os.environ.get(name, "")
    if not value:
        raise ValueError(f"Missing {name}")
    return value


def origin(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("HTTPS URLs with verified certificates are required")
    return f"https://{parsed.netloc}"


def forwarding():
    mode = os.environ.get("KQ_TRANSPORT_MODE", "ssh-forward")
    if mode not in ("ssh-forward", "http-proxy"):
        raise ValueError("Invalid KQ_TRANSPORT_MODE")
    key = "KQ_GATEWAY_FORWARD" if mode == "ssh-forward" else "KQ_PROXY_FORWARD"
    mapping = required(key)
    match = re.fullmatch(r"([0-9]+):([A-Za-z0-9][A-Za-z0-9_.-]*):([0-9]+)", mapping)
    if not match or not 1024 <= int(match[1]) <= 65535 or not 1 <= int(match[3]) <= 65535:
        raise ValueError(f"Invalid {key}")
    return mode, int(match[1]), mapping


def configure_transport():
    mode, port, _ = forwarding()
    origins = {origin(required("SERVER_HTTP_URL")), origin(required("SERVER_GRPC_URL"))}
    for extra in os.environ.get("KQ_ALLOWED_ORIGINS", "").split():
        if origin(extra) != extra:
            raise ValueError("Allowed origins cannot contain paths")
        origins.add(extra)
    os.environ["KQ_TRANSPORT_MODE"] = mode
    os.environ["KQ_ALLOWED_ORIGINS"] = " ".join(sorted(origins))
    os.environ["KQ_FORWARD_MAP"] = json.dumps({item: {"host": "127.0.0.1", "port": port} for item in origins}, separators=(",", ":")) if mode == "ssh-forward" else "{}"
    os.environ["KQ_HTTP_PROXY_URL"] = f"http://127.0.0.1:{port}" if mode == "http-proxy" else ""


def curl_options(url):
    if origin(url) not in required("KQ_ALLOWED_ORIGINS").split():
        raise ValueError("Download target is not an allowed platform origin")
    mode, port, _ = forwarding()
    args = ["curl", "--fail", "--silent", "--show-error", "--proto", "=https", "--connect-timeout", "15", "--max-time", "21600", "--retry", "3"]
    if mode == "ssh-forward":
        u = urlsplit(url)
        args += ["--noproxy", "*", "--connect-to", f"{u.hostname}:{u.port or 443}:127.0.0.1:{port}"]
    else:
        args += ["--noproxy", "", "--proxy", required("KQ_HTTP_PROXY_URL")]
    if os.environ.get("KQ_TLS_CA_FILE"):
        args += ["--cacert", required("KQ_TLS_CA_FILE")]
    # Deliberately no -L: redirects are not allowed to escape the configured origin.
    return args


def fetch(url, destination, size=None, digest=None):
    destination = Path(destination)
    if destination.exists() and digest and destination.stat().st_size == size and sha(destination) == digest:
        return
    partial = destination.with_name(destination.name + ".part")
    if partial.is_symlink() or destination.is_symlink():
        raise ValueError("Refusing symlinked download")
    if partial.exists() and size is not None and partial.stat().st_size >= size:
        if partial.stat().st_size == size and sha(partial) == digest:
            os.replace(partial, destination)
            return
        partial.unlink()
    remaining = max(0, (size or 131072) - (partial.stat().st_size if partial.exists() else 0))
    reserve_capacity(destination.parent, remaining)
    args = curl_options(url) + ["--output", str(partial), "--write-out", "%{http_code}"]
    if size is None:
        args += ["--max-filesize", "131072"]
    if size is not None:
        args += ["--max-filesize", str(size), "--continue-at", "-"]
    result = run(args + [url], capture_output=True, text=True)
    if result.stdout not in ("200", "206"):
        raise ValueError(f"Download did not return content: HTTP {result.stdout}")
    if digest and (partial.stat().st_size != size or sha(partial) != digest):
        partial.unlink()
        raise ValueError("Release artifact integrity mismatch")
    with partial.open("rb") as file:
        os.fsync(file.fileno())
    os.replace(partial, destination)


def ssh_args():
    alias = os.environ.get("KQ_SSH_HOST", "kq-service")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", alias):
        raise ValueError("Invalid SSH alias")
    _, _, mapping = forwarding()
    args = ["ssh", "-N", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "ForwardAgent=no", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-L", f"127.0.0.1:{mapping}"]
    for extra in os.environ.get("KQ_EXTRA_FORWARDS", "").split():
        if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_.-]+:[0-9]+", extra):
            raise ValueError("Invalid non-HTTP forwarding rule")
        args += ["-L", f"127.0.0.1:{extra}"]
    return args + [alias]


@contextlib.contextmanager
def tunnel():
    _, port, _ = forwarding()
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            existing = True
    except OSError:
        existing = False
    if existing:
        # Reuse is explicit; TLS and release signatures are verified regardless.
        if os.environ.get("KQ_REUSE_TUNNEL") != "1":
            raise ValueError("Local port already occupied; verify tunnel ownership then set KQ_REUSE_TUNNEL=1")
        yield
        return
    process = subprocess.Popen(ssh_args())
    try:
        for _ in range(150):
            if process.poll() is not None:
                raise ValueError("SSH tunnel exited before becoming ready")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=.1):
                    break
            except OSError:
                time.sleep(.1)
        else:
            raise ValueError("SSH forwarding readiness timed out")
        yield
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def validate_manifest(manifest):
    if manifest.get("version") != 1 or manifest.get("redistribution") != "unrestricted":
        raise ValueError("Unsupported site release")
    if manifest.get("architecture") != platform.machine():
        raise ValueError("Release architecture mismatch")
    host_glibc = os.confstr("CS_GNU_LIBC_VERSION").split()[1]
    if tuple(map(int, host_glibc.split("."))) < tuple(map(int, manifest["minGlibc"].split("."))):
        raise ValueError("Release requires newer glibc")
    cpuinfo = Path("/proc/cpuinfo").read_text().lower().split()
    if not set(manifest["cpuFlags"]).issubset(cpuinfo):
        raise ValueError("Release requires unavailable CPU features")
    files = manifest["files"]
    if not 2 <= len(files) <= 128 or len({f["name"] for f in files}) != len(files):
        raise ValueError("Invalid artifact count or duplicate name")
    names = {item["name"] for item in files}
    if any(name + ".part" in names for name in names):
        raise ValueError("Artifact name conflicts with a download checkpoint")
    for item in files:
        if item["name"] in ("manifest.json", "manifest.sig", "agent.env") or (item["role"] in ("agent", "cli", "spack") and item["executable"] is not True):
            raise ValueError("Reserved artifact name or non-executable entrypoint")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", item["name"]) or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]) or not 0 < item["size"] <= 512 * 1024**3:
            raise ValueError("Invalid artifact metadata")
    required_roles = ("agent", "cli", "runtime-sif", "site-profile", "spack") if os.environ.get("KQ_ENABLE_SPACK") == "1" else ("agent", "cli")
    for role in required_roles:
        if sum(item["role"] == role for item in files) != 1:
            raise ValueError(f"Missing or duplicate {role}")
    if not isinstance(manifest["sequence"], int) or manifest["sequence"] <= 0:
        raise ValueError("Invalid release sequence")
    if not re.fullmatch(r"[a-f0-9]{40}", manifest["serverRevision"]):
        raise ValueError("Invalid Server revision")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", manifest["stateFormat"]):
        raise ValueError("Invalid state format")


def reconcile_active_highest(local, highest):
    current = local / "current"
    if current.is_symlink() and current.exists() and re.fullmatch(r"[a-f0-9]{64}", current.resolve().name):
        release_id = current.resolve().name
        manifest_path = current / "manifest.json"
        if sha(manifest_path) != release_id:
            raise ValueError("Active release manifest changed; reconcile before retry")
        sequence = json.loads(manifest_path.read_text()).get("sequence")
        if type(sequence) is not int or sequence <= 0:
            raise ValueError("Invalid active release sequence")
        if highest and sequence == highest["sequence"] and release_id != highest["release"]:
            raise ValueError("Active release reuses a sequence with different content")
        if not highest or sequence > highest["sequence"]:
            highest = {"sequence": sequence, "release": release_id}
            atomic(local / "highest.json", json.dumps(highest))
    return highest


def highest_release(local):
    record = local / "highest.json"
    if record.exists():
        value = json.loads(record.read_text())
        if not isinstance(value, dict) or set(value) != {"sequence", "release"} or type(value["sequence"]) is not int or value["sequence"] <= 0 or not isinstance(value["release"], str) or not re.fullmatch(r"[a-f0-9]{64}", value["release"]):
            raise ValueError("Invalid release high-water record; reconcile before retry")
        return reconcile_active_highest(local, value)
    legacy_sequence, legacy_release = local / "highest-sequence", local / "highest-release"
    if legacy_sequence.exists() or legacy_release.exists():
        if not legacy_sequence.is_file() or not legacy_release.is_file():
            raise ValueError("Incomplete legacy release high-water record; reconcile before retry")
        sequence = int(legacy_sequence.read_text())
        if sequence <= 0:
            raise ValueError("Invalid legacy release sequence")
        release_id = legacy_release.read_text().strip()
        if not re.fullmatch(r"[a-f0-9]{64}", release_id):
            raise ValueError("Invalid legacy release high-water record")
        manifest_path = local / "releases" / release_id / "manifest.json"
        if sha(manifest_path) != release_id or json.loads(manifest_path.read_text()).get("sequence") != sequence:
            raise ValueError("Inconsistent legacy release high-water record; reconcile before retry")
        value = {"sequence": sequence, "release": release_id}
        atomic(record, json.dumps(value))
        return reconcile_active_highest(local, value)
    return reconcile_active_highest(local, None)


def advance_highest(local, sequence, release_id, rollback=False):
    highest = highest_release(local)
    if highest:
        if sequence == highest["sequence"] and release_id != highest["release"]:
            raise ValueError("A release sequence cannot be reused for different content")
        if sequence < highest["sequence"]:
            if rollback:
                return
            raise ValueError("Release sequence rollback refused; use explicit local rollback")
    atomic(local / "highest.json", json.dumps({"sequence": sequence, "release": release_id}))


def stage(local):
    spack_managed_memory_mib()
    spack_install_timeout_ms()
    incoming = private_dir(local / "incoming")
    base = required("SERVER_HTTP_URL").rstrip("/") + "/api"
    channel = os.environ.get("KQ_RELEASE_CHANNEL", "stable")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", channel):
        raise ValueError("Invalid release channel")
    fetch(f"{base}/site-releases/{channel}/manifest.json", incoming / "manifest.json")
    raw = (incoming / "manifest.json").read_bytes()
    if len(raw) > 128 * 1024:
        raise ValueError("Release manifest too large")
    release_id = hashlib.sha256(raw).hexdigest()
    release = private_dir(local / "releases" / release_id)
    url = f"{base}/site-releases/releases/{release_id}"
    fetch(url + "/manifest.sig", incoming / "manifest.sig")
    atomic(incoming / "release-key.pem", required("KQ_RELEASE_PUBLIC_KEY_PEM"))
    run(["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", incoming / "release-key.pem", "-rawin", "-in", incoming / "manifest.json", "-sigfile", incoming / "manifest.sig"], stdout=subprocess.DEVNULL)
    manifest = json.loads(raw)
    validate_manifest(manifest)
    highest = highest_release(local)
    if highest and (manifest["sequence"] < highest["sequence"] or (manifest["sequence"] == highest["sequence"] and release_id != highest["release"])):
        raise ValueError("Release high-water check refused; use explicit local rollback")
    fetch(base + "/agent-binaries", incoming / "server.json")
    if json.loads((incoming / "server.json").read_text())["revision"] != manifest["serverRevision"]:
        raise ValueError("Site release and deployed Server revisions differ")
    for item in manifest["files"]:
        target = release / item["name"]
        fetch(url + "/" + item["name"], target, item["size"], item["sha256"])
        target.chmod(0o500 if item["executable"] else 0o400)
    atomic(release / "manifest.json", raw, 0o400)
    if os.environ.get("KQ_ENABLE_SPACK") == "1":
        preflight_spack_release(release, Path(required("KQ_SHARED")), require_capabilities=False)
    advance_highest(local, manifest["sequence"], release_id)
    atomic(local / "staged", release_id + "\n")
    status(local, "staged", release=release_id)
    return release


def status(local, phase, **fields):
    atomic(local / "status.json", json.dumps({"phase": phase, "time": int(time.time()), **fields}, ensure_ascii=False) + "\n")


def record_failure(local, error):
    inspect_directory(local)
    if local.is_dir() and ((local / "status.json").exists() or (local / "bootstrap.lock").exists()):
        current = local / "current"
        active = current.resolve().name if current.is_symlink() else None
        status(local, "failed", reason="command_failed" if isinstance(error, subprocess.CalledProcessError) else "validation_failed", release=active, activeRelease=active)


def role(release, name):
    manifest = json.loads((release / "manifest.json").read_text())
    matches = [item for item in manifest["files"] if item["role"] == name]
    if len(matches) != 1:
        raise ValueError(f"Release requires one {name} artifact")
    return release / matches[0]["name"]


def preflight_spack_release(release, shared, require_capabilities=True):
    # Fail before consuming a one-time token or changing the active configuration.
    runtime, profile, entrypoint = (role(release, name) for name in ("runtime-sif", "site-profile", "spack"))
    manifest = json.loads((release / "manifest.json").read_text())
    runtime_digest = next(item["sha256"] for item in manifest["files"] if item["role"] == "runtime-sif")
    if require_capabilities:
        managed_capability_preflight(runtime_digest, manifest)
    if not profile.is_file() or not 0 < profile.stat().st_size <= 128 * 1024:
        raise ValueError("Spack site profile must be a bounded JSON file")
    site = json.loads(profile.read_text())
    # stage/activate already verifies artifact bytes; compare the signed binding without rehashing a large SIF.
    if not isinstance(site, dict) or site.get("version") != 1 or site.get("runtimeSifSha256") != runtime_digest:
        raise ValueError("Spack site profile does not bind the published runtime SIF")
    store = site.get("storeRoot")
    if not isinstance(store, str) or not re.fullmatch(r"/[A-Za-z0-9_+./-]+", store):
        raise ValueError("Spack storeRoot must be a canonical shared installation path")
    path = Path(store)
    if path == shared or path.resolve() != path or not path.is_relative_to(shared) or store.endswith("/") or any(part in ("", ".", "..") for part in store.split("/")[1:]):
        raise ValueError("Spack storeRoot must be strictly within KQ_SHARED without symlinks")
    for reserved in ("jobs", "datasets", "licensed-materials", "sandbox", "materials", "releases", "helpers"):
        root = shared / reserved
        if path == root or path.is_relative_to(root):
            raise ValueError("Spack storeRoot overlaps a managed data directory")
    target = site.get("target")
    if not isinstance(target, str) or not re.fullmatch(r"linux-[A-Za-z0-9_.-]+-[A-Za-z0-9_.-]+", target):
        raise ValueError("Spack site profile target must be a native Linux target")
    target_cpu = target.rsplit("-", 1)[1]
    if (target_cpu.startswith("x86_64") and platform.machine() != "x86_64") or (target_cpu in ("aarch64", "arm64") and platform.machine() != "aarch64"):
        raise ValueError("Spack site profile target architecture mismatch")
    if any(site.get(key) is not True for key in ("sharedStoreConfirmed", "compatibleComputeNodesConfirmed", "trustedRecipesConfirmed", "quotaEnforcedBySite")):
        raise ValueError("Spack site capabilities must be explicitly confirmed by the platform")
    if not isinstance(site.get("osReleaseSha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", site["osReleaseSha256"]) or not isinstance(site.get("hostFiles"), list) or not site["hostFiles"] or not isinstance(site.get("externals"), list):
        raise ValueError("Spack site profile lacks pinned host and external declarations")
    if not runtime.is_file() or not os.access(entrypoint, os.X_OK):
        raise ValueError("Spack release requires a runtime SIF and executable Spack entrypoint")
    return site


def check_workers():
    terminal = {"COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL", "PREEMPTED", "BOOT_FAIL", "DEADLINE"}
    cache = Path(required("KQ_SHARED")) / "materials"
    for kind in ("audits", "installs"):
        for journal in (cache / kind).glob("run-*/slurm.json"):
            state = json.loads(journal.read_text())
            job_id = str(state.get("jobId", ""))
            if not re.fullmatch(r"[0-9]+", job_id):
                raise ValueError(f"Uncertain Slurm submission; reconcile {journal} before activation")
            uncertain = f"Slurm worker still active or unknown; reconcile {journal} before activation"
            try:
                queue = run(["squeue", "--noheader", "--me", "--format=%i|%j"], capture_output=True, text=True, timeout=5)
                for line in queue.stdout.splitlines():
                    fields = line.strip().split("|")
                    if len(fields) != 2 or fields[0] == job_id or (state.get("name") and fields[1] == state["name"]):
                        raise ValueError(uncertain)
                try:
                    controller = run(["scontrol", "show", "job", job_id, "--oneliner"], capture_output=True, text=True, timeout=5)
                except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    controller = None
                if controller is not None and controller.stdout.strip():
                    fields = controller.stdout.split()
                    ids = [field for field in fields if field.startswith("JobId=")]
                    names = [field for field in fields if field.startswith("JobName=")]
                    phases = [field for field in fields if field.startswith("JobState=")]
                    requeues = [field for field in fields if field.startswith("Requeue=")]
                    if not state.get("name") or ids != ["JobId=" + job_id] or names != ["JobName=" + state["name"]] or len(phases) != 1 or phases[0][9:] not in terminal or requeues != ["Requeue=0"]:
                        raise ValueError(uncertain)
                    continue
                # A durable terminal record for a --no-requeue job survives controller/accounting expiry.
                if state.get("noRequeue") is True and state.get("phase") in terminal:
                    continue
                result = run(["sacct", "-n", "-P", "-X", "-j", job_id, "--format=JobIDRaw,State%64"], capture_output=True, text=True, timeout=5)
                states = [row.split("|")[1].split()[0].split("+")[0] for row in result.stdout.splitlines() if row.startswith(job_id + "|") and len(row.split("|")) > 1 and row.split("|")[1].strip()]
                if len(states) != 1 or states[0] not in terminal or state.get("noRequeue") is not True:
                    raise ValueError(uncertain)
            except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
                raise ValueError(uncertain) from error


def switch_release(local, release, rollback, configure=None):
    current = local / "current"
    same_release = current.exists() and current.resolve() == release
    changes = ["current"]
    if current.exists() and not same_release:
        changes.append("previous")
    changes.append("status.json")
    with tempfile.TemporaryDirectory(prefix=".activate-", dir=local) as directory:
        transaction = Path(directory)
        before, after = transaction / "before", transaction / "after"
        before.mkdir(mode=0o700)
        after.mkdir(mode=0o700)
        for name in changes:
            path = local / name
            if path.is_symlink():
                (before / name).symlink_to(os.readlink(path))
            elif path.exists():
                atomic(before / name, path.read_bytes())
        configuration_backups = []
        if configure:
            paths = [local / "run-agent.sh"]
            if same_release:
                paths.append(release / "agent.env")
            for index, path in enumerate(paths):
                backup = before / ("configuration-" + str(index))
                if path.exists():
                    atomic(backup, path.read_bytes(), path.stat().st_mode & 0o777)
                configuration_backups.append((path, backup))
        (after / "current").symlink_to(release)
        if "previous" in changes:
            atomic(after / "previous", current.resolve().name + "\n")
        atomic(after / "status.json", json.dumps({"phase": "rolled-back" if rollback else "activated", "time": int(time.time()), "release": release.name}) + "\n")
        sync_directory(before)
        sync_directory(after)
        committed = []
        try:
            if configure:
                configure()
            for name in changes:
                os.replace(after / name, local / name)
                committed.append(name)
            sync_directory(local)
        except Exception:
            for name in reversed(committed):
                backup = before / name
                if backup.is_symlink() or backup.exists():
                    os.replace(backup, local / name)
                else:
                    (local / name).unlink(missing_ok=True)
            for path, backup in configuration_backups:
                if backup.exists():
                    os.replace(backup, path)
                else:
                    path.unlink(missing_ok=True)
                sync_directory(path.parent)
            sync_directory(local)
            raise


def verify_release(release):
    if re.fullmatch(r"[a-f0-9]{64}", release.name) and sha(release / "manifest.json") != release.name:
        raise ValueError("Staged manifest changed")
    manifest = json.loads((release / "manifest.json").read_text())
    for item in manifest["files"]:
        if sha(release / item["name"]) != item["sha256"]:
            raise ValueError("Staged artifact changed")
    return manifest


def activate(local, release, rollback=False, configure=None):
    spack_managed_memory_mib()
    spack_install_timeout_ms()
    manifest = verify_release(release)
    current = local / "current"
    if current.is_symlink() and not current.exists():
        raise ValueError("Current release pointer is broken; reconcile before activation")
    same_release = current.exists() and current.resolve() == release
    if same_release and (configure is None or os.environ.get("KQ_MAINTENANCE_WINDOW") != "1"):
        return
    if current.exists():
        if os.environ.get("KQ_MAINTENANCE_WINDOW") != "1":
            raise ValueError("Activation requires KQ_MAINTENANCE_WINDOW=1; current release remains active")
        previous = json.loads((current / "manifest.json").read_text())
        if previous["stateFormat"] != manifest["stateFormat"]:
            raise ValueError("State format migration requires a separately reviewed migration; binary switch refused")
        # Service must be stopped, and the same lock as ExecStart proves there is no Agent writer.
        lock = open(local / "state" / "agent.lock", "a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            check_workers()
        except Exception:
            lock.close()
            raise
    else:
        lock = None
    try:
        if re.fullmatch(r"[a-f0-9]{64}", release.name):
            advance_highest(local, manifest["sequence"], release.name, rollback)
        switch_release(local, release, rollback, configure)
    finally:
        if lock:
            lock.close()


def registration_config(registration_dir):
    env_file = registration_dir / "agent.env"
    if env_file.is_symlink() or not env_file.is_file() or not 0 < env_file.stat().st_size <= 131072:
        raise ValueError("Registration identity configuration is incomplete; reconcile before retry")
    config = {}
    for line in (registration_dir / "agent.env").read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError("Registration configuration is incomplete; reconcile before retry")
        key, value = line.split("=", 1)
        if key in config or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise ValueError("Invalid registration configuration key")
        config[key] = json.loads(value)
        if not isinstance(config[key], str):
            raise ValueError("Invalid registration configuration value")
    needed = ("SERVER_HTTP_URL", "SERVER_GRPC_URL", "AGENT_ID", "AGENT_SITE_NAME", "AGENT_MTLS_REQUIRED", "AGENT_CERT_DIR", "AGENT_DB_PATH")
    if any(not config.get(key) for key in needed) or config["AGENT_MTLS_REQUIRED"] != "true":
        raise ValueError("Registration identity configuration is incomplete; reconcile before retry")
    origin(config["SERVER_HTTP_URL"])
    origin(config["SERVER_GRPC_URL"])
    certs = registration_dir / "certs"
    if config["AGENT_CERT_DIR"] != str(certs):
        raise ValueError("Registration certificate directory differs; reconcile before retry")
    for name in ("client.crt", "client.key", "ca.crt"):
        path = certs / name
        if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 131072:
            raise ValueError("Registration certificate bundle is incomplete; reconcile before retry")
    run(["openssl", "x509", "-in", certs / "client.crt", "-noout", "-checkend", "0"], capture_output=True)
    run(["openssl", "verify", "-CAfile", certs / "ca.crt", certs / "client.crt"], capture_output=True)
    subject = run(["openssl", "x509", "-in", certs / "client.crt", "-noout", "-subject", "-nameopt", "sep_multiline,sname,utf8,-esc_2253,-esc_msb"], capture_output=True, text=True).stdout
    common_names = [line.lstrip()[3:] for line in subject.splitlines() if line.lstrip().startswith("CN=")]
    if common_names != [config["AGENT_ID"]]:
        raise ValueError("Registration certificate identity differs; reconcile before retry")
    public_cert = run(["openssl", "x509", "-in", certs / "client.crt", "-pubkey", "-noout"], capture_output=True).stdout
    public_key = run(["openssl", "pkey", "-in", certs / "client.key", "-passin", "pass:", "-pubout"], capture_output=True).stdout
    if public_cert != public_key:
        raise ValueError("Registration certificate and private key differ; reconcile before retry")
    return config


def spack_managed_memory_mib():
    if os.environ.get("KQ_ENABLE_SPACK") != "1":
        return None
    value = os.environ.get("KQ_SPACK_MANAGED_MEMORY_MIB", "4096")
    if not re.fullmatch(r"[0-9]+", value) or not 1024 <= int(value) <= 1048576:
        raise ValueError("KQ_SPACK_MANAGED_MEMORY_MIB must be an integer from 1024 to 1048576")
    return str(int(value))


def login_persistence_checks():
    checks = {"stateRetention": "passed" if os.environ.get("KQ_LOCAL_RETENTION_CONFIRMED") == "1" else "not-tested"}
    for label, args, accepted in (
        ("userManager", ["systemctl", "--user", "is-system-running"], {"running", "degraded"}),
        ("linger", ["loginctl", "show-user", str(os.getuid()), "-p", "Linger", "--value"], {"yes"}),
    ):
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=5)
            successful = result.returncode == 0 or (label == "userManager" and result.returncode == 1 and result.stdout.strip() == "degraded")
            checks[label] = "passed" if successful and result.stdout.strip() in accepted else "failed"
        except (OSError, subprocess.TimeoutExpired):
            checks[label] = "not-tested"
    checks["longRunningProcess"] = "passed" if os.environ.get("KQ_APPROVED_SUPERVISOR_CONFIRMED") == "1" or (checks["userManager"] == checks["linger"] == "passed") else "not-tested"
    return checks


def managed_capability_preflight(runtime_digest, compatibility=None):
    checks = login_persistence_checks()
    if checks["stateRetention"] != "passed" or checks["longRunningProcess"] != "passed":
        raise ValueError("Managed install requires confirmed local disk retention and approved long-running process conditions")
    filename = os.environ.get("KQ_COMPUTE_INVENTORY_FILE", "")
    try:
        path = Path(filename)
        if not filename or not path.is_absolute() or not path.is_file() or not 0 < path.stat().st_size <= 131072:
            raise ValueError("inventory")
        inventory = json.loads(path.read_text())
        capabilities = inventory["managedCapabilities"]
        if compatibility is not None:
            libc = inventory["libc"]
            if inventory["arch"] != compatibility["architecture"] or libc["name"] != "glibc" or not re.fullmatch(r"[0-9]+\.[0-9]+(?:\.[0-9]+){0,2}", libc["version"]):
                raise ValueError("compute ABI")
            if tuple(map(int, libc["version"].split("."))) < tuple(map(int, compatibility["minGlibc"].split("."))) or not set(compatibility["cpuFlags"]).issubset(inventory["cpu"]["supportedFlags"]):
                raise ValueError("compute compatibility")
        observed = capabilities["observedAt"]
        budget = int(spack_managed_memory_mib())
        limit = os.environ.get("KQ_SLURM_MEMORY_LIMIT_MIB", "")
        if not re.fullmatch(r"[0-9]{1,7}", limit) or not 2560 <= int(limit) <= 1049088:
            raise ValueError("Slurm memory limit")
        if max(2048, budget) + 512 > int(limit):
            raise ValueError("Slurm reservation exceeds site limit")
        minimum = os.environ.get("KQ_SPACK_SCRATCH_MIN_MIB", "20480")
        if not re.fullmatch(r"[0-9]{1,7}", minimum) or not 1 <= int(minimum) <= 1048576:
            raise ValueError("scratch minimum")
        if inventory.get("kind") != "kq-compute-inventory" or inventory.get("ok") is not True or type(observed) is not int or not 0 <= time.time() - observed <= 86400:
            raise ValueError("expired inventory")
        if capabilities["partition"] != os.environ.get("KQ_PARTITION", "cn") or capabilities["runtimeSifSha256"] != runtime_digest or type(capabilities["memoryMib"]) is not int or capabilities["memoryMib"] != budget:
            raise ValueError("inventory binding")
        if any(capabilities[name]["status"] != "passed" for name in ("abi", "userManager", "scratch", "isolation")):
            raise ValueError("unproven compute capability")
        available = capabilities["scratch"].get("availableMib")
        if type(available) is not int or available < int(minimum):
            raise ValueError("scratch capacity")
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        raise ValueError("Managed install requires fresh passed compute inventory bound to partition, runtime, memory and scratch budget; failed/not-tested blocks installation") from None


def spack_install_timeout_ms():
    if os.environ.get("KQ_ENABLE_SPACK") != "1":
        return None
    value = os.environ.get("KQ_SPACK_INSTALL_TIMEOUT_MS", "21600000")
    if not re.fullmatch(r"[0-9]+", value) or not 60000 <= int(value) <= 86400000:
        raise ValueError("KQ_SPACK_INSTALL_TIMEOUT_MS must be an integer from 60000 to 86400000")
    return str(int(value))


def registration(local, shared, release):
    managed_memory = spack_managed_memory_mib()
    install_timeout = spack_install_timeout_ms()
    if os.environ.get("KQ_ENABLE_SPACK") == "1":
        preflight_spack_release(release, shared)
    install_helpers(shared)
    registration_dir = private_dir(local / "registration")
    if not (registration_dir / "agent.env").exists():
        if (registration_dir / "pending").exists():
            raise ValueError("Previous registration outcome is uncertain; reconcile token/Agent identity before retry")
        token_file = os.environ.get("KQ_REGISTRATION_TOKEN_FILE")
        if token_file == "-":
            descriptor = 3 if os.environ.get("KQ_BOOTSTRAP_STDIN_FD") == "3" else 0
            with os.fdopen(os.dup(descriptor)) as source:
                token = source.read(16386).strip()
        elif token_file:
            with open(token_file) as source:
                token = source.read(16386).strip()
        else:
            print("输入一次性注册 token（不回显）", flush=True)
            import getpass
            token = getpass.getpass("")
        if not token or len(token) > 16384:
            raise ValueError("Invalid registration token")
        atomic(registration_dir / "pending", "Registration started; do not allocate a second Agent automatically\n")
        run([role(release, "cli"), "agent", "register", "--url", required("SERVER_HTTP_URL"), "--grpc-url", required("SERVER_GRPC_URL"), "--scheduler", "slurm", "--output-dir", registration_dir, "--token-file", "-"], input=(token + "\n").encode())
    config = registration_config(registration_dir)
    if (registration_dir / "pending").exists():
        (registration_dir / "pending").unlink()
    config.update({"SERVER_HTTP_URL": required("SERVER_HTTP_URL"), "SERVER_GRPC_URL": required("SERVER_GRPC_URL"),
        "AGENT_DB_PATH": str(local / "state" / "agent.db"), "AGENT_SPAWNER_BACKEND": "host",
        "AGENT_JOB_WORK_ROOT": str(shared / "jobs"), "AGENT_DATASET_ROOT": str(shared / "datasets"),
        "AGENT_LICENSED_MATERIAL_ROOT": str(shared / "licensed-materials"), "AGENT_SANDBOX_ROOT": str(shared / "sandbox"),
        "AGENT_SPACK_CACHE_DIR": str(shared / "materials"), "AGENT_SPACK_ENABLED": "false", "AGENT_SPACK_AUDIT_ENABLED": "false", "AGENT_SPACK_INSTALL_ENABLED": "false",
        "AGENT_FILE_TRANSFER_CONNECT_TO": "", "AGENT_SSH_ENABLED": "false", "PATH": os.environ["PATH"]})
    if os.environ.get("KQ_ENABLE_SPACK") == "1":
        runtime = role(release, "runtime-sif")
        # Runtime and profile must be visible on compute nodes. Copy verified, immutable artifacts.
        shared_release = private_dir(shared / "releases" / release.name)
        for source in (runtime, role(release, "site-profile"), role(release, "spack")):
            destination = shared_release / source.name
            atomic_copy(source, destination)
        apptainer = Path(shutil.which("apptainer") or required("KQ_APPTAINER_PATH")).resolve()
        profile = shared_release / role(release, "site-profile").name
        site = json.loads(profile.read_text())
        if not Path(site["storeRoot"]).is_relative_to(shared):
            raise ValueError("Published site profile storeRoot must be within KQ_SHARED")
        config.update({"AGENT_SPACK_ENABLED": "true", "AGENT_SPACK_AUDIT_ENABLED": "true", "AGENT_SPACK_INSTALL_ENABLED": "true", "AGENT_SPACK_MANAGED_MEMORY_MIB": managed_memory, "AGENT_SPACK_SLURM_MEMORY_LIMIT_MIB": os.environ.get("KQ_SLURM_MEMORY_LIMIT_MIB", ""), "AGENT_SPACK_INSTALL_TIMEOUT_MS": install_timeout, "AGENT_SPACK_TRUST_MODE": "single-user", "AGENT_SPACK_EXECUTOR": "slurm", "AGENT_SLURM_BIN_DIR": str(Path(shutil.which("sbatch")).parent), "AGENT_SPACK_BUILD_ACCOUNT": os.environ.get("KQ_ACCOUNT", ""), "AGENT_SPACK_BUILD_QOS": os.environ.get("KQ_QOS", ""), "AGENT_SPACK_BUILD_PARTITION": os.environ.get("KQ_PARTITION", "cn"), "AGENT_SPACK_PATH": str(shared_release / role(release, "spack").name), "AGENT_SPACK_AUDIT_APPTAINER_PATH": str(apptainer), "AGENT_SPACK_AUDIT_APPTAINER_SHA256": sha(apptainer), "AGENT_SPACK_AUDIT_SIF_PATH": str(shared_release / runtime.name), "AGENT_SPACK_AUDIT_SIF_SHA256": sha(runtime), "AGENT_SPACK_INSTALL_SITE_PROFILE_PATH": str(profile), "AGENT_SPACK_INSTALL_SITE_PROFILE_SHA256": sha(profile)})
    for key in ("KQ_TRANSPORT_MODE", "KQ_ALLOWED_ORIGINS", "KQ_FORWARD_MAP", "KQ_HTTP_PROXY_URL", "KQ_TLS_CA_FILE", "KQ_MODULE_INIT", "KQ_PYTHON_MODULE", "KQ_APPTAINER_MODULE"):
        config[key] = os.environ.get(key, "")
    if os.environ.get("KQ_ACCOUNT"):
        config["SBATCH_ACCOUNT"] = required("KQ_ACCOUNT")
    if os.environ.get("KQ_QOS"):
        config["SBATCH_QOS"] = required("KQ_QOS")
    # A shell launcher and systemd both consume this generated file through Bash.
    config["KQ_AGENT_EXECUTABLE"] = str(role(release, "agent"))
    atomic(release / "agent.env", "".join(f"export {key}={shlex.quote(value)}\n" for key, value in config.items()))
    atomic(local / "run-agent.sh", f"""#!/bin/bash
set -euo pipefail
exec 9>{shlex.quote(str(local / 'state' / 'agent.lock'))}
flock -n -E 75 9 || exit $?
[[ ! -f {shlex.quote(str(local / 'restore-intent.json'))} ]] || {{ echo 'Interrupted state restore requires reconciliation' >&2; exit 75; }}
KQ_MODULE_INIT= KQ_PYTHON_MODULE= KQ_APPTAINER_MODULE=
source {shlex.quote(str(local / 'current' / 'agent.env'))}
if [[ -n $KQ_PYTHON_MODULE$KQ_APPTAINER_MODULE ]]; then
  set +u
  if [[ -n $KQ_MODULE_INIT ]]; then source "$KQ_MODULE_INIT"; fi
  type module >/dev/null 2>&1 || {{ echo 'Configured Agent modules require the module command' >&2; exit 1; }}
  if [[ -n $KQ_PYTHON_MODULE ]]; then module load "$KQ_PYTHON_MODULE"; fi
  if [[ -n $KQ_APPTAINER_MODULE ]]; then module load "$KQ_APPTAINER_MODULE"; fi
  set -u
fi
exec "$KQ_AGENT_EXECUTABLE"
""", 0o700)


def rollback_configuration(local, release):
    path = release / "agent.env"
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 131072:
        raise ValueError("Previous release configuration is missing; reconcile before rollback")
    tokens = shlex.split(path.read_text())
    config = {}
    if len(tokens) % 2:
        raise ValueError("Invalid saved release configuration")
    for index in range(0, len(tokens), 2):
        if tokens[index] != "export" or "=" not in tokens[index + 1]:
            raise ValueError("Invalid saved release configuration")
        key, value = tokens[index + 1].split("=", 1)
        if key in config or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise ValueError("Invalid saved release configuration")
        config[key] = value
    identity = registration_config(local / "registration")
    for key in ("AGENT_ID", "AGENT_CERT_DIR", "AGENT_MTLS_REQUIRED"):
        if config.get(key) != identity[key]:
            raise ValueError("Saved release identity differs; reconcile before rollback")
    if config.get("KQ_AGENT_EXECUTABLE") != str(role(release, "agent")) or config.get("AGENT_DB_PATH") != str(local / "state" / "agent.db"):
        raise ValueError("Saved release entrypoint or state path differs")
    for key in ("SERVER_HTTP_URL", "SERVER_GRPC_URL"):
        origin(config.get(key, ""))


def services(local):
    hostname = socket.gethostname()
    # systemd interprets 32 hex digits as a machine ID rather than a hostname.
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?", hostname) or re.fullmatch(r"[a-fA-F0-9]{32}", hostname):
        raise ValueError("Local hostname cannot be safely bound with systemd ConditionHost")
    if not shutil.which("systemctl"):
        raise ValueError("No user systemd; run the generated launcher under the site's approved supervisor")
    current = local / "current"
    if not current.is_symlink() or not current.exists() or current.resolve().parent != local / "releases":
        raise ValueError("Install and activate a verified release before enabling services")
    verify_release(current.resolve())
    rollback_configuration(local, current.resolve())
    units = Path.home() / ".config" / "systemd" / "user"
    units.mkdir(parents=True, exist_ok=True)
    if units.is_symlink() or units.stat().st_uid != os.getuid() or units.stat().st_mode & 0o022:
        raise ValueError("User service directory must be user-owned and not writable by others")
    bootstrap = Path(required("KQ_BOOTSTRAP_SCRIPT"))
    env = Path(required("KQ_SITE_ENV"))
    def unit_arg(value):
        if any(c in str(value) for c in '\n\r%'):
            raise ValueError("Unsupported systemd path")
        return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"') + '"'
    tunnel_command = " ".join(unit_arg(item) for item in ssh_args())
    atomic(units / "kq-tunnel.service", f"[Unit]\nDescription=KQ site SSH tunnel\nConditionHost={hostname}\n[Service]\nExecStart={tunnel_command}\nRestart=on-failure\nRestartSec=10\nUMask=0077\n[Install]\nWantedBy=default.target\n")
    atomic(units / "kq-agent.service", f"[Unit]\nDescription=KQ site Agent\nConditionHost={hostname}\nWants=kq-tunnel.service\nAfter=kq-tunnel.service\n[Service]\nExecStart=/bin/bash {unit_arg(local / 'run-agent.sh')}\nRestart=on-failure\nRestartPreventExitStatus=75\nRestartSec=10\nUMask=0077\n[Install]\nWantedBy=default.target\n")
    atomic(units / "kq-update.service", f"[Unit]\nDescription=Stage verified KQ updates\nConditionHost={hostname}\nWants=kq-tunnel.service\nAfter=kq-tunnel.service\n[Service]\nEnvironment=KQ_REUSE_TUNNEL=1\nExecStart=/bin/bash {unit_arg(bootstrap)} {unit_arg(env)} stage\nSuccessExitStatus=75\nUMask=0077\n")
    atomic(units / "kq-update.timer", f"[Unit]\nDescription=Check KQ releases every six hours\nConditionHost={hostname}\n[Timer]\nOnBootSec=10min\nOnUnitActiveSec=6h\nRandomizedDelaySec=30min\nPersistent=true\n[Install]\nWantedBy=timers.target\n")
    retention = os.environ.get("KQ_AUTOMATIC_GC", "0")
    if retention not in ("0", "1"):
        raise ValueError("KQ_AUTOMATIC_GC must be 0 or 1")
    if retention == "1":
        atomic(units / "kq-retention.service", f"[Unit]\nDescription=Apply KQ retention only while idle\nConditionHost={hostname}\n[Service]\nExecStart=/bin/bash {unit_arg(bootstrap)} {unit_arg(env)} maintain auto\nUMask=0077\n")
        atomic(units / "kq-retention.timer", f"[Unit]\nDescription=Daily KQ site retention\nConditionHost={hostname}\n[Timer]\nOnBootSec=30min\nOnUnitActiveSec=24h\nRandomizedDelaySec=1h\nPersistent=true\n[Install]\nWantedBy=timers.target\n")
    run(["systemctl", "--user", "daemon-reload"])
    run(["systemctl", "--user", "enable", "--now", "kq-tunnel.service", "kq-agent.service", "kq-update.timer"])
    if retention == "1":
        run(["systemctl", "--user", "enable", "--now", "kq-retention.timer"])
        run(["systemctl", "--user", "is-active", "--quiet", "kq-retention.timer"], capture_output=True)
    elif (units / "kq-retention.timer").exists():
        run(["systemctl", "--user", "disable", "--now", "kq-retention.timer"])
    for unit in ("kq-tunnel.service", "kq-agent.service", "kq-update.timer"):
        run(["systemctl", "--user", "is-active", "--quiet", unit], capture_output=True)
    print("检查 loginctl show-user \"$USER\" -p Linger；未启用时不保证退出登录后常驻。")


def doctor(local, release):
    args = [role(release, "cli"), "site", "doctor", "--url", required("SERVER_HTTP_URL"), "--grpc-url", required("SERVER_GRPC_URL"), "--json"]
    token_file = os.environ.get("KQ_DOCTOR_TOKEN_FILE")
    if token_file:
        args += ["--token-file", token_file]
    fixtures = os.environ.get("KQ_DOCTOR_FIXTURES_FILE")
    if fixtures:
        args += ["--fixtures", fixtures]
    certs = local / "registration" / "certs"
    if certs.is_dir():
        registration_config(local / "registration")
        args += ["--cert-dir", certs]
    result = subprocess.run([str(arg) for arg in args], capture_output=True)
    if result.stdout:
        atomic(local / "doctor.json", result.stdout)
        sys.stdout.buffer.write(result.stdout)
    if result.returncode:
        raise ValueError("分通道诊断未全部通过；检查 doctor.json，未测试不等于成功")


def validate_state_storage(local, ancestor, shared):
    for root in (Path.home().resolve(), shared, Path("/tmp"), Path("/var/tmp"), Path("/run"), Path("/dev/shm")):
        if local == root or local.is_relative_to(root):
            raise ValueError("KQ_LOCAL must be outside HOME, shared data and temporary directories")
    result = run(["findmnt", "-n", "-o", "FSTYPE,OPTIONS", "-T", ancestor], capture_output=True, text=True, timeout=5)
    fields = result.stdout.strip().split()
    if len(fields) != 2 or fields[0] not in ("ext4", "xfs", "btrfs", "zfs") or "rw" not in fields[1].split(",") or "ro" in fields[1].split(","):
        raise ValueError("KQ_LOCAL needs a writable local filesystem; network, temporary, read-only or unknown mount refused")


def slurm_recovery_conditions():
    expected = os.environ.get("KQ_RECOVERY_WINDOW_SEC", "86400")
    if not re.fullmatch(r"[0-9]{1,7}", expected) or not 60 <= int(expected) <= 604800:
        raise ValueError("KQ_RECOVERY_WINDOW_SEC must be an integer from 60 to 604800")
    report = {"kind": "kq-slurm-recovery-conditions", "status": "not-tested", "expectedWindowSec": int(expected), "accounting": "not-tested", "controllerWindowSec": None}
    try:
        result = subprocess.run(["scontrol", "show", "config"], capture_output=True, text=True, timeout=5)
        if result.returncode != 0:
            return report
        config = {}
        for line in result.stdout[:1024 * 1024].splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip() in ("MinJobAge", "AccountingStorageType"):
                config[key.strip()] = value.strip()
        age = config.get("MinJobAge", "")
        if re.fullmatch(r"[0-9]{1,10}", age):
            report["controllerWindowSec"] = int(age)
        backend = config.get("AccountingStorageType", "")
        if backend in ("accounting_storage/none", "(null)"):
            report["accounting"] = "failed"
        elif backend:
            accounting = subprocess.run(["sacct", "--noheader", "--allocations", "--user", str(os.getuid()), "--starttime", "now-1hours", "--endtime", "now", "--format=JobIDRaw"], capture_output=True, text=True, timeout=5)
            report["accounting"] = "passed" if accounting.returncode == 0 else "failed"
        # sacct success cannot prove accounting retention or uninterrupted service.
        report["status"] = "conditional" if report["accounting"] == "passed" else "passed" if report["controllerWindowSec"] is not None and report["controllerWindowSec"] >= int(expected) else "degraded"
    except (OSError, subprocess.TimeoutExpired):
        pass
    return report


def readonly_site_checks():
    partition = os.environ.get("KQ_PARTITION", "cn")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", partition):
        raise ValueError("Invalid Slurm partition name")
    try:
        result = run(["sinfo", "--noheader", "--partition", partition, "--format=%P|%a"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        raise ValueError("Slurm partition check failed or timed out; no jobs were submitted")
    states = [row.split("|")[1].strip().lower() for row in result.stdout.splitlines() if len(row.split("|")) == 2 and row.split("|")[0].strip().rstrip("*") == partition]
    if not states or any(state != "up" for state in states):
        raise ValueError("Configured Slurm partition is missing or not UP; no jobs were submitted")
    print("state-mount: passed (local writable mount; retention policy still requires site confirmation)")
    print("slurm-partition: passed (exists and UP; account/QoS and compute-node execution remain untested)")
    print("python-runtime: passed (Python >= 3.9)")
    print("python-module: " + os.environ.get("KQ_PYTHON_MODULE_STATUS", "not-tested"))
    apptainer = os.environ.get("KQ_APPTAINER_MODULE_STATUS", "not-tested")
    if os.environ.get("KQ_ENABLE_SPACK") == "1":
        executable = shutil.which("apptainer") or os.environ.get("KQ_APPTAINER_PATH")
        if not executable:
            raise ValueError("Spack requires an available Apptainer executable")
        run([executable, "--version"], capture_output=True, text=True, timeout=5)
        apptainer = "passed"
    print("apptainer-module: " + apptainer + " (required only when Spack is enabled)")
    persistence = login_persistence_checks()
    print("user-systemd: " + persistence["userManager"])
    print("linger: " + persistence["linger"])
    print(json.dumps({"kind": "kq-login-capabilities", "checks": persistence}, sort_keys=True))
    print(json.dumps(slurm_recovery_conditions(), sort_keys=True))
    print("Login persistence requires linger or the site's approved supervisor; no service was started.")


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "check"
    if action == "prepare-capabilities":
        os.environ["KQ_ENABLE_SPACK"] = "0"
    if action != "maintain":
        spack_managed_memory_mib()
        spack_install_timeout_ms()
    if os.getuid() == 0:
        raise ValueError("Run bootstrap as the ordinary cluster user")
    if sys.version_info < (3, 9):
        raise ValueError("Python 3.9 or newer is required")
    if action == "maintain":
        maintenance_module()["main"](sys.argv[2:])
        return
    if action != "check":
        configure_transport()
    for tool in ("ssh", "curl", "openssl", "flock", "findmnt", "sinfo", "sbatch", "squeue", "sacct", "scontrol", "scancel"):
        if not shutil.which(tool):
            raise ValueError(f"Required site tool missing: {tool}")
    local, local_ancestor = inspect_directory(required("KQ_LOCAL"))
    shared, _ = inspect_directory(required("KQ_SHARED"))
    validate_state_storage(local, local_ancestor, shared)
    if action == "check":
        readonly_site_checks()
        print("本地只读预检完成；未连接云端或创建文件。未测试条件不表示已就绪。")
        return
    private_dir(local)
    private_dir(shared)
    for part in ("state", "releases", "incoming"):
        private_dir(local / part)
    for part in ("jobs", "datasets", "materials", "releases"):
        private_dir(shared / part)
    with (local / "bootstrap.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BootstrapBusy("Another bootstrap action is running; retry after it finishes")
        try:
            if action in ("install", "stage", "doctor", "prepare-capabilities"):
                with tunnel():
                    release = stage(local)
                    if action == "prepare-capabilities":
                        prepare_capabilities(local, shared, release)
                        return
                    if action == "doctor":
                        doctor(local, release)
                        return
                    if action == "install":
                        activate(local, release, configure=lambda: registration(local, shared, release))
                        doctor(local, release)
                print(f"已校验暂存 {release.name}。")
                if action == "install":
                    print(f"运行 bash {os.environ['KQ_BOOTSTRAP_SCRIPT']} {os.environ['KQ_SITE_ENV']} services 启用常驻与更新检查。")
            elif action in ("activate", "rollback"):
                marker = "staged" if action == "activate" else "previous"
                release_id = (local / marker).read_text().strip()
                if not re.fullmatch(r"[a-f0-9]{64}", release_id):
                    raise ValueError("Invalid local release pointer")
                release = local / "releases" / release_id
                configure = (lambda: rollback_configuration(local, release)) if action == "rollback" else (lambda: registration(local, shared, release))
                activate(local, release, action == "rollback", configure=configure)
                print("版本已切换；启动 Agent 后检查平台在线、作业对账与当前库存。")
            elif action == "services":
                services(local)
            else:
                raise ValueError("Expected check, doctor, install, stage, prepare-capabilities, activate, rollback, services or maintain")
        except Exception as error:
            record_failure(local, error)
            raise



if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # subprocess argv may contain download credentials; never print the exception command.
        message = "外部命令失败；检查隧道/服务日志" if isinstance(error, subprocess.CalledProcessError) else str(error)
        print(f"KQ 初始化失败: {message}", file=sys.stderr)
        sys.exit(75 if isinstance(error, BootstrapBusy) else 1)

KQ_BOOTSTRAP_PY

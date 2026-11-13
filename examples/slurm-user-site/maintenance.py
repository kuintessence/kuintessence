"""Private site capacity, retention and stopped-Agent SQLite recovery; standard library only."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import socket
import sqlite3
import stat
import subprocess
import tempfile
import time
import uuid
from urllib.parse import quote


def private(path, directory=False):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("Maintenance paths must be absolute and contain no symlinks")
    info = path.lstat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Maintenance data must be private and owned by the current user")
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError("Unexpected maintenance file type")
    return path


def digest(path):
    value = hashlib.sha256()
    with private(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def json_file(path):
    path = private(path)
    if path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Oversized maintenance metadata")
    return json.loads(path.read_text())


def write_json(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write((json.dumps(value, sort_keys=True) + "\n").encode())
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(temporary, path)
            sync(path.parent)
        finally:
            temporary.unlink(missing_ok=True)


def sync(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def capacity(path, reserve_bytes=0, reserve_inodes=128):
    path = Path(path)
    while not path.exists():
        path = path.parent
    info = os.statvfs(path)
    available = info.f_bavail * info.f_frsize
    inodes = info.f_favail
    result = {"freeBytes": available, "freeInodes": inodes,
              "requiredBytes": reserve_bytes, "requiredInodes": reserve_inodes,
              "passed": available >= reserve_bytes and (info.f_files == 0 or inodes >= reserve_inodes)}
    if not result["passed"]:
        raise ValueError("Site capacity reserve is insufficient (bytes or inodes)")
    return result


@contextlib.contextmanager
def stopped(local):
    private(local / "state", True)
    with contextlib.ExitStack() as stack:
        for relative in ("bootstrap.lock", "state/agent.lock"):
            path = local / relative
            if path.exists():
                private(path)
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            stream = stack.enter_context(os.fdopen(fd, "a"))
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("Agent or bootstrap is running; maintenance was not applied") from None
        yield


@contextlib.contextmanager
def connect(path):
    private(path)
    with contextlib.closing(sqlite3.connect("file:" + quote(str(path), safe="/") + "?mode=ro", uri=True)) as database:
        yield database


def checkpoint_database(path):
    private(path)
    with contextlib.closing(sqlite3.connect("file:" + quote(str(path), safe="/") + "?mode=rw", uri=True, timeout=0)) as database:
        result = database.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if not result or result[0] != 0 or result[1] != result[2]:
            raise ValueError("SQLite WAL is still in use; restore was not applied")
    with path.open("rb") as stream:
        os.fsync(stream.fileno())


def idle_database(path):
    with connect(path) as db:
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("SQLite integrity check failed")
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        checks = {
            "active_remote_jobs": "1", "job_cleanup_intents": "1",
            "inbound_dispatch_pending": "acked_at IS NULL",
            "outbound_job_status": "1", "outbound_software_operation_result": "1",
            "software_executions": "result IS NULL", "queued_operations": "1",
            "local_jobs": "status NOT IN ('completed','failed','cancelled')",
            "local_workflow_runs": "status NOT IN ('completed','failed','cancelled')",
        }
        for table, condition in checks.items():
            if table not in tables:
                raise ValueError("Unknown Agent schema; cannot prove maintenance is safe")
            if db.execute(f"SELECT 1 FROM {table} WHERE {condition} LIMIT 1").fetchone():
                raise ValueError("Agent has unfinished execution, cleanup or delivery records")


def idle_scheduler():
    result = subprocess.run(["squeue", "--noheader", "--me", "--format=%i"],
                            capture_output=True, text=True, timeout=5)
    if result.returncode != 0 or result.stdout.strip():
        raise ValueError("Scheduler is unavailable or the current user still has queued jobs")


def idle_workers(shared):
    terminal = {"COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL", "PREEMPTED", "BOOT_FAIL", "DEADLINE"}
    for kind in ("audits", "installs"):
        for journal in (shared / "materials" / kind).glob("run-*/slurm.json"):
            record = json_file(journal)
            if record.get("noRequeue") is not True or record.get("phase") not in terminal:
                raise ValueError("Build journal has no durable terminal proof; reconcile it before maintenance")


def protected_releases(local):
    protected = set()
    for name in ("current", "previous", "staged"):
        pointer = local / name
        if pointer.is_symlink():
            target = pointer.resolve()
            if target.parent != local / "releases":
                raise ValueError("Unexpected release pointer")
            protected.add(target.name)
        elif pointer.exists():
            protected.add(private(pointer).read_text().strip())
    for name in ("highest.json",):
        if (local / name).exists():
            protected.add(json_file(local / name)["release"])
    for backup in (local / "backups").glob("*/snapshot.json"):
        protected.add(json_file(backup)["release"])
    if any(not re.fullmatch(r"[a-f0-9]{64}", item) for item in protected):
        raise ValueError("Invalid release retention reference")
    return protected


def retention_plan(local, shared, days=30, now=None):
    if not 1 <= days <= 3650:
        raise ValueError("Retention must be between 1 and 3650 days")
    cutoff = (now or time.time()) - days * 86400
    protected = protected_releases(local)
    candidates = []
    # Transfer checkpoints, jobs and failed build journals are recovery evidence, never age-only GC.
    for base in (local / "releases", shared / "releases"):
        if not base.exists():
            continue
        private(base, True)
        for release in base.iterdir():
            if not re.fullmatch(r"[a-f0-9]{64}", release.name) or release.name in protected:
                continue
            private(release, True)
            entries = [release, *release.rglob("*")]
            infos = [private(p, p.is_dir()).stat() for p in entries]
            if any(info.st_mtime >= cutoff for info in infos):
                continue
            candidates.append({"path": str(release), "kind": "release", "bytes": sum(s.st_size for s in infos if stat.S_ISREG(s.st_mode)),
                               "device": infos[0].st_dev, "inode": infos[0].st_ino})
    cache = shared / "materials" / "sha256"
    if cache.exists():
        private(cache, True)
        for path in cache.iterdir():
            # Complete immutable blobs can be fetched again; retain partials and unknown files.
            if not re.fullmatch(r"[a-f0-9]{64}", path.name):
                continue
            private(path)
            info = path.stat()
            if info.st_mtime < cutoff:
                candidates.append({"path": str(path), "kind": "cached-blob", "bytes": info.st_size,
                                   "device": info.st_dev, "inode": info.st_ino})
    for kind in ("audits", "installs"):
        base = shared / "materials" / kind
        if not base.exists():
            continue
        private(base, True)
        for path in base.glob("run-*"):
            private(path, True)
            journal = path / "slurm.json"
            if not journal.exists():
                continue
            record = json_file(journal)
            if record.get("noRequeue") is not True or record.get("phase") not in {"FAILED", "CANCELLED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL", "BOOT_FAIL", "DEADLINE"}:
                continue
            entries = [path, *path.rglob("*")]
            infos = [private(p, p.is_dir()).stat() for p in entries]
            if any(info.st_mtime >= cutoff for info in infos):
                continue
            candidates.append({"path": str(path), "kind": "expired-failed-build", "journal": record,
                               "bytes": sum(s.st_size for s in infos if stat.S_ISREG(s.st_mode)),
                               "device": infos[0].st_dev, "inode": infos[0].st_ino})
    return {"version": 1, "retentionDays": days, "protectedReleases": sorted(protected),
            "candidates": candidates, "reclaimBytes": sum(p["bytes"] for p in candidates),
            "retained": ["state", "registration", "jobs", "partial-materials", "transfer-checkpoints", "unresolved-builds", "installed-prefixes", "backups"]}


def collect(local, shared, days=30, apply=False):
    if not apply:
        return retention_plan(local, shared, days)
    if os.environ.get("KQ_MAINTENANCE_WINDOW") != "1":
        raise ValueError("Applying retention requires KQ_MAINTENANCE_WINDOW=1")
    with stopped(local):
        idle_database(local / "state/agent.db")
        idle_scheduler()
        idle_workers(shared)
        plan = retention_plan(local, shared, days)
        receipts = local / "retention-receipts"
        receipts.mkdir(mode=0o700, exist_ok=True)
        private(receipts, True)
        receipt = receipts / (str(time.time_ns()) + "-" + secrets.token_hex(8) + ".json")
        record = {**plan, "startedAt": int(time.time()), "receipt": str(receipt)}
        write_json(receipt, record)
        write_json(local / "retention-pending.json", record)
        # Recompute under both writer locks; caller-provided paths or stale plans never authorize deletion.
        for item in plan["candidates"]:
            path = private(Path(item["path"]), item["kind"] != "cached-blob")
            info = path.stat()
            if (info.st_dev, info.st_ino) != (item["device"], item["inode"]):
                raise ValueError("Retention candidate changed")
            if item["kind"] != "cached-blob":
                shutil.rmtree(path)
            else:
                path.unlink()
            sync(path.parent)
        completed = {**record, "appliedAt": int(time.time())}
        write_json(receipt, completed)
        write_json(local / "retention-last.json", completed)
        (local / "retention-pending.json").unlink()
        return plan


def auto_collect(local, shared, days=30):
    if os.environ.get("KQ_AUTOMATIC_GC") != "1":
        return {"skipped": "automatic-retention-disabled"}
    # Both persistent work and in-memory transfers must be idle before stopping the control process.
    try:
        idle_database(local / "state/agent.db")
        idle_scheduler()
    except ValueError:
        return {"skipped": "site-not-idle-or-unproven"}
    service = ["systemctl", "--user"]
    active = subprocess.run([*service, "is-active", "--quiet", "kq-agent.service"], timeout=5)
    if active.returncode != 0:
        return {"skipped": "agent-service-not-active"}
    if not retention_plan(local, shared, days)["candidates"]:
        return {"skipped": "nothing-expired"}
    lease = secrets.token_hex(16)
    stop_attempted = False
    try:
        try:
            permit = maintenance_request(local, "drain", lease)
        except (OSError, ValueError, TimeoutError):
            return {"skipped": "maintenance-permit-unavailable"}
        if permit.get("ok") is not True:
            return {"skipped": "agent-has-in-flight-work"}
        stop_attempted = True
        subprocess.run([*service, "stop", "kq-agent.service"], check=True, timeout=90)
        previous = os.environ.get("KQ_MAINTENANCE_WINDOW")
        os.environ["KQ_MAINTENANCE_WINDOW"] = "1"
        try:
            return collect(local, shared, days, True)
        finally:
            if previous is None:
                os.environ.pop("KQ_MAINTENANCE_WINDOW", None)
            else:
                os.environ["KQ_MAINTENANCE_WINDOW"] = previous
    finally:
        try:
            maintenance_request(local, "resume", lease)
        except (OSError, ValueError, TimeoutError):
            # A stopped Agent has closed its socket; its replacement has no inherited lease.
            pass
        if stop_attempted:
            subprocess.run([*service, "start", "kq-agent.service"], check=True, timeout=90)


def maintenance_request(local, action, lease):
    path = local / "state/maintenance.sock"
    private(local / "state", True)
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Maintenance control socket must be private and user-owned")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(15)
        client.connect(str(path))
        client.sendall((json.dumps({"action": action, "lease": lease}) + "\n").encode())
        raw = b""
        while not raw.endswith(b"\n"):
            chunk = client.recv(1024)
            if not chunk or len(raw) + len(chunk) > 8192:
                raise ValueError("Invalid maintenance control response")
            raw += chunk
    response = json.loads(raw)
    if not isinstance(response, dict) or response.get("lease") != lease or type(response.get("ok")) is not bool:
        raise ValueError("Maintenance permit binding mismatch")
    if response["ok"] and response.get("reason") != {"drain": "MAINTENANCE_DRAINED", "resume": "MAINTENANCE_RESUMED"}.get(action):
        raise ValueError("Maintenance permit action mismatch")
    return response


def release_manifest(local, release):
    directory = private(local / "releases" / release, True)
    raw = private(directory / "manifest.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != release:
        raise ValueError("Release manifest identity mismatch")
    manifest = json.loads(raw)
    for artifact in manifest["files"]:
        name = artifact["name"]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}", name):
            raise ValueError("Invalid artifact name")
        path = private(directory / name)
        if path.stat().st_size != artifact["size"] or digest(path) != artifact["sha256"]:
            raise ValueError("Release artifact digest mismatch")
    return manifest


def database_evidence(path):
    evidence = {}
    with connect(path) as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in sorted(tables - {"sqlite_sequence", "agent_config", "outbound_heartbeat", "local_software"}):
            if not re.fullmatch(r"[A-Za-z0-9_]+", table):
                raise ValueError("Unexpected database table")
            cursor = db.execute(f'SELECT * FROM "{table}"')
            columns = [c[0] for c in cursor.description]
            ordering = ", ".join('"' + name.replace('"', '""') + '"' for name in columns)
            cursor = db.execute(f'SELECT * FROM "{table}" ORDER BY {ordering}')
            count = 0
            checksum = hashlib.sha256()
            for values in cursor:
                canonical = json.dumps(dict(zip(columns, values)), sort_keys=True, separators=(",", ":")).encode()
                checksum.update(str(len(canonical)).encode() + b":" + canonical)
                count += 1
            # New empty tables from a schema migration carry no execution or delivery state to lose.
            if count:
                evidence[table] = {"rows": count, "sha256": checksum.hexdigest()}
    return evidence


def state_files(local):
    files = {}
    for path in (local / "state").rglob("*"):
        if path.is_dir():
            private(path, True)
            continue
        if path == local / "state/maintenance.sock":
            info = path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError("Unexpected maintenance socket")
            continue
        if path.parent == local / "state" and (path.name in {"agent.db", "agent.db-wal", "agent.db-shm", "agent.lock", "agent.restore.db"} or path.name.startswith("before-restore-")):
            continue
        files[str(path.relative_to(local / "state"))] = digest(path)
    return files


def copy_private_tree(source, destination):
    if not source.exists():
        return {}
    private(source, True)
    destination.mkdir(mode=0o700)
    hashes = {}
    for path in source.rglob("*"):
        if path.is_symlink() or path.resolve() != path or path.stat().st_uid != os.getuid():
            raise ValueError("Snapshot input must be user-owned and contain no symlinks")
        target = destination / path.relative_to(source)
        if path.is_dir():
            target.mkdir(mode=0o700, exist_ok=True)
        elif path.is_file():
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            target.chmod(0o600)
            hashes[str(path.relative_to(source))] = digest(target)
        else:
            raise ValueError("Snapshot input contains an unsupported file")
    return hashes


def registration_files(local):
    source = local / "registration"
    if not source.exists():
        return {}
    private(source, True)
    hashes = {}
    for path in source.rglob("*"):
        if path.is_symlink() or path.resolve() != path or path.stat().st_uid != os.getuid():
            raise ValueError("Registration identity must be owned and contain no symlinks")
        if path.is_file():
            value = hashlib.sha256(path.read_bytes()).hexdigest()
            hashes[str(path.relative_to(source))] = value
        elif not path.is_dir():
            raise ValueError("Unexpected registration identity file")
    return hashes


def safe_shared(path, directory=False):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("Spack recovery path must be canonical and contain no symlinks")
    info = path.lstat()
    for parent in path.parents:
        ancestor = parent.lstat()
        if (not stat.S_ISDIR(ancestor.st_mode) or ancestor.st_uid not in (0, os.getuid()) or
                (ancestor.st_mode & 0o022 and not (ancestor.st_uid == 0 and ancestor.st_mode & stat.S_ISVTX))):
            raise ValueError("Unsafe shared recovery ancestor")
    if info.st_uid != os.getuid() or info.st_mode & 0o022 or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError("Spack recovery data must be owned and not writable by others")
    return path


def shared_store(local):
    release = (local / "current").resolve()
    if release.parent != local / "releases":
        raise ValueError("Invalid current release for shared recovery")
    config = {}
    for line in private(release / "agent.env").read_text().splitlines():
        words = shlex.split(line, comments=True)
        if not words:
            continue
        if len(words) != 2 or words[0] != "export" or "=" not in words[1]:
            raise ValueError("Invalid saved Agent environment for shared recovery")
        key, value = words[1].split("=", 1)
        if key in config:
            raise ValueError("Duplicate saved Agent configuration")
        config[key] = value
    path = config.get("AGENT_SPACK_INSTALL_SITE_PROFILE_PATH")
    expected = config.get("AGENT_SPACK_INSTALL_SITE_PROFILE_SHA256")
    if not path and not expected and config.get("AGENT_SPACK_INSTALL_ENABLED") != "true":
        if (Path(os.environ["KQ_SHARED"]) / "store").exists():
            raise ValueError("Existing shared Spack store requires a pinned site profile")
        return None
    if not path or not expected or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError("Shared Spack recovery requires a pinned site profile")
    profile = safe_shared(Path(path))
    if profile.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Oversized shared recovery site profile")
    raw = profile.read_bytes()
    if len(raw) > 8 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("Shared Spack recovery profile digest mismatch")
    data = json.loads(raw)
    if data.get("version") != 1 or not isinstance(data.get("storeRoot"), str):
        raise ValueError("Invalid Spack recovery site profile")
    root = safe_shared(Path(data["storeRoot"]), True)
    return {"root": root, "profileSha256": expected}


def writer_owner(path):
    value = json_file(path / "owner.json")
    if not isinstance(value, dict) or set(value) - {"version", "identity", "operationId"} or value.get("version") != 1:
        raise ValueError("Unknown shared Spack writer owner")
    identity = value.get("identity")
    if not isinstance(identity, dict) or set(identity) - {"host", "boot", "start", "pid", "token", "instance"} or not {"host", "boot", "start", "pid", "token"} <= set(identity):
        raise ValueError("Unknown shared Spack writer identity")
    def valid_uuid(text):
        try:
            return isinstance(text, str) and str(uuid.UUID(text)) == text
        except (ValueError, AttributeError):
            return False
    if type(identity["pid"]) is not int or identity["pid"] <= 0 or not valid_uuid(identity["token"]) or ("instance" in identity and not valid_uuid(identity["instance"])) or ("operationId" in value and not valid_uuid(value["operationId"])):
        raise ValueError("Invalid shared Spack writer identity")
    if identity["host"] is None:
        if identity["boot"] is not None or identity["start"] is not None or "instance" not in identity:
            raise ValueError("Invalid shared Spack writer identity")
    elif not isinstance(identity["host"], str) or not re.fullmatch(r"[a-f0-9]{64}", identity["host"]) or not valid_uuid(identity["boot"]) or not isinstance(identity["start"], str) or not identity["start"].isdigit():
        raise ValueError("Invalid shared Spack writer identity")
    return value


def maintenance_generation(path, current=None):
    marker = path / "maintenance.json"
    if not marker.exists():
        return False
    value = json_file(marker)
    owner = writer_owner(path)
    token = owner.get("identity", {}).get("token")
    if value != {"version": 1, "token": token} or not isinstance(token, str):
        raise ValueError("Invalid shared maintenance generation")
    if set(p.name for p in path.iterdir()) - {"owner.json", "maintenance.json", "released.json"}:
        raise ValueError("Unexpected worker state in maintenance generation")
    if path != current and (not (path / "released.json").exists() or json_file(path / "released.json") != token):
        raise ValueError("Shared maintenance writer has not released its fence")
    return True


@contextlib.contextmanager
def shared_writer(local):
    store = shared_store(local)
    if store is None:
        yield None
        return
    root = store["root"]
    lock = root / ".writer-lock"
    # This is the Agent's real mkdir/generation protocol, not an unrelated flock.
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError:
        pass
    else:
        write_json(lock / "format.json", {"version": 2})
        sync(root)
    private(lock, True)
    if json_file(lock / "format.json") != {"version": 2}:
        raise ValueError("Unknown shared Spack writer protocol")
    history = lock / "generations"
    history.mkdir(mode=0o700, exist_ok=True)
    private(history, True)
    names = sorted(p.name for p in history.iterdir())
    if names != [str(i).zfill(16) for i in range(len(names))]:
        raise ValueError("Invalid shared Spack writer history")
    if names:
        previous = private(history / names[-1], True)
        owner = writer_owner(previous)
        token = owner.get("identity", {}).get("token")
        if owner.get("version") != 1 or not isinstance(token, str) or not re.fullmatch(r"[a-f0-9-]{36}", token):
            raise ValueError("Invalid shared Spack writer owner")
        if (previous / "uncertain.json").exists() or not (previous / "released.json").exists() or json_file(previous / "released.json") != token:
            raise ValueError("Shared Spack writer is active or requires recovery")
    generation = history / str(len(names)).zfill(16)
    try:
        generation.mkdir(mode=0o700)
    except FileExistsError:
        raise ValueError("Shared Spack writer raced maintenance") from None
    sync(history)
    token = str(uuid.uuid4())
    # The Agent accepts this untrusted-namespace identity but cannot recover it after a crash.
    # A crashed maintenance generation therefore remains fenced for explicit reconciliation.
    owner = {"version": 1, "identity": {"host": None, "boot": None, "start": None,
             "pid": os.getpid(), "token": token, "instance": str(uuid.uuid4())}}
    write_json(generation / "owner.json", owner)
    write_json(generation / "maintenance.json", {"version": 1, "token": token})
    try:
        yield {**store, "generation": generation}
    finally:
        write_json(generation / "released.json", token)


def shared_digest(path):
    path = safe_shared(path)
    value = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_mode & 0o022:
            raise ValueError("Unsafe shared recovery metadata")
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
        after = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("Shared recovery metadata changed while reading")
    return value.hexdigest()


def shared_evidence(store):
    shared = private(Path(os.environ["KQ_SHARED"]), True)
    files = {}
    directories = []
    def capture(path, label):
        if not path.exists():
            return
        safe_shared(path, True)
        for item in [path, *path.rglob("*")]:
            relative = str(item.relative_to(path))
            if item.is_dir():
                safe_shared(item, True)
                directories.append(label + "/" + relative)
            else:
                safe_shared(item)
                files[label + "/" + relative] = shared_digest(item)
    if store:
        root = store["root"]
        for name in ("records", "attempts"):
            capture(root / name, "store/" + name)
        lock = root / ".writer-lock"
        files["store/.writer-lock/format.json"] = digest(lock / "format.json")
        for generation in sorted((lock / "generations").iterdir()):
            private(generation, True)
            if not maintenance_generation(generation, store["generation"]):
                capture(generation, "store/.writer-lock/generations/" + generation.name)
    # The Slurm runner's durable JSON receipts live outside the store too.
    for kind in ("audits", "installs"):
        base = shared / "materials" / kind
        if not base.exists():
            continue
        safe_shared(base, True)
        for run in sorted(base.glob("run-*")):
            safe_shared(run, True)
            directories.append("materials/" + kind + "/" + run.name)
            for item in sorted(run.rglob("*.json")):
                safe_shared(item)
                files["materials/" + kind + "/" + str(item.relative_to(base))] = shared_digest(item)
    return {"version": 1, "storeRoot": str(store["root"]) if store else None,
            "profileSha256": store["profileSha256"] if store else None,
            "directories": sorted(directories), "files": dict(sorted(files.items()))}


def snapshot(local):
    if os.environ.get("KQ_MAINTENANCE_WINDOW") != "1":
        raise ValueError("Backup requires a stopped Agent in a maintenance window")
    with stopped(local), shared_writer(local) as shared:
        database = local / "state/agent.db"
        idle_database(database)
        idle_scheduler()
        idle_workers(private(Path(os.environ["KQ_SHARED"]), True))
        release = (local / "current").resolve().name
        manifest = release_manifest(local, release)
        backups = local / "backups"
        backups.mkdir(mode=0o700, exist_ok=True)
        private(backups, True)
        directory = Path(tempfile.mkdtemp(prefix="snapshot-", dir=backups))
        try:
            checkpoint_state = state_files(local)
            capacity(backups, database.stat().st_size * 2 + sum(p.stat().st_size for p in (local / "state").rglob("*") if p.is_file()) + 1024 ** 3)
            with connect(database) as source, contextlib.closing(sqlite3.connect(directory / "agent.db")) as target:
                source.backup(target)
            (directory / "agent.db").chmod(0o600)
            for name in ("agent.env",):
                shutil.copyfile(private(local / "releases" / release / name), directory / name)
                (directory / name).chmod(0o600)
            record = {"version": 1, "createdAt": int(time.time()), "release": release,
                      "stateFormat": manifest["stateFormat"], "databaseSha256": digest(directory / "agent.db"),
                      "configSha256": digest(directory / "agent.env"),
                      "evidence": database_evidence(directory / "agent.db"), "checkpointState": checkpoint_state,
                      "registrationFiles": copy_private_tree(local / "registration", directory / "registration"),
                      "sharedState": shared_evidence(shared)}
            (directory / "state").mkdir(mode=0o700)
            for name, expected in checkpoint_state.items():
                target = directory / "state" / name
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                shutil.copyfile(private(local / "state" / name), target)
                target.chmod(0o600)
                if digest(target) != expected:
                    raise ValueError("Checkpoint changed during a stopped snapshot")
            # Publish the receipt only after every backup byte and nested directory is durable.
            entries = list(directory.rglob("*"))
            for path in entries:
                if path.is_file():
                    with private(path).open("rb") as stream:
                        os.fsync(stream.fileno())
            for path in sorted((p for p in entries if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
                sync(private(path, True))
            write_json(directory / "snapshot.json", record)
            sync(directory)
            sync(backups)
            return {"snapshot": str(directory), "release": release, "stateFormat": record["stateFormat"]}
        except BaseException:
            shutil.rmtree(directory)
            raise


def restore(local, directory):
    directory = private(directory, True)
    if directory.parent != local / "backups" or os.environ.get("KQ_MAINTENANCE_WINDOW") != "1":
        raise ValueError("Restore requires a local snapshot and a maintenance window")
    with stopped(local), shared_writer(local) as shared:
        database = local / "state/agent.db"
        idle_database(database)
        idle_scheduler()
        idle_workers(private(Path(os.environ["KQ_SHARED"]), True))
        record = json_file(directory / "snapshot.json")
        if digest(directory / "agent.db") != record["databaseSha256"] or digest(directory / "agent.env") != record["configSha256"]:
            raise ValueError("Snapshot integrity mismatch")
        manifest = release_manifest(local, record["release"])
        if manifest["stateFormat"] != record["stateFormat"]:
            raise ValueError("Snapshot stateFormat mismatch")
        if "sharedState" not in record or shared_evidence(shared) != record["sharedState"]:
            raise ValueError("Shared Spack recovery state changed or legacy snapshot lacks evidence; restore refused")
        if database_evidence(database) != record["evidence"]:
            raise ValueError("Database has changed execution or delivery records; automatic restore would lose state")
        if state_files(local) != record["checkpointState"]:
            raise ValueError("Transfer checkpoint state changed; restore would discard transfer progress")
        if registration_files(local) != record["registrationFiles"]:
            raise ValueError("Registration identity or certificate rotated; reconcile identity before state restore")
        if private(local / "releases" / record["release"] / "agent.env").read_bytes() != (directory / "agent.env").read_bytes():
            raise ValueError("Saved release configuration changed")
        # Consolidate the stopped database before touching WAL sidecars, including if replacement crashes.
        checkpoint_database(database)
        intent = local / "restore-intent.json"
        previous = json_file(intent) if intent.exists() else None
        if previous and (previous.get("snapshot") != directory.name or previous.get("release") != record["release"]):
            raise ValueError("Another interrupted restore must be reconciled first")
        link = local / "current.restore"
        if link.exists() or link.is_symlink():
            if not previous or not link.is_symlink() or os.readlink(link) != str(local / "releases" / record["release"]):
                raise ValueError("Restore link staging exists; reconcile before retry")
            link.unlink()
        temporary = database.with_name("agent.restore.db")
        if temporary.exists() or temporary.is_symlink():
            if not previous or digest(temporary) != record["databaseSha256"]:
                raise ValueError("Previous restore staging exists; reconcile it first")
            temporary.unlink()
        # Preserve the migrated database before replacement; never downgrade an active writer's database.
        recovery = local / "state" / ("before-restore-" + str(time.time_ns()) + ".db")
        with connect(database) as source, contextlib.closing(sqlite3.connect(recovery)) as target:
            source.backup(target)
        recovery.chmod(0o600)
        with recovery.open("rb") as stream:
            os.fsync(stream.fileno())
        shutil.copyfile(directory / "agent.db", temporary)
        temporary.chmod(0o600)
        with temporary.open("rb") as stream:
            os.fsync(stream.fileno())
        write_json(intent, {"snapshot": directory.name, "release": record["release"],
                            "beforeDatabase": recovery.name, "startedAt": int(time.time())})
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(database) + suffix)
            if sidecar.exists():
                private(sidecar)
                sidecar.unlink()
        os.replace(temporary, database)
        sync(database.parent)
        link.symlink_to(local / "releases" / record["release"])
        os.replace(link, local / "current")
        sync(local)
        write_json(local / "restore-last.json", {"snapshot": directory.name, "release": record["release"],
                                                 "stateFormat": record["stateFormat"], "restoredAt": int(time.time())})
        intent.unlink()
        sync(local)
        return {"release": record["release"], "stateFormat": record["stateFormat"], "startAgentExplicitly": True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("capacity", "plan", "gc", "auto", "backup", "restore"))
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--retention-days", type=int, default=30)
    args = parser.parse_args(argv)
    local = private(Path(os.environ["KQ_LOCAL"]), True)
    shared = private(Path(os.environ["KQ_SHARED"]), True)
    if args.action == "capacity":
        result = {"local": capacity(local, int(os.environ.get("KQ_LOCAL_RESERVE_BYTES", 1024 ** 3))),
                  "shared": capacity(shared, int(os.environ.get("KQ_SHARED_RESERVE_BYTES", 2 * 1024 ** 3)))}
    elif args.action in ("plan", "gc"):
        result = collect(local, shared, args.retention_days, args.action == "gc")
    elif args.action == "backup":
        result = snapshot(local)
    elif args.action == "auto":
        result = auto_collect(local, shared, args.retention_days)
    else:
        if args.snapshot is None:
            parser.error("restore requires --snapshot")
        result = restore(local, args.snapshot)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()

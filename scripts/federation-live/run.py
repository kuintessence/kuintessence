"""Isolated full Server and real Kubernetes artifact pipeline probe; no deployment credentials."""

import errno, hashlib, io, json, os, pathlib, secrets, shutil, signal, socket, subprocess, sys, tempfile, time, urllib.request, uuid
from datetime import datetime, timedelta

repo = pathlib.Path(__file__).resolve().parents[2]
if os.environ.get("KQ_FEDERATION_EXECUTION_LAB") != "1":
    raise SystemExit(
        "Set KQ_FEDERATION_EXECUTION_LAB=1 for the disposable local k3s lab"
    )
if os.geteuid() != 0:
    raise SystemExit("Run on a disposable local k3s node as root")
disk_pressure = os.environ.get("KQ_FEDERATION_LAB_DISK_PRESSURE") == "1"
if disk_pressure and os.environ.get("LAB_PRIVATE_MOUNT") != "1":
    os.execvpe("unshare", ["unshare", "--mount", "--propagation", "private", sys.executable, *sys.argv],
               {**os.environ, "LAB_PRIVATE_MOUNT": "1"})
os.umask(0o077)
mode = os.environ.get("LAB_MODE", "ledger_coordinated")
assert mode in ("bilateral_direct", "bilateral_attested", "ledger_coordinated")
coordinated = mode == "ledger_coordinated"
attested = mode == "bilateral_attested"
scenario = os.environ.get("LAB_SCENARIO", "success")
refund_scenario = scenario in ("refund", "refund-auto")
automatic_refund = scenario == "refund-auto"
assert not disk_pressure or automatic_refund, "Disk recovery currently requires refund-auto"
assert not refund_scenario if coordinated else scenario in ("success", "refund", "refund-auto", "media", "task-media")
assert scenario in ("success", "outage", "stop", "workflow", "refund", "refund-auto", "media", "task-media")
native_dispute = os.environ.get("KQ_FEDERATION_LAB_DISPUTE") == "1"
assert not native_dispute or (coordinated and scenario in ("success", "workflow")), "Native dispute requires coordinated success/workflow"
case_scenario = os.environ.get("KQ_FEDERATION_LAB_CASES") == "1"
assert not case_scenario or (mode == "bilateral_direct" and scenario == "success")
disclosure_scenario = case_scenario or os.environ.get("KQ_FEDERATION_LAB_DISCLOSURE") == "1"
assert not disclosure_scenario or (mode == "bilateral_direct" and scenario == "success"), "Disclosure lab requires direct success"
media_scenario = scenario == "media"
task_media = scenario == "task-media"
uses_media = media_scenario or task_media
self_account = os.environ.get("KQ_FEDERATION_SELFACCOUNT") == "1"
assert not self_account or (mode == "bilateral_direct" and scenario == "success"), "SelfAccount lab requires direct success workflow"
media_execution = os.environ.get("KQ_MEDIA_EXECUTION", "")
assert media_execution in ("", "slurm", "pbs-pro")
assert not media_execution or media_scenario
hpc_execution = "slurm" if self_account else media_execution
assert not uses_media or mode == "bilateral_direct"
media_age = pathlib.Path(os.environ["KQ_MEDIA_AGE_BIN"]).resolve(strict=True) if uses_media else None
if media_age:
    assert media_age.is_dir() and all((media_age / name).is_file() for name in ("age", "age-keygen")), "KQ_MEDIA_AGE_BIN must be the directory containing age and age-keygen"
media_source_root, media_target_root = str(uuid.uuid4()), str(uuid.uuid4())
nodeinfo = json.loads(
    subprocess.check_output(["kubectl", "get", "nodes", "-o", "json"], timeout=15)
)["items"]
assert len(nodeinfo) == 1, "Dedicated single-node k3s required"
node = nodeinfo[0]["metadata"]["name"]
nodeip = next(
    a["address"]
    for a in nodeinfo[0]["status"]["addresses"]
    if a["type"] == "InternalIP"
)
with socket.socket() as local:
    local.bind((nodeip, 0))
pgbin = str(pathlib.Path(os.environ["KQ_FEDERATION_PG_BIN"]).resolve()) + "/"
pgshare = os.environ.get("KQ_FEDERATION_PG_SHARE")
assert all(pathlib.Path(pgbin, x).is_file() for x in ("initdb", "pg_ctl", "createdb"))


def interrupted(signum, frame):
    raise RuntimeError("Lab interrupted; cleaning owned resources")


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
root = pathlib.Path(tempfile.mkdtemp(prefix="kq-federation-live-"))
pgroot = pathlib.Path(tempfile.mkdtemp(prefix="kq-federation-pg-"))
os.chown(pgroot, 65534, 65534)
namespace = "kq-federation-live-" + uuid.uuid4().hex[:8]
image = "ghcr.io/kuintessence/kq-dev-scheduler@sha256:9436d1c2a6875f53f42e8adc7c3a13068a4903a99920c06ff1201af0fd759e0d"
# Never inherit an active deployment's database, auth, storage or Server configuration.
env = {
    key: value
    for key, value in os.environ.items()
    if key in ("PATH", "HOME", "LANG", "TMPDIR")
}
if os.environ.get("KQ_FEDERATION_PG_LIB"):
    env["LD_LIBRARY_PATH"] = os.environ["KQ_FEDERATION_PG_LIB"]
env["LAB_SCENARIO"] = scenario
env["LAB_MODE"] = mode
env["LAB_FIXTURE_ROOT"] = os.environ["LAB_FIXTURE_ROOT"]
if coordinated or attested or case_scenario:
    env["LAB_FABRIC_ROOT"] = os.environ["LAB_FABRIC_ROOT"]


allocated_ports = set()


def port():
    while True:
        # Keep lab listeners below this node's ephemeral client port range.
        candidate = 10000 + secrets.randbelow(20000)
        if candidate in allocated_ports:
            continue
        try:
            with socket.socket() as s:
                s.bind(("127.0.0.1", candidate))
        except OSError as error:
            if error.errno == errno.EADDRINUSE:
                continue
            raise
        allocated_ports.add(candidate)
        return candidate


pgport, httpport, grpcport, sourcegatewayport = port(), port(), port(), port()
env.update(
    DATABASE_URL=f"postgres://kq@127.0.0.1:{pgport}/kuintessence_unit_federation_live",
    REDIS_URL="redis://127.0.0.1:1",
    JWT_SECRET=secrets.token_hex(32),
    SERVER_PORT=str(httpport),
    SERVER_GRPC_PORT=str(grpcport),
    SERVER_CA_DIR=str(root / "ca"),
    SERVER_GRPC_TLS_CERT_FILE=str(root / "tls.crt"),
    SERVER_GRPC_TLS_KEY_FILE=str(root / "tls.key"),
    MTLS_MODE="direct",
    LOG_LEVEL="info",
    NODE_ENV="development",
    NETDRIVE_ENABLED="false",
    AUTHZ_MODE="off",
    FEDERATION_ENABLED="true",
    FEDERATION_SITE_ID=str(uuid.uuid4()),
    FEDERATION_SIGNING_KEY_ID="lab-local",
    FEDERATION_SIGNING_KEY_FILE=str(root / "federation.pem"),
    FEDERATION_SOCKET_PATH=str(root / "federation.sock"),
    WORKFLOW_RUN_BASE="/scratch/workflows",
    LAB_ROOT=str(root),
    LAB_AGENT="federation-live-agent",
)
if uses_media:
    env.update(FEDERATION_MEDIA_AGE_DIRECTORY=str(media_age), FEDERATION_MEDIA_WRAPPING_KEY=secrets.token_hex(32), LAB_MEDIA_ROOT_ID=media_target_root)
if media_execution:
    env["LAB_MEDIA_EXECUTION"] = media_execution
if self_account:
    env["LAB_SELF_ACCOUNT"] = "1"
networkroot = pathlib.Path(os.environ["LAB_FABRIC_ROOT"]) if coordinated or attested or case_scenario else None
fixture = json.loads((pathlib.Path(env["LAB_FIXTURE_ROOT"]) / "execution-fixture.json").read_text())
siteb = next(site for site in fixture["sites"] if site["name"] == "B")
env.update(FEDERATION_SITE_ID=siteb["siteId"], FEDERATION_SIGNING_KEY_ID="batch-1")
if case_scenario:
    env["LAB_CASES"] = "1"
    env["FEDERATION_CASE_TRUST_FILE"] = str(networkroot / "case-trust.json")
    env["FEDERATION_CASE_SOCKET_PATH"] = str(networkroot / "live-B-case/case.sock")
if coordinated or attested:
    env["FEDERATION_COMMERCIAL_SOCKET_PATH"] = str(networkroot / "live-B-commercial/commercial.sock")
if coordinated:
    env["FEDERATION_MARKET_SOCKET_PATH"] = str(networkroot / "live-B-market/market.sock")
if attested:
    env["FEDERATION_ATTESTATION_SOCKET_PATH"] = str(networkroot / "live-B-evidence/evidence.sock")

logs = pathlib.Path(
    tempfile.mkdtemp(prefix="federation-execution-" + (scenario if coordinated else "attested" if attested else "direct") + "-", dir=repo / "temp")
)
print("Private execution evidence: " + str(logs), flush=True)
log = open(logs / "setup.log", "w")
serverlog = open(logs / "server.log", "w")
sourcegateway = None
storageproxy = None
proxylog = None
sourceserver = None
sourcelog = None
server = None
gateway = None
pgstarted = False
created = False
profilepath = None
clusterrole = None
storage_observers = []
pressure_mounted = False
pressure_filler = pgroot / "owned-pressure-filler"



def run(args, timeout=120, **kw):
    return subprocess.run(
        args, cwd=repo, env=env, check=True, stdout=log, stderr=log, timeout=timeout, **kw
    )


def pg(*args):
    run(["runuser", "-u", "nobody", "--", pgbin + args[0], *args[1:]])


def start_postgres():
    options = f"-h 127.0.0.1 -p {pgport} -k {pgroot}"
    if disk_pressure:
        options += " -c shared_buffers=16MB -c max_connections=60 -c autovacuum=off -c min_wal_size=32MB -c max_wal_size=64MB"
    pg("pg_ctl", "-D", str(pgroot / "data"), "-l", str(pgroot / "postgres.log"), "-o", options, "-w", "start")


def storage_command(setting, command, evidence=None):
    return subprocess.run(["bun", "--no-env-file", "scripts/federation-live/storage.ts", command],
                          cwd=repo, env={**setting, **({"LAB_EVIDENCE": str(evidence)} if evidence else {})},
                          check=True, stdout=log, stderr=log, timeout=90)


def configure_storage(setting, name):
    control = root / ("storage-" + name)
    setting.update(LAB_STORAGE_VOLUME=str(pgroot), LAB_STORAGE_CONTROL=str(control),
                   FEDERATION_STORAGE_GUARD_FILE=str(control / "policy.json"))
    storage_command(setting, "setup")
    storage_observers.append(subprocess.Popen(
        ["bun", "--no-env-file", "scripts/federation-storage-observer.ts", str(control / "observer.json")],
        cwd=repo, env=setting, stdout=log, stderr=log))


def reserve_command(setting, command):
    control = pathlib.Path(setting["LAB_STORAGE_CONTROL"])
    subprocess.run(["bun", "--no-env-file", "scripts/federation-storage-reserve.ts", str(control / "reserve.json"), command],
                   cwd=repo, env=setting, stdout=log, stderr=log, check=True, timeout=90)


def recover_full_storage():
    global server, sourceserver, gateway, pgstarted
    crashed = []
    for name, setting, process in (("provider", env, server), ("source", sourceenv, sourceserver)):
        storage_command(setting, "snapshot", logs / (name + "-storage-before.json"))
        before = json.loads((logs / (name + "-storage-before.json")).read_text())
        assert before["capacity"]["obligations"] == 1 and before["capacity"]["allocatedBytes"] == "16777216"
        assert len(before["claims"]) == 1 and before["claims"][0]["releasedAt"] is None
        assert process.poll() is None and os.getpgid(process.pid) == process.pid
        os.killpg(process.pid, signal.SIGKILL)
        assert process.wait(timeout=15) == -signal.SIGKILL
        crashed.append({"site": name, "oldPid": process.pid, "exitCode": process.returncode})
    old_pg = int((pgroot / "data/postmaster.pid").read_text().splitlines()[0])
    reached_full = False
    try:
        with pressure_filler.open("xb", buffering=0) as filler:
            for _ in range(1100):
                filler.write(b"x" * 1048576)
    except OSError as error:
        assert error.errno == errno.ENOSPC, "Unexpected error filling isolated filesystem"
        reached_full = True
    assert reached_full and pressure_filler.stat().st_size > 0
    storage_command(env, "full")
    for setting in (env, sourceenv):
        reserve_command(setting, "release")
        storage_command(setting, "blocked")
    pg("pg_ctl", "-D", str(pgroot / "data"), "-m", "immediate", "-w", "stop")
    pgstarted = False
    start_postgres()
    pgstarted = True
    new_pg = int((pgroot / "data/postmaster.pid").read_text().splitlines()[0])
    assert new_pg != old_pg
    command = ["bun", "--no-env-file", "run", "scripts/federation-live/server.ts"]
    server = subprocess.Popen(command, cwd=repo, env=env, stdout=serverlog, stderr=serverlog, start_new_session=True)
    sourceserver = subprocess.Popen(command, cwd=repo, env=sourceenv, stdout=sourcelog, stderr=sourcelog, start_new_session=True)
    for row, process, read in zip(crashed, (server, sourceserver), (api, sourceapi)):
        row["newPid"] = process.pid
        assert process.pid != row["oldPid"]
        for _ in range(45):
            assert process.poll() is None, "Recovered Server exited"
            try:
                read("health")
                break
            except (OSError, ValueError):
                time.sleep(1)
        else:
            raise AssertionError("Recovered Server health timeout")
    gateway = subprocess.Popen(["node", str(root / "gateway.mjs")], cwd=repo, env=env, stdout=serverlog, stderr=serverlog)
    (logs / "storage-crash-recovery.json").write_text(json.dumps({
        "servers": crashed, "postgres": {"oldPid": old_pg, "newPid": new_pg},
        "sqlState": "53100", "fillerBytes": pressure_filler.stat().st_size,
    }, indent=2) + "\n")
    print("REAL STORAGE RECOVERY: ENOSPC and SQL 53100; released two owned 64 MiB reserves; original PostgreSQL and Servers restarted with filler retained", flush=True)


def verify_storage_closure():
    request = json.loads((root / "source-init.json").read_text())["request"]
    for name, setting in (("source", sourceenv), ("provider", env)):
        evidence = logs / (name + "-storage-closed.json")
        for _ in range(90):
            storage_command(setting, "snapshot", evidence)
            after = json.loads(evidence.read_text())
            assert len(after["claims"]) == 1
            if after["capacity"]["releasedObligations"] == 1:
                break
            time.sleep(2)
        else:
            raise AssertionError("Completion capacity did not drain: " + name + " " + str(after["claims"][0]["releaseBlocker"]))
        assert after["capacity"]["allocatedBytes"] == "0" and after["capacity"]["obligations"] == 0
        before = json.loads((logs / (name + "-storage-before.json")).read_text())
        original = before["claims"][0]
        assert after["cancellations"] == before["cancellations"], "Original cancellation signature changed"
        if name == "source":
            assert len(before["cancellations"]) == 1 and before["cancellations"][0]["signatureDigest"]
        for field in ("kind", "intentId", "digest", "allocatedBytes", "createdAt"):
            assert after["claims"][0][field] == original[field]
        storage_command(setting, "blocked")
    assert pressure_filler.stat().st_size > 0, "Filler must remain during all business closure"
    rejected = {**request, "operationId": str(uuid.uuid4()), "taskId": str(uuid.uuid4())}
    def reject_new():
        try:
            sourceapi("federation/outbound", rejected, sourcetoken)
        except urllib.error.HTTPError as error:
            assert error.code == 503 and json.load(error)["error"]["code"] == "STORAGE_PRESSURE"
        else:
            raise AssertionError("Released reserve allowed new workload")
    reject_new()
    pressure_filler.unlink()
    for setting in (env, sourceenv):
        storage_command(setting, "blocked")
    reject_new()
    for name, setting in (("source", sourceenv), ("provider", env)):
        reserve_command(setting, "restore")
        storage_command(setting, "restored")
        storage_command(setting, "snapshot", logs / (name + "-storage-restored.json"))
    assert len(sourceapi("federation/outbound", token=sourcetoken)["data"]) == 1
    print("REAL STORAGE CLOSURE PASSED: original cancellation/refund and one-time capacity release with filler retained; new HTTP intent refused while released; explicit restore rearmed guard", flush=True)


def k(args, data=None, check=True, timeout=45):
    r = subprocess.run(
        ["kubectl", *args], input=data, text=True, capture_output=True, timeout=timeout
    )
    if check and r.returncode:
        raise RuntimeError(r.stderr[:1500])
    return r


def api(path, body=None, token=None, headers=None):
    req = urllib.request.Request(
        f"http://127.0.0.1:{httpport}/api/" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Content-Type": "application/json",
            **({"Authorization": "Bearer " + token} if token else {}),
            **(headers or {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read()
        (logs / "target-http-error.json").write_bytes(body)
        raise urllib.error.HTTPError(error.url, error.code, error.msg, error.headers, io.BytesIO(body)) from error


def orderer(action):
    assert networkroot is not None
    request_id = str(uuid.uuid4())
    acknowledgement = networkroot / ("execution-orderer-" + action + ".ack")
    (networkroot / ("execution-orderer-" + action)).write_text(request_id)
    deadline = time.monotonic() + 45
    while not acknowledgement.exists() or acknowledgement.read_text() != request_id:
        assert time.monotonic() < deadline, "Orderer control acknowledgement timeout"
        time.sleep(0.3)


def verify_interruption():
    for _ in range(60):
        run(
            [
                "bun",
                "--no-env-file",
                "run",
                "scripts/federation-live/target.ts",
                "inspect",
            ]
        )
        probe = json.loads((root / "probe-state.json").read_text())
        if len(probe["jobs"]) == 1 and probe["jobs"][0]["schedulerJobId"]:
            jobid = probe["jobs"][0]["schedulerJobId"]
            # Sandbox stdout is published at termination; inspect the live process instead.
            workload = k(
                [
                    "exec",
                    "-n",
                    namespace,
                    "job/" + jobid,
                    "--",
                    "/bin/sh",
                    "-c",
                    'for f in /proc/[0-9]*/comm; do IFS= read -r n < "$f" || continue; '
                    'if [ "$n" = sleep ]; then tr "\\000" " " < "${f%/comm}/cmdline"; fi; done',
                ],
                check=False,
            )
            if workload.returncode == 0 and "sleep 600" in workload.stdout:
                break
        time.sleep(2)
    else:
        raise RuntimeError("Could not observe the live sandbox sleep process")
    (logs / "running-process.txt").write_text(workload.stdout)
    inspect_ledgers("running")
    before = json.loads((logs / "provider-running.json").read_text())
    confirmations = [
        r["operation"]["authorization"]
        for r in before["market"]
        if r["state"] == "committed"
        and r["operation"]["operation"] == "authorize-execution"
    ]
    assert confirmations, "Missing real VALID confirmation"
    cutoff = max(
        datetime.fromisoformat(p["expiresAt"].replace("Z", "+00:00")).timestamp()
        for p in confirmations
    )
    assert cutoff > time.time() + 30, "Confirmation too near expiry to exercise outage"
    running_pods = json.loads(
        k(
            ["get", "pods", "-n", namespace, "-l", "job-name=" + jobid, "-o", "json"]
        ).stdout
    )["items"]
    assert running_pods, "Missing running Pod"
    grace = max(
        p["spec"].get("terminationGracePeriodSeconds", 30) for p in running_pods
    )
    assert 0 <= grace <= 30, "Unexpected sandbox termination grace"
    stop_requested_at = None
    original_cutoff = cutoff
    stop_id = None
    stop_bound = 10
    orderer("stop")
    if scenario == "stop":
        assert (
            original_cutoff > time.time() + 120
        ), "Need a live proof throughout local stop"
        proof = json.loads((root / "ledger-proof.json").read_text())
        config = json.loads((root / "source-init.json").read_text())
        path = (
            "federation/commercial-agreements/"
            + config["request"]["agreementRevisionId"]
            + "/execution-approvals/"
            + proof["reservationId"]
            + "/stop"
        )
        requested = api(path, {}, token=token)
        repeated = api(path, {}, token=token)
        assert (
            requested["data"] == repeated["data"]
        ), "Duplicate stop changed its identity"
        stop_id = requested["data"]["id"]
        (logs / "stop-api.json").write_text(json.dumps(requested, indent=2) + "\n")
        cutoff = time.time()
        stop_bound = 20
    print(
        "Orderer stopped after actual sleep started; observing " + scenario,
        flush=True,
    )
    lastprint = 0
    while time.time() < cutoff + grace + 30:
        if time.time() >= cutoff and stop_requested_at is None:
            current = k(
                [
                    "get",
                    "job",
                    jobid,
                    "-n",
                    namespace,
                    "--ignore-not-found",
                    "-o",
                    "json",
                ]
            ).stdout
            deletion = (
                json.loads(current)["metadata"].get("deletionTimestamp")
                if current.strip()
                else None
            )
            if deletion:
                stop_requested_at = datetime.fromisoformat(
                    deletion.replace("Z", "+00:00")
                ).timestamp()
            elif not current.strip():
                stop_requested_at = time.time()
            assert (
                stop_requested_at is not None or time.time() <= cutoff + stop_bound
            ), "Execution interruption did not promptly request scheduler stop"
        if time.time() - lastprint >= 30:
            print(
                "Lease outage observation: "
                + str(max(0, int(cutoff - time.time())))
                + " seconds to stop observation deadline",
                flush=True,
            )
            lastprint = time.time()
        time.sleep(2)
    assert stop_requested_at is not None and stop_requested_at <= cutoff + stop_bound
    # A DB terminal flag alone is insufficient: the real scheduler Pod must be gone or terminated.
    pods = json.loads(
        k(
            ["get", "pods", "-n", namespace, "-l", "job-name=" + jobid, "-o", "json"]
        ).stdout
    )
    assert all(
        p["status"].get("phase") in ["Failed", "Succeeded"] for p in pods["items"]
    ), "Expired authorization left a live scheduler Pod"
    scheduler_jobs = json.loads(
        k(["get", "jobs", "-n", namespace, "-o", "json"]).stdout
    )
    for job in scheduler_jobs["items"]:
        assert job["metadata"]["name"] == jobid, "Unexpected scheduler Job"
        state = job.get("status", {})
        assert not state.get("active") and any(
            c["type"] in ["Complete", "Failed"] and c["status"] == "True"
            for c in state.get("conditions", [])
        ), "Expired authorization left a Job able to recreate its Pod"
    run(["bun", "--no-env-file", "run", "scripts/federation-live/target.ts", "inspect"])
    probe = json.loads((root / "probe-state.json").read_text())
    assert (
        len(probe["jobs"]) == 1 and probe["jobs"][0]["schedulerJobId"] == jobid
    ), "A downstream or replacement Job was dispatched"
    assert probe["jobs"][0]["status"] in [
        "failed",
        "cancelled",
    ], "Expired workload was not terminal"
    assert len(probe["runs"]) == 1 and probe["runs"][0]["status"] in [
        "failed",
        "cancelled",
    ], "Workflow incorrectly succeeded after expiry"
    assert (
        not probe["artifacts"] and not probe["files"]
    ), "Interrupted workload published results"
    env["LAB_EVIDENCE"] = str(logs / "provider-expired.json")
    run(
        [
            "bun",
            "--no-env-file",
            "scripts/federation-live/inspect.ts",
            "--stopped" if scenario == "stop" else "--expired",
        ]
    )
    if scenario == "stop":
        assert (
            time.time() < original_cutoff
        ), "Local stop was only observed after proof expiry"
    after = json.loads((logs / "provider-expired.json").read_text())
    assert (
        after["gate"] == before["gate"]
    ), "Expiry silently released the private reservation"
    assert (
        after["demand"] == before["demand"]
    ), "Expiry silently reopened or changed the ACTIVE demand"
    committed = [
        r["operation"]["authorization"]
        for r in after["market"]
        if r["state"] == "committed"
        and r["operation"]["operation"] == "authorize-execution"
    ]
    assert (
        committed == confirmations
    ), "Orderer outage unexpectedly committed a new confirmation"
    (logs / (scenario + "-evidence.json")).write_text(
        json.dumps(
            {
                "jobId": jobid,
                "confirmationExpiresAt": datetime.fromtimestamp(
                    original_cutoff
                ).isoformat(),
                "stopId": stop_id,
                "stopRequestedAt": datetime.fromtimestamp(
                    stop_requested_at
                ).isoformat(),
                "terminationGraceSeconds": grace,
                "observedAt": datetime.now().isoformat(),
                "pods": pods,
                "schedulerJobs": scheduler_jobs,
                "workflow": probe,
                "gate": after["gate"],
                "demand": after["demand"],
            },
            indent=2,
        )
        + "\n"
    )
    orderer("start")
    if scenario == "stop":
        for _ in range(24):
            inspect_ledgers("stop-recovery")
            restored = json.loads((logs / "provider-stop-recovery.json").read_text())
            committed_stop = [
                r
                for r in restored["market"]
                if r["id"] == stop_id and r["state"] == "committed"
            ]
            if committed_stop:
                assert len(committed_stop) == 1
                assert restored["demand"]["demand"]["status"] == "STOPPING"
                assert restored["demand"]["demand"]["stopRequest"]["stopId"] == stop_id
                assert restored["gate"] == before["gate"], "Stop released private funds"
                break
            time.sleep(5)
        else:
            raise RuntimeError("Durable stop did not commit after Orderer recovery")
    time.sleep(15)
    run(["bun", "--no-env-file", "run", "scripts/federation-live/target.ts", "inspect"])
    recovered = json.loads((root / "probe-state.json").read_text())
    assert len(recovered["jobs"]) == 1 and recovered["jobs"][0]["status"] in [
        "failed",
        "cancelled",
    ], "Restoring Orderer restarted terminal work"
    print(
        "REAL "
        + scenario.upper()
        + " PASSED: authorization rejected; actual workload stopped; no downstream dispatch, release or reopen",
        flush=True,
    )


def verify_selfaccount_restart():
    global server
    for _ in range(60):
        run(["bun", "--no-env-file", "scripts/federation-live/target.ts", "inspect"])
        state = json.loads((root / "probe-state.json").read_text())
        if len(state["jobs"]) == 1 and state["jobs"][0]["schedulerJobId"]:
            original = state["jobs"][0]
            native, output = inspect_native(k, namespace, original)
            (logs / "selfaccount-producer.log").write_text(output)
            (logs / "selfaccount-producer-state.json").write_text(json.dumps({"job": original, "native": native}, indent=2))
            assert original["status"] not in ("failed", "cancelled"), {"job": original, "output": output}
            if native["state"] == "RUNNING":
                # The bounded stdout pipe may buffer short logs until exit; observe the real output file.
                marker = k(["exec", "-n", namespace, "scheduler", "--", "cat",
                            f"/scratch/sandbox/{original['id']}/outputs/result"], check=False)
                if marker.returncode == 0 and marker.stdout == "federation-recovery-waiting\n":
                    break
        time.sleep(1)
    else:
        raise RuntimeError("SelfAccount producer did not reach its interruption checkpoint while RUNNING")
    assert state["agent"][0]["rootMode"] is False
    assert state["agent"][0]["sandboxCapabilities"]["executionMode"] == "SelfAccount"
    assert original["execution"]["executionMode"] == "SelfAccount"
    old_server_pid = server.pid
    os.killpg(server.pid, signal.SIGKILL)
    server.wait(timeout=10)
    agent_recovery = interrupt_agent(k, namespace)
    native_after, _ = inspect_native(k, namespace, original)
    assert native_after["state"] == "RUNNING", "Agent death must not cancel the original Slurm job"
    server = subprocess.Popen(["bun", "--no-env-file", "run", "scripts/federation-live/server.ts"],
                              cwd=repo, env=env, stdout=serverlog, stderr=serverlog, start_new_session=True)
    assert server.pid != old_server_pid
    for _ in range(45):
        assert server.poll() is None, "Provider Server failed to restart"
        try:
            api("health")
            break
        except (OSError, ValueError):
            time.sleep(1)
    else:
        raise RuntimeError("Provider Server did not recover")
    (logs / "selfaccount-restart.json").write_text(json.dumps({"original": original,
        "nativeBefore": native, "nativeAfter": native_after, "checkpoint": marker.stdout, "agent": agent_recovery,
        "oldServerPid": old_server_pid, "newServerPid": server.pid}, indent=2))
    print("REAL SELFACCOUNT INTERRUPTION: original running Slurm job survives SIGKILL of Agent and provider Server; original state retained", flush=True)


def verify_success():
    for _ in range(60):
        run(
            [
                "bun",
                "--no-env-file",
                "run",
                "scripts/federation-live/target.ts",
                "inspect",
            ]
        )
        probe = json.loads((root / "probe-state.json").read_text())
        if probe["runs"] and probe["runs"][0]["status"] in [
            "failed",
            "completed",
            "cancelled",
        ]:
            break
        time.sleep(5)
    (logs / "runtime-gate-result.json").write_text(json.dumps(probe, indent=2) + "\n")
    print(
        "Target workflow finished: "
        + str(probe["runs"][0]["status"] if probe["runs"] else "missing"),
        flush=True,
    )
    assert (
        len(probe["runs"]) == 1 and len(probe["bindings"]) == 1
    ), "Automatic workflow activation missing"
    assert (
        probe["runs"][0]["status"] == "completed" and len(probe["jobs"]) == 2
    ), json.dumps(probe)
    assert all(
        j["schedulerJobId"] and j["status"] == "completed" for j in probe["jobs"]
    ), "Missing completed scheduler jobs"
    if self_account:
        original = json.loads((logs / "selfaccount-restart.json").read_text())["original"]
        recovered = [j for j in probe["jobs"] if j["id"] == original["id"]]
        assert len(recovered) == 1 and recovered[0]["schedulerJobId"] == original["schedulerJobId"]
        assert recovered[0]["dispatchEpoch"] == original["dispatchEpoch"], "Recovery changed the original dispatch epoch"
    assert (
        len(probe["artifacts"]) == 2 and len(probe["files"]) == 2
    ), "Missing published artifacts"
    assert sorted(f["size"] for f in probe["files"]) == [
        3,
        12,
    ], "Unexpected result file sizes"
    import hashlib

    assert sorted(f["sha256"] for f in probe["files"]) == sorted(
        hashlib.sha256(data).hexdigest() for data in [b"42\n", b"verified:42\n"]
    ), "Result hash mismatch"
    for j in probe["jobs"]:
        if self_account:
            facts, output = inspect_native(k, namespace, j)
            assert facts["state"] == "COMPLETED" and facts["exitCode"] == "0:0", facts
            assert j["execution"]["executionMode"] == "SelfAccount"
            (logs / (j["schedulerJobId"] + "-slurm.json")).write_text(json.dumps(facts, indent=2))
        else:
            output = k(["logs", "-n", namespace, "job/" + j["schedulerJobId"]]).stdout
        (logs / (j["schedulerJobId"] + ".log")).write_text(output)
        assert "federation-file-" in output, "Missing real workload output"
    run(["bun", "--no-env-file", "run", "scripts/federation-live/source.ts", "inspect"])
    source_state = json.loads((root / "source-state.json").read_text())
    assert (
        len(source_state) == 1 and source_state[0]["state"] == "accepted"
    ), "Source acceptance not confirmed"
    assert (
        source_state[0]["receipt"]["reservationId"]
        == probe["bindings"][0]["reservationId"]
    ), "Source receipt does not bind target reservation"
    sourcevisible = sourceapi("federation/outbound", token=sourcetoken)
    assert (
        len(sourcevisible["data"]) == 1
        and sourcevisible["data"][0]["state"] == "accepted"
    ), "Source HTTP status mismatch"
    (logs / "source-outbound-state.json").write_text(
        json.dumps(source_state, indent=2) + "\n"
    )
    (logs / "source-api-result.json").write_text(
        json.dumps(sourcevisible, indent=2) + "\n"
    )
    remote = sourceapi(
        "federation/outbound/" + source_state[0]["operationId"] + "/remote-status",
        token=sourcetoken,
    )
    assert remote["data"]["report"]["workflow"]["status"] == "completed", json.dumps(
        remote
    )
    assert remote["data"]["report"]["preparation"]["state"] == "resolved", json.dumps(
        remote
    )
    assert (
        remote["data"]["report"]["requestDigest"] == source_state[0]["requestDigest"]
    ), "Remote status request mismatch"
    assert (
        remote["data"]["report"]["reservationId"]
        == source_state[0]["receipt"]["reservationId"]
    ), "Remote status reservation mismatch"
    (logs / "source-remote-status.json").write_text(json.dumps(remote, indent=2) + "\n")
    print(
        "Source API verified a fresh signed remote report: resolved preparation and completed workflow",
        flush=True,
    )
    results = sourceapi(
        "federation/outbound/" + source_state[0]["operationId"] + "/results",
        token=sourcetoken,
    )
    manifest = results["data"]["report"]["manifest"]
    assert (
        len(manifest["outputs"]) == 1
    ), "Only the persistent consumer output can be released"
    output = manifest["outputs"][0]
    assert (
        output["nodeId"] == "consumer"
        and output["descriptor"] == "result"
        and output["type"] == "File"
    )
    assert output["sizeBytes"] == 12 and output["files"] == [
        {
            "path": "result",
            "sizeBytes": 12,
            "sha256": hashlib.sha256(b"verified:42\n").hexdigest(),
        }
    ]
    assert (
        results["data"]["report"]["requestDigest"] == source_state[0]["requestDigest"]
    )
    assert all(
        job["id"] not in json.dumps(results) for job in probe["jobs"]
    ), "Leaked internal Job ID"
    (logs / "source-result-manifest.json").write_text(
        json.dumps(results, indent=2) + "\n"
    )
    print(
        "Source verified result manifest: one persistent output, 12 bytes, exact SHA-256; checkpoint excluded",
        flush=True,
    )
    import ssl

    operation = source_state[0]["operationId"]
    importid = operation if scenario == "workflow" else str(uuid.uuid4())
    path = f"federation/outbound/{operation}/result-imports"
    if scenario != "workflow":
        created_import = sourceapi(path, {"importId": importid}, sourcetoken)
        assert created_import["data"]["state"] == "pending"
    result = None
    for _ in range(120):
        try:
            result = sourceapi(path + "/" + importid, token=sourcetoken)["data"]
        except urllib.error.HTTPError as error:
            if scenario != "workflow" or error.code not in (403, 404):
                raise
            time.sleep(2)
            continue
        if (
            result["state"] == "available"
            and result.get("receipt", {}).get("state") == "recorded"
        ):
            break
        time.sleep(2)
    else:
        raise RuntimeError(
            "Result import did not publish and acknowledge: " + json.dumps(result)
        )
    if scenario == "workflow":
        submitted = json.loads((root / "source-workflow.json").read_text())
        for _ in range(60):
            parent = sourceapi("workflows/" + submitted["runId"], token=sourcetoken)
            if parent["status"] in ("completed", "failed", "cancelled"):
                break
            time.sleep(2)
        assert parent["status"] == "completed", "Source workflow did not finish"
        assert parent["input"]["executionModel"] == "durable-v2"
        assert parent["result"]["status"] == {"remote": "Succeeded", "consume": "Succeeded"}
        assert parent["waitingInvocations"] == []
        assert parent["result"]["values"]["remote"]["values"]["result"]["fileMetadataId"] == result["members"][0]["fileId"]
        (logs / "source-workflow-result.json").write_text(json.dumps(parent, indent=2) + "\n")
        print("REAL COORDINATED WORKFLOW PASSED: ordinary API -> automatic market and permits -> remote Jobs -> automatic result import -> downstream File", flush=True)
    assert len(result["members"]) == 1
    member = result["members"][0]
    assert (
        member["sizeBytes"] == 12
        and member["sha256"] == hashlib.sha256(b"verified:42\n").hexdigest()
    )
    assert member["fileId"]
    file = sourceapi("netdrive/files/" + member["fileId"], token=sourcetoken)["data"]
    assert file["storageVersionId"] and file["storageVersionId"] != "null"
    assert file["path"].startswith("federation-results/" + importid + "/")
    grant = sourceapi(
        "netdrive/files/" + member["fileId"] + "/download-url", token=sourcetoken
    )
    grant = grant.get("data", grant)
    with urllib.request.urlopen(
        grant["downloadUrl"],
        context=ssl.create_default_context(cafile=str(root / "ca/ca.crt")),
        timeout=15,
    ) as response:
        body = response.read()
    assert body == b"verified:42\n", "Source cloud download bytes mismatch"
    again = sourceapi(path, {"importId": str(uuid.uuid4())}, sourcetoken)["data"]
    assert again["id"] == importid and again["members"][0]["fileId"] == member["fileId"]
    (logs / "source-result-import.json").write_text(json.dumps(result, indent=2) + "\n")
    (logs / "downloaded-result.txt").write_bytes(body)
    # Evidence contains hashes and IDs, never download credentials.
    (logs / "result-delivery-evidence.json").write_text(
        json.dumps(
            {
                "operationId": operation,
                "importId": importid,
                "fileId": member["fileId"],
                "manifestDigest": result["manifestDigest"],
                "sha256": hashlib.sha256(body).hexdigest(),
                "bytes": len(body),
                "storageVersionId": file["storageVersionId"],
                "receipt": result["receipt"],
            },
            indent=2,
        )
        + "\n"
    )
    print(
        "REAL RESULT RETURN PASSED: workflow output -> source Agent -> separate source bucket -> versioned cloud download -> signed peer acknowledgement; replay keeps one import",
        flush=True,
    )
    cached = sourceapi("federation/outbound", token=sourcetoken)["data"][0][
        "remoteStatus"
    ]
    assert (
        cached["workflow"]["status"] == "completed"
        and cached["verifiedAt"]
        and cached["lastError"] is None
    )
    assert (
        probe["materialCount"] == 2
    ), "Target material transfer did not publish both manifests"
    (logs / "material-exchange-evidence.json").write_text(
        json.dumps(
            {
                "initialTargetMaterials": 0,
                "finalTargetMaterials": probe["materialCount"],
                "operationId": source_state[0]["operationId"],
                "workflowRunId": probe["runs"][0]["id"],
                "remoteStatus": cached,
                "inputSource": "source-only manifests; fetched via production mTLS material route",
                "jobs": len(probe["jobs"]),
            },
            indent=2,
        )
        + "\n"
    )
    print(
        "REAL MATERIAL EXCHANGE PASSED: target started with zero manifests, pulled signed source inputs/lock, executed workflow and returned verified bytes",
        flush=True,
    )
    configuration = json.loads((root / "federation-probe.json").read_text())
    visible = api(
        "federation/agreements/" + configuration["agreementId"] + "/reservations",
        token=token,
        headers={"x-kq-active-organization": registration["orgId"]},
    )
    assert len(visible["data"]) == 1, "Replay created a second reservation"
    status = visible["data"][0]
    assert (
        status["preparation"]["state"] == "resolved"
        and status["workflow"]["status"] == "completed"
    ), json.dumps(status)
    assert (
        status["workflow"]["runId"] == probe["runs"][0]["id"]
        and status["workflow"]["errorCode"] is None
    )
    assert (
        "input" not in status["workflow"]
        and "result" not in status["workflow"]
        and "errorMessage" not in status["workflow"]
    )
    (logs / "reservation-api-result.json").write_text(
        json.dumps(visible, indent=2) + "\n"
    )
    print(
        "Reservation API reports completed workflow; repeated signed delivery retains one receipt and one run",
        flush=True,
    )


def verify_terminal():
    proof = json.loads((root / "ledger-proof.json").read_text())
    config = json.loads((root / "source-init.json").read_text())
    path = (
        "federation/commercial-agreements/"
        + config["request"]["agreementRevisionId"]
        + "/execution-approvals/"
        + proof["reservationId"]
        + "/terminal"
    )
    for _ in range(60):
        provider = api(path, token=token)["data"]
        source = sourceapi(path, token=sourcetoken)["data"]
        exchange = sourceapi(path + "/exchange", token=sourcetoken)["data"]
        assert not exchange["sync"] or exchange["sync"]["state"] != "needs_review", json.dumps(exchange)
        for read, auth in ((api, token), (sourceapi, sourcetoken)):
            approval = read(path.removesuffix("/terminal"), token=auth)["data"]
            assert approval["terminalAutoState"] != "needs_review", json.dumps(approval)
        if provider and source:
            break
        time.sleep(3)
    else:
        raise AssertionError("Preauthorized terminal approval did not complete")
    proposal = exchange["sync"]["proposal"]
    assert proposal["providerJws"] == provider["approvalJws"]
    assert provider["payload"]["outcome"] == "completed"
    assert len(provider["evidence"]["jobs"]) == 2
    assert provider["authorizationPolicyId"] == terminal_policies["provider"]["id"]
    assert source["authorizationPolicyId"] == terminal_policies["source"]["id"]
    assert source["digest"] == provider["digest"]
    assert source["counterpartyJws"] == provider["approvalJws"]
    assert source["sourceReview"]["result"]["importId"]
    for _ in range(40):
        view = sourceapi(path, token=sourcetoken)["data"]
        for operation in (view["submission"], view["closure"]):
            assert not operation or operation["state"] != "needs_review", json.dumps(operation)
        exchange = sourceapi(path + "/exchange", token=sourcetoken)["data"]
        assert exchange["sync"]["state"] != "needs_review", json.dumps(exchange)
        if view["closure"] and view["closure"]["state"] == "committed" and exchange["sync"]["state"] == "complete":
            break
        time.sleep(3)
    else:
        raise AssertionError("Terminal/closure did not commit: " + json.dumps(view))
    for operation in (view["submission"], view["closure"]):
        assert operation["state"] == "committed"
        assert operation["transaction"]["validationCode"] == 0
        assert operation["transaction"]["blockNumber"] is not None
    assert view["closure"]["id"] == provider["terminalId"]
    returned = api(path, token=token)["data"]
    assert returned["counterpartyJws"] == source["approvalJws"]
    for field in ("terminalId", "payload", "digest", "evidence", "approvalJws"):
        assert returned[field] == provider[field]
    (logs / "terminal-evidence.json").write_text(
        json.dumps({"provider": returned, "source": source, "status": view, "exchange": exchange, "policies": terminal_policies}, indent=2) + "\n"
    )
    print(
        "REAL PREAUTHORIZED TERMINAL AND CLOSURE PASSED: explicit institutional policies -> automatic provider approval -> mTLS evidence transfer -> automatic independent source review -> signature return and signed acknowledgement -> VALID private terminal -> VALID public closure",
        flush=True,
    )


closing_grants = {}


def grant_closing(path, kind):
    config = json.loads((root / "source-init.json").read_text())
    amount = config["request"]["maxAmount"]
    grants = {}
    # Grant the source first; the provider worker may propose as soon as its policy is stored.
    for name, read, auth in (("source", sourceapi, sourcetoken), ("provider", api, token)):
        grants[name] = read(path + "/closing-policies", {
            "kind": kind,
            "outcomes": ["completed"],
            "maxAmount": amount,
            "maxTotalAmount": amount,
            "maxRecords": 1,
            "validUntil": (datetime.now().astimezone() + timedelta(minutes=15)).isoformat(),
        }, token=auth)["data"]
    closing_grants[kind] = grants
    return grants


def automatic_closing(path, kind):
    grants = closing_grants.get(kind) or grant_closing(path, kind)
    statuses = {}
    for _ in range(60):
        tasks = api(path + "/closing-tasks", token=token)["data"]["records"]
        task = next((r for r in tasks if r["kind"] == kind), None)
        assert not task or task["state"] != "needs_review", json.dumps(task)
        for name, read, auth in (("provider", api, token), ("source", sourceapi, sourcetoken)):
            records = read(path + "/" + kind + "s", token=auth)["data"]["data"]
            assert len(records) <= 1, "Automation generated more than one original"
            if records:
                statuses[name] = {"record": records[0]}
        if task and task["state"] == "complete" and len(statuses) == 2:
            break
        time.sleep(3)
    else:
        raise AssertionError("Automatic " + kind + " did not complete: " + json.dumps(statuses))
    originals = {name: v["record"][kind] for name, v in statuses.items()}
    assert originals["provider"]["payload"] == originals["source"]["payload"]
    assert originals["provider"]["approvalJws"] == originals["source"]["counterpartyJws"]
    assert originals["source"]["approvalJws"] == originals["provider"]["counterpartyJws"]
    assert task["recordId"] == originals["provider"][kind + "Id"]
    for name, read, auth in (("provider", api, token), ("source", sourceapi, sourcetoken)):
        assert originals[name]["authorizationPolicyId"] == grants[name]["id"]
        policies = read(path + "/closing-policies", token=auth)["data"]
        policy = next(r for r in policies if r["id"] == grants[name]["id"])
        assert policy["approvedRecords"] == 1
        expected = (originals[name]["payload"]["calculation"]["dueAmount"] if kind == "bill"
                    else originals[name]["payload"]["chargedAmount"])
        assert policy["approvedAmount"] == expected
        grants[name] = policy
    (logs / (kind + "-automatic-policies.json")).write_text(json.dumps({"policies": grants, "task": task}, indent=2) + "\n")
    return originals["provider"]["payload"], statuses


def verify_billing():
    config = json.loads((root / "source-init.json").read_text())
    reservation_id = (json.loads((root / "ledger-proof.json").read_text())["reservationId"] if coordinated
                      else json.loads((root / "source-state.json").read_text())[0]["receipt"]["reservationId"])
    path = "federation/commercial-agreements/" + config["request"]["agreementRevisionId"]
    usagepath = path + "/usage/" + reservation_id
    receivedpath = path + "/received-usage/" + config["request"]["operationId"]
    for _ in range(60):
        usage = api(usagepath, token=token)["data"]
        received = sourceapi(receivedpath, token=sourcetoken)["data"]
        assert usage["task"]["state"] != "needs_review", json.dumps(usage["task"])
        assert not received["sync"] or received["sync"]["state"] != "needs_review", json.dumps(received["sync"])
        if usage["reports"] and usage["reports"][0]["ledgerState"] == ("committed" if coordinated else "pending" if attested else None) and received["reports"]:
            break
        time.sleep(3)
    else:
        raise AssertionError("Real workload usage did not reach both institutions: " + json.dumps({"usage": usage, "received": received}))
    report = usage["reports"][0]
    assert len(usage["reports"]) == len(received["reports"]) == 1
    assert received["reports"][0]["reportJws"] == report["reportJws"]
    assert received["reports"][0]["report"] == report["report"]
    runtime = json.loads((logs / "runtime-gate-result.json").read_text())
    total = 0
    pods = []
    for job in runtime["jobs"]:
        if self_account:
            observed = k(["exec", "-n", namespace, "scheduler", "--", "sacct", "--noheader", "--parsable2", "--allocations", "--jobs", job["schedulerJobId"], "--format=JobIDRaw,ElapsedRaw"]).stdout
            rows = [row.strip().split("|") for row in observed.splitlines() if row.strip()]
            assert len(rows) == 1 and rows[0][0] == job["schedulerJobId"] and rows[0][1].isdigit(), observed
            elapsed = int(rows[0][1]) * 1000
            total += elapsed
            pods.append({"scheduler": "slurm", "schedulerJobId": job["schedulerJobId"], "elapsedMilliseconds": elapsed})
            continue
        observed = json.loads(k(["get", "pods", "-n", namespace, "-l", "job-name=" + job["schedulerJobId"], "-o", "json"]).stdout)["items"]
        assert len(observed) == 1
        pod = observed[0]
        statuses = pod["status"]["containerStatuses"]
        assert len(statuses) == 1 and statuses[0]["restartCount"] == 0
        duration = statuses[0]["state"]["terminated"]
        start = datetime.fromisoformat(duration["startedAt"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(duration["finishedAt"].replace("Z", "+00:00"))
        total += (end - start) // timedelta(milliseconds=1)
        pods.append(pod)
    measured = report["report"]["measurements"]
    assert len(measured) == 1 and measured[0]["metric"] == "job.elapsed"
    assert measured[0]["quantityUnit"] == "job-millisecond" and int(measured[0]["quantity"]) == total
    assert total >= 1000, "Positive billing requires actual measured scheduler runtime"
    expected_gross = (total + 999) // 1000
    if coordinated:
        orderer("stop")
    try:
        draft, statuses = automatic_closing(path, "bill")
        bill_id = draft["billId"]
        assert draft["reportId"] == report["id"]
        assert int(draft["calculation"]["grossAmount"]) == expected_gross
        assert int(draft["calculation"]["dueAmount"]) == min(expected_gross, int(config["request"]["maxAmount"]))
        if coordinated or attested:
            assert statuses["provider"]["record"]["ledger"]["state"] == "pending"
        else:
            assert statuses["provider"]["record"]["ledger"] is None
        assert statuses["source"]["record"]["ledger"] is None
        (logs / "billing-offline-evidence.json").write_text(json.dumps({"usage": usage, "received": received, **({"slurm": pods} if self_account else {"pods": pods}), "draft": draft, "statuses": statuses}, indent=2) + "\n")
        print("REAL BILL EXCHANGE PASSED: measured " + ("Slurm sacct runtime" if self_account else "Kubernetes runtime") + " -> signed usage over mTLS -> independent institution policies -> automatic draft, approvals and original signatures; " + ("Orderer stopped" if coordinated or attested else "no commercial ledger configured"), flush=True)
    finally:
        if coordinated:
            orderer("start")
    if not coordinated:
        return None
    submission_id = statuses["provider"]["record"]["ledger"]["id"]
    for _ in range(60):
        rows = api(path + "/bills", token=token)["data"]["data"]
        assert len(rows) == 1 and rows[0]["bill"]["billId"] == bill_id
        record = rows[0]["ledger"]
        assert record["id"] == submission_id
        assert record["state"] != "needs_review", json.dumps(record)
        if record["state"] == "committed":
            break
        time.sleep(3)
    else:
        raise AssertionError("Original bill intent did not commit after Orderer recovery")
    return record


def verify_settlement():
    config = json.loads((root / "source-init.json").read_text())
    bill = json.loads((logs / "billing-offline-evidence.json").read_text())["draft"]
    path = "federation/commercial-agreements/" + config["request"]["agreementRevisionId"]
    orderer("stop")
    try:
        draft, statuses = automatic_closing(path, "settlement")
        assert draft["billId"] == bill["billId"]
        assert draft["chargedAmount"] == bill["calculation"]["dueAmount"]
        assert int(draft["reservedAmount"]) == int(draft["chargedAmount"]) + int(draft["releasedAmount"])
        assert int(draft["chargedAmount"]) > 0 and int(draft["releasedAmount"]) > 0
        for value in statuses.values():
            assert value["record"]["settlement"]["appliedAt"] is None
            assert value["record"]["ledger"]["state"] == "pending"
        inspect_ledgers("settlement-offline")
        for name in ("provider", "source"):
            local = json.loads((logs / (name + "-settlement-offline.json")).read_text())
            assert not local["budgets"]
            for task in local["reservations"] + local["outbound"]:
                assert task["settledAmount"] is None, "Unconfirmed settlement released a local slot"
        (logs / "settlement-offline-evidence.json").write_text(json.dumps({"draft": draft, "statuses": statuses}, indent=2) + "\n")
        print("REAL SETTLEMENT EXCHANGE PASSED: independent institution policies -> automatic draft and approvals over mTLS while Orderer stopped; no local slot or balance released", flush=True)
    finally:
        orderer("start")
    original_ids = {name: value["record"]["ledger"]["id"] for name, value in statuses.items()}
    for _ in range(80):
        for name, read, auth in (("provider", api, token), ("source", sourceapi, sourcetoken)):
            rows = read(path + "/settlements", token=auth)["data"]["data"]
            assert len(rows) == 1
            value = rows[0]
            assert value["ledger"]["id"] == original_ids[name]
            assert value["ledger"]["state"] != "needs_review", json.dumps(value["ledger"])
            statuses[name]["record"] = value
        if all(v["record"]["settlement"]["appliedAt"] and v["record"]["ledger"]["state"] == "committed" for v in statuses.values()):
            break
        time.sleep(3)
    else:
        raise AssertionError("Original settlements did not reach VALID and local accounting after recovery")
    inspect_ledgers("settlement-committed")
    transactions = {}
    for name in ("provider", "source"):
        local = json.loads((logs / (name + "-settlement-committed.json")).read_text())
        before = json.loads((logs / (name + "-settlement-offline.json")).read_text())
        assert local["gate"] == before["gate"] and local["demand"] == before["demand"]
        assert local["execution"] == before["execution"] and not local["budgets"]
        tasks = local["reservations"] if name == "provider" else local["outbound"]
        assert len(tasks) == 1 and tasks[0]["amount"] == draft["reservedAmount"] and tasks[0]["settledAmount"] == draft["chargedAmount"]
        attempts = [r for r in local["commercialTransactions"] if r["submissionId"] == original_ids[name]]
        valid = [r for r in attempts if r["stage"] == "committed" and r["validationCode"] == 0 and r["blockNumber"] is not None]
        assert len(valid) == 1
        transactions[name] = attempts
    evidence = {"draft": draft, "statuses": statuses, "transactions": transactions, "budgetDomainId": config["request"]["budgetDomainId"], "epoch": config["request"]["epoch"], "evidenceDirectory": str(logs)}
    (logs / "settlement-committed-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    (networkroot / "live-settlement-proof.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print("REAL SETTLEMENT RECOVERY PASSED: original submissions VALID -> both local slots released; no local chain balance and terminal gate remains closed", flush=True)


def verify_bilateral_finance():
    assert not coordinated
    config = json.loads((root / "source-init.json").read_text())
    path = "federation/commercial-agreements/" + config["request"]["agreementRevisionId"]
    draft, statuses = automatic_closing(path, "settlement")
    bill = json.loads((logs / "billing-offline-evidence.json").read_text())["draft"]
    assert draft["billId"] == bill["billId"] and draft["chargedAmount"] == bill["calculation"]["dueAmount"]
    assert draft["reservationId"] is None and draft["terminal"] is None
    assert int(draft["chargedAmount"]) > 0
    for name, value in statuses.items():
        assert value["record"]["settlement"]["appliedAt"]
        assert value["record"]["ledger"]["state"] == "pending" if attested and name == "provider" else value["record"]["ledger"] is None
    parties = (("provider", api, token), ("source", sourceapi, sourcetoken))

    def accounting(label, amount):
        inspect_ledgers(label)
        result = {}
        for name, _, _ in parties:
            local = json.loads((logs / (name + "-" + label + ".json")).read_text())
            tasks = local["reservations"] if name == "provider" else local["outbound"]
            assert len(tasks) == 1 and tasks[0]["amount"] == config["request"]["maxAmount"] and tasks[0]["settledAmount"] == amount
            if name == "provider":
                assert len(local["budgets"]) == 1
                budget = local["budgets"][0]
                assert budget["spent"] == amount and budget["reserved"] == "0"
                assert int(budget["available"]) == int(config["terms"]["budgetLimit"]) - int(amount)
            else:
                assert not local["budgets"] and tasks[0]["adjustmentHeldAmount"] == "0"
            result[name] = local
        return result

    original = accounting("bilateral-settled", draft["chargedAmount"])
    for name, read, auth in parties:
        replay = read(path + "/settlements/approve", draft, auth)["data"]
        assert replay == statuses[name]["record"]["settlement"]
    if disclosure_scenario:
        print("REAL DISCLOSURE BILLING READY: measured job, bilateral bill and applied settlement; no commercial ledger configured", flush=True)
        return
    previous = None
    for number, amount in enumerate(("0", draft["chargedAmount"]), 1):
        adjustment = api(path + "/adjustments/draft", {"settlementId": draft["settlementId"], "adjustmentId": str(uuid.uuid4()), "chargedAmount": amount, "reason": "Isolated bilateral accounting " + str(number), "supportingEvidenceDigest": None}, token)["data"]
        assert adjustment["previous"] == previous
        delta = int(amount) - int(adjustment["previousChargedAmount"])
        source_approval = sourceapi(path + "/adjustments/approve", adjustment, sourcetoken)["data"]
        assert int(source_approval["heldAmount"]) == max(delta, 0) and source_approval["appliedAt"] is None
        api(path + "/adjustments/approve", adjustment, token)
        records = {}
        for _ in range(90):
            for name, read, auth in parties:
                rows = read(path + "/adjustments?recordId=" + adjustment["adjustmentId"] + "&settlementId=" + draft["settlementId"], token=auth)["data"]
                assert len(rows["data"]) == 1
                records[name] = rows["data"][0]
                assert records[name]["adjustment"]["payload"] == adjustment
                if attested and name == "provider":
                    assert records[name]["ledger"] is None or records[name]["ledger"]["state"] == "pending"
                else:
                    assert records[name]["ledger"] is None
            if all(v["adjustment"]["appliedAt"] for v in records.values()):
                break
            time.sleep(2)
        else:
            raise AssertionError("Bilateral adjustment did not apply automatically")
        if attested:
            assert records["provider"]["ledger"]["state"] == "pending"
        for name, read, auth in parties:
            replay = read(path + "/adjustments/approve", adjustment, auth)["data"]
            assert replay == records[name]["adjustment"]
            other = records["source" if name == "provider" else "provider"]["adjustment"]
            assert replay["counterpartyJws"] == other["approvalJws"]
        after = accounting("bilateral-adjustment-" + str(number), amount)
        for name, local in after.items():
            for key in ("bills", "settlements", "execution"):
                assert local[key] == original[name][key], "Bilateral adjustment rewrote original " + key
            assert len(local["adjustments"]) == number
        previous = {"adjustmentId": adjustment["adjustmentId"], "digest": records["provider"]["adjustment"]["digest"]}
        (logs / ("bilateral-adjustment-" + str(number) + ".json")).write_text(json.dumps({"draft": adjustment, "records": records}, indent=2) + "\n")
    (logs / "bilateral-settlement.json").write_text(json.dumps({"draft": draft, "statuses": statuses}, indent=2) + "\n")
    print("REAL BILATERAL ACCOUNTING PASSED: task-preauthorized bill and settlement; exact local budget; debit hold; original settlement and two adjustments replay safely; " + ("Orderer remains stopped" if attested else "no ledger configuration, attempts or outbox"), flush=True)



def verify_payments():
    config = json.loads((root / "source-init.json").read_text())
    path = "federation/commercial-agreements/" + config["request"]["agreementRevisionId"]
    bill = json.loads((logs / "billing-offline-evidence.json").read_text())["draft"]
    parties = (("provider", api, token), ("source", sourceapi, sourcetoken))
    inspect_ledgers("payment-before")
    before = {name: json.loads((logs / (name + "-payment-before.json")).read_text()) for name, _, _ in parties}
    synthetic_evidence = b"Isolated payment acknowledgement fixture; no bank transfer.\n"
    (logs / "payment-evidence.txt").write_bytes(synthetic_evidence)
    evidence_digest = "sha256:" + hashlib.sha256(synthetic_evidence).hexdigest()
    assert config["commercial"]["consideration"] == "paid", "Payment acceptance requires a paid contract"
    payment_id, previous, originals = str(uuid.uuid4()), None, []
    for number, amount in enumerate((bill["calculation"]["dueAmount"], "0"), 1):
        if coordinated:
            orderer("stop")
        body = {
            "receiptId": str(uuid.uuid4()), "paymentId": payment_id, "billId": bill["billId"],
            "amount": amount, "occurredAt": bill["issuedAt"], "evidenceDigest": evidence_digest,
            "reason": "Synthetic external receipt " + str(number) + "; no money transfer",
        }
        draft = api(path + "/payments/draft", body, token)["data"]
        assert draft["previous"] == previous
        assert all(draft[key] == value for key, value in body.items())
        first = sourceapi(path + "/payments/approve", draft, sourcetoken)["data"]
        assert not first["current"] and first["confirmedAt"] is None and first["counterpartyJws"] is None
        api(path + "/payments/approve", draft, token)
        records = {}
        for _ in range(60):
            for name, read, auth in parties:
                history = read(path + "/payments?recordId=" + draft["receiptId"], token=auth)["data"]
                assert len(history["data"]) == 1 and not history["hasMore"]
                records[name] = history["data"][0]
                assert records[name]["payment"]["payload"] == draft
                if mode != "bilateral_direct" and name == "provider":
                    assert records[name]["ledger"] is None or records[name]["ledger"]["state"] == "pending"
                else:
                    assert records[name]["ledger"] is None
            if all(row["payment"]["confirmedAt"] and row["payment"]["current"] for row in records.values()):
                break
            time.sleep(2)
        else:
            raise AssertionError("Payment signatures did not exchange between real platforms")
        for name, read, auth in parties:
            row = records[name]["payment"]
            other = records["source" if name == "provider" else "provider"]["payment"]
            assert row["counterpartyJws"] == other["approvalJws"]
            if mode != "bilateral_direct" and name == "provider":
                assert records[name]["ledger"]["state"] == "pending"
            assert read(path + "/payments/approve", draft, auth)["data"] == row
        if coordinated:
            verify_payment_recovery(path, draft, records, number, config)
        previous = {"receiptId": draft["receiptId"], "digest": records["provider"]["payment"]["digest"]}
        originals.append({"draft": draft, "records": records})
    for name, read, auth in parties:
        old = read(path + "/payments/approve", originals[0]["draft"], auth)["data"]
        assert not old["current"] and old["payload"] == originals[0]["draft"]
        history = read(path + "/payments?paymentId=" + payment_id + "&billId=" + bill["billId"], token=auth)["data"]
        assert not history["hasMore"] and len(history["data"]) == 2
        current = [row["payment"] for row in history["data"] if row["payment"]["current"]]
        assert len(current) == 1 and current[0]["receiptId"] == previous["receiptId"] and current[0]["payload"]["amount"] == "0"
    inspect_ledgers("payment-after")
    for name, _, _ in parties:
        after = json.loads((logs / (name + "-payment-after.json")).read_text())
        for key in ("budgets", "bills", "settlements", "adjustments", "execution"):
            assert after[key] == before[name][key], "Payment changed accounting or execution: " + key
        assert len(after["payments"]) == 2
        if mode != "bilateral_direct":
            assert len(after["commercial"]) == len(before[name]["commercial"]) + (2 if name == "provider" else 0)
            assert all(row["state"] == ("committed" if coordinated else "pending") for row in after["commercial"])
        else:
            assert not after["commercial"] and not after["commercialTransactions"]
    (logs / ("coordinated-payments.json" if coordinated else "bilateral-payments.json")).write_text(json.dumps(originals, indent=2) + "\n")
    print("REAL PAYMENTS PASSED: independent approvals, automatic original-signature exchange, zero correction, old replay, unchanged accounting/execution; " + ("Orderer remains stopped" if attested else "original VALID after recovery" if coordinated else "no ledger"), flush=True)


def verify_payment_recovery(path, draft, records, number, config):
    assert coordinated
    label = "payment-" + str(number)
    submission_id = records["provider"]["ledger"]["id"]
    parties = (("provider", api, token), ("source", sourceapi, sourcetoken))

    def refresh():
        for name, read, auth in parties:
            value = read(path + "/payments?recordId=" + draft["receiptId"], token=auth)["data"]
            assert len(value["data"]) == 1 and not value["hasMore"]
            record = value["data"][0]
            assert record["payment"] == records[name]["payment"], "Ledger recovery changed acknowledged payment"
            if name == "source":
                assert record["ledger"] is None
            else:
                assert record["ledger"]["id"] == submission_id and record["ledger"]["state"] != "needs_review"
            records[name] = record

    try:
        for _ in range(60):
            inspect_ledgers(label + "-offline")
            offline = {name: json.loads((logs / (name + "-" + label + "-offline.json")).read_text()) for name, _, _ in parties}
            checkpoints = [row for row in offline["provider"]["commercialTransactions"] if row["submissionId"] == submission_id]
            if len(checkpoints) == 1 and checkpoints[0]["stage"] == "transaction" and checkpoints[0]["recoveryDigest"]:
                break
            time.sleep(3)
        else:
            raise AssertionError("Payment did not persist original endorsed transaction")
        if number == 1:
            recovery = restart_commercial_servers()
            refresh()
            inspect_ledgers(label + "-restarted")
            for name, _, _ in parties:
                restarted = json.loads((logs / (name + "-" + label + "-restarted.json")).read_text())
                for key in ("budgets", "reservations", "outbound", "payments", "bills", "settlements", "adjustments", "execution", "gate", "demand"):
                    assert restarted[key] == offline[name][key], "Payment restart changed " + key
                if name == "provider":
                    assert [row for row in restarted["commercialTransactions"] if row["submissionId"] == submission_id] == checkpoints
            assert records["provider"]["ledger"]["state"] == "pending"
            (logs / "payment-crash-recovery.json").write_text(json.dumps({**recovery, "checkpoints": checkpoints}, indent=2) + "\n")
    finally:
        orderer("start")
    for _ in range(100):
        refresh()
        if records["provider"]["ledger"]["state"] == "committed":
            break
        time.sleep(3)
    else:
        raise AssertionError("Payment original transaction did not recover to VALID")
    inspect_ledgers(label + "-committed")
    for name, _, _ in parties:
        local = json.loads((logs / (name + "-" + label + "-committed.json")).read_text())
        for key in ("budgets", "reservations", "outbound", "payments", "bills", "settlements", "adjustments", "execution", "gate", "demand"):
            assert local[key] == offline[name][key], "Payment evidence changed " + key
        if name == "provider":
            attempts = [row for row in local["commercialTransactions"] if row["submissionId"] == submission_id]
            valid = [row for row in attempts if row["stage"] == "committed" and row["validationCode"] == 0 and row["blockNumber"] is not None]
            assert len(valid) == 1
            recovered = next(row for row in attempts if row["transactionId"] == checkpoints[0]["transactionId"])
            assert recovered in valid, "Payment replaced its original transaction instead of recovering it"
            assert recovered["recoveryDigest"] == checkpoints[0]["recoveryDigest"]
    evidence = {"draft": draft, "statuses": {name: {"record": row} for name, row in records.items()}, "transactions": {"provider": attempts}, "budgetDomainId": config["request"]["budgetDomainId"], "epoch": config["request"]["epoch"], "evidenceDirectory": str(logs)}
    (logs / (label + "-committed-evidence.json")).write_text(json.dumps(evidence, indent=2) + "\n")
    (networkroot / ("live-" + label + "-proof.json")).write_text(json.dumps(evidence, indent=2) + "\n")
    print("REAL COORDINATED PAYMENT RECOVERY PASSED: " + label + " acknowledged offline; original transaction VALID after recovery; local money facts and execution gate unchanged", flush=True)


def verify_refund():
    global sourcegateway, gateway
    assert not coordinated
    config = json.loads((root / "source-init.json").read_text())
    request = config["request"]
    operation = request["operationId"]
    path = "federation/commercial-agreements/" + request["agreementRevisionId"] + "/refunds"
    parties = (("provider", api, token), ("source", sourceapi, sourcetoken))
    grants = {}
    closing_path = "federation/commercial-agreements/" + request["agreementRevisionId"]
    if automatic_refund:
        for name, read, auth in parties:
            grants[name] = read(closing_path + "/closing-policies", {
                "kind": "refund", "outcomes": ["cancelled"],
                "maxAmount": request["maxAmount"], "maxTotalAmount": request["maxAmount"],
                "maxRecords": 1, "validUntil": (datetime.now().astimezone() + timedelta(hours=1)).isoformat(),
            }, auth)["data"]
    # Withhold the source material endpoint, not source admission prerequisites.
    assert sourcegateway.poll() is None
    sourcegateway.terminate()
    assert sourcegateway.wait(timeout=15) == 0
    first = sourceapi("federation/outbound", request, sourcetoken)["data"]
    assert sourceapi("federation/outbound", request, sourcetoken)["data"]["operationId"] == first["operationId"]
    for _ in range(90):
        run(["bun", "--no-env-file", "scripts/federation-live/target.ts", "inspect"])
        state = json.loads((root / "probe-state.json").read_text())
        assert not state["runs"] and not state["jobs"] and not state["bindings"]
        rows = sourceapi("federation/outbound", token=sourcetoken)["data"]
        assert len(rows) == 1
        if rows[0]["state"] == "accepted" and any(row["state"] == "waiting" and row["blocker"] == "DATA_WAITING" for row in state["preparations"]):
            break
        time.sleep(2)
    else:
        raise AssertionError("Task did not reach real material waiting before execution")
    inspect_ledgers("refund-reserved")
    before = json.loads((logs / "provider-refund-reserved.json").read_text())
    assert len(before["reservations"]) == 1 and len(before["budgets"]) == 1
    assert before["budgets"][0]["reserved"] == request["maxAmount"]
    assert int(before["budgets"][0]["available"]) == int(config["terms"]["budgetLimit"]) - int(request["maxAmount"])
    assert before["budgets"][0]["spent"] == "0"
    (logs / "refund-waiting.json").write_text(json.dumps(state, indent=2) + "\n")
    cancel_path = "federation/outbound/" + operation + "/cancel"
    if disk_pressure:
        gateway.terminate()
        assert gateway.wait(timeout=15) == 0
    requested_cancel = sourceapi(cancel_path, {}, sourcetoken)["data"]
    if disk_pressure:
        assert requested_cancel["state"] == "queued"
        (logs / "storage-cancellation-intent.json").write_text(json.dumps(requested_cancel, indent=2) + "\n")
        recover_full_storage()
    for _ in range(90):
        cancelled = sourceapi("federation/outbound", token=sourcetoken)["data"][0]
        assert cancelled["cancellation"]["state"] != "needs_review"
        if cancelled["cancellation"]["state"] == "stopped":
            break
        time.sleep(2)
    else:
        raise AssertionError("Provider cancellation receipt did not return over mTLS")
    assert sourceapi(cancel_path, {}, sourcetoken)["data"] == cancelled["cancellation"]
    sourcegateway = subprocess.Popen(
        ["node", str(root / "gateway.mjs")], cwd=repo, env=sourcegatewayenv, stdout=sourcelog, stderr=sourcelog,
    )
    if automatic_refund:
        records = {}
        for _ in range(90):
            for name, read, auth in parties:
                rows = read(path, token=auth)["data"]["data"]
                assert len(rows) <= 1
                if rows:
                    records[name] = rows[0]
            if len(records) == 2 and all(row["appliedAt"] for row in records.values()):
                break
            time.sleep(2)
        else:
            raise AssertionError("Independent refund policies did not complete automatically")
        draft = records["source"]["payload"]
        for _ in range(30):
            tasks = sourceapi(closing_path + "/closing-tasks", token=sourcetoken)["data"]["records"]
            if len(tasks) == 1 and tasks[0]["state"] == "complete":
                break
            time.sleep(2)
        else:
            raise AssertionError("Automatic refund task did not drain")
        assert tasks[0]["referenceId"] == operation and tasks[0]["recordId"] == draft["refundId"]
        for name, read, auth in parties:
            assert records[name]["authorizationPolicyId"] == grants[name]["id"]
            policies = read(closing_path + "/closing-policies", token=auth)["data"]
            assert len(policies) == 1 and policies[0]["approvedRecords"] == 1
            assert policies[0]["approvedAmount"] == request["maxAmount"]
            read(closing_path + "/closing-policies/" + grants[name]["id"] + "/revoke", {}, auth)
        # Retrying an already completed task cannot issue another refund, even after revocation.
        try:
            sourceapi(closing_path + "/closing-tasks/refund/" + operation + "/retry", {}, sourcetoken)
        except urllib.error.HTTPError as error:
            assert error.code == 409 and json.load(error)["error"]["code"] == "OPERATION_CONFLICT"
        else:
            raise AssertionError("Completed refund task accepted a retry")
        for name, read, auth in parties:
            assert read(path, token=auth)["data"]["data"] == [records[name]]
        (logs / "refund-automatic-policies.json").write_text(json.dumps({"policies": grants, "tasks": tasks}, indent=2) + "\n")
    else:
        draft = sourceapi(path + "/draft", {"operationId": operation, "refundId": str(uuid.uuid4()), "reason": "Cancelled while waiting for input"}, sourcetoken)["data"]
        approvals = {"source": sourceapi(path + "/approve", draft, sourcetoken)["data"]}
        assert approvals["source"]["appliedAt"] is None
        assert not api(path, token=token)["data"]["data"], "Exchange must not invent provider approval"
        approvals["provider"] = api(path + "/approve", draft, token)["data"]
        records = {}
        for _ in range(90):
            for name, read, auth in parties:
                rows = read(path + "?recordId=" + draft["refundId"], token=auth)["data"]["data"]
                assert len(rows) == 1
                records[name] = rows[0]
                assert rows[0]["payload"] == draft and rows[0]["approvalJws"] == approvals[name]["approvalJws"]
            if all(row["appliedAt"] for row in records.values()):
                break
            time.sleep(2)
        else:
            raise AssertionError("Refund original signatures did not exchange automatically")
    assert draft["request"] == request and draft["releasedAmount"] == request["maxAmount"]
    assert draft["cancellationReceiptJws"]
    for name, read, auth in parties:
        record = records[name]
        assert record["payload"] == draft
        assert record["counterpartyJws"] == records["source" if name == "provider" else "provider"]["approvalJws"]
        assert record["ledger"]["state"] == "pending" if attested and name == "provider" else record["ledger"] is None
        if not automatic_refund:
            replay = read(path + "/approve", draft, auth)["data"]
            assert replay == {key: value for key, value in record.items() if key != "ledger"}
            assert read(path + "/" + draft["refundId"] + "/counterparty", {"approvalJws": record["counterpartyJws"]}, auth)["data"] == replay
            try:
                read(path + "/approve", {**draft, "refundId": str(uuid.uuid4())}, auth)
            except urllib.error.HTTPError as error:
                assert error.code == 409 and json.load(error)["error"]["code"] == "OPERATION_CONFLICT"
            else:
                raise AssertionError("Replacement refund ID returned the same reservation twice")
    inspect_ledgers("refund-applied")
    for name, _, _ in parties:
        local = json.loads((logs / (name + "-refund-applied.json")).read_text())
        tasks = local["reservations"] if name == "provider" else local["outbound"]
        assert len(tasks) == 1 and tasks[0]["amount"] == request["maxAmount"] and tasks[0]["settledAmount"] == "0"
        assert len(local["refunds"]) == 1 and local["refunds"][0]["appliedAt"]
        for key in ("execution", "bindings", "bills", "settlements", "adjustments"):
            assert not local[key], "Preexecution refund unexpectedly created " + key
        if name == "provider":
            assert len(local["budgets"]) == 1
            budget = local["budgets"][0]
            assert budget["available"] == config["terms"]["budgetLimit"] and budget["reserved"] == budget["spent"] == "0"
        else:
            assert not local["budgets"] and tasks[0]["adjustmentHeldAmount"] == "0"
    if disk_pressure and attested:
        evidence = logs / "provider-storage-awaiting-ledger.json"
        for _ in range(60):
            storage_command(env, "snapshot", evidence)
            held = json.loads(evidence.read_text())
            assert len(held["claims"]) == 1 and held["claims"][0]["releasedAt"] is None
            assert held["capacity"]["allocatedBytes"] == "16777216"
            if held["claims"][0]["releaseBlocker"] == "refund-ledger":
                break
            time.sleep(2)
        else:
            raise AssertionError("Capacity worker did not verify the pending original refund ledger")
    (logs / "refund-evidence.json").write_text(json.dumps({"draft": draft, "cancellation": cancelled["cancellation"], "records": records}, indent=2) + "\n")
    print(("REAL AUTOMATIC REFUND PASSED: " if automatic_refund else "REAL BILATERAL REFUND PASSED: ") + " material waiting -> permanent cancellation over mTLS -> independent approvals -> automatic original signatures; reservation returned exactly once; replay safe; no Workflow or Jobs; " + ("Orderer remains stopped" if attested else "no commercial ledger configured"), flush=True)


def verify_attested_recovery():
    config = json.loads((root / "source-init.json").read_text())
    for _ in range(60):
        inspect_ledgers("attested-offline")
        offline = {name: json.loads((logs / (name + "-attested-offline.json")).read_text()) for name in ("source", "provider")}
        provider = offline["provider"]
        assert len(provider["attestationOutbox"]) == 2
        assert len(provider["commercial"]) == (2 if refund_scenario else 8) and len(offline["source"]["commercial"]) == 1
        for state in offline.values():
            assert all(row["state"] == "pending" for row in state["commercial"])
            assert all(row["state"] == "pending" for row in state["evidenceBatches"])
            assert all(row["stage"] in ("proposal", "transaction") for row in state["commercialTransactions"] + state["attestationAttempts"])
        if provider["attestationAttempts"] and all(row["stage"] == "transaction" for row in provider["attestationAttempts"]) and all(state["commercialTransactions"] and all(row["stage"] == "transaction" for row in state["commercialTransactions"]) for state in offline.values()):
            break
        time.sleep(3)
    else:
        raise AssertionError("Pending admission evidence did not persist an endorsed checkpoint")
    assert not offline["source"]["attestationOutbox"] and not offline["source"]["evidenceBatches"]
    query = "federation/agreements/" + config["request"]["agreementRevisionId"] + "/attestation"
    view = api(query, token=token)["data"]
    assert view["enabled"] and view["batches"] and all(row["state"] == "pending" for row in view["batches"])
    (logs / "attested-offline-api.json").write_text(json.dumps(view, indent=2) + "\n")
    print("REAL ATTESTED OFFLINE PASSED: " + scenario + " finished locally while Orderer stopped; original commercial and admission evidence remains pending", flush=True)
    if refund_scenario or scenario == "success":
        recovery = restart_commercial_servers()
        (logs / ("refund-crash-recovery.json" if refund_scenario else "payment-crash-recovery.json")).write_text(json.dumps(recovery, indent=2) + "\n")
    orderer("start")
    for _ in range(160):
        inspect_ledgers("attested-recovered")
        recovered = {name: json.loads((logs / (name + "-attested-recovered.json")).read_text()) for name in ("source", "provider")}
        for name, state in recovered.items():
            assert all(row["state"] != "needs_review" for row in state["commercial"]), "Commercial recovery needs review: " + json.dumps([{ "id": row["id"], "operation": row["input"]["operation"], "state": row["state"], "lastError": row["lastError"] } for row in state["commercial"]])
            assert all(row["state"] != "needs_review" for row in state["evidenceBatches"]), "Admission evidence needs review"
            assert {(row["id"], json.dumps(row["input"], sort_keys=True)) for row in state["commercial"]} == {(row["id"], json.dumps(row["input"], sort_keys=True)) for row in offline[name]["commercial"]}
            for key in ("budgets", "reservations", "outbound", "bills", "settlements", "adjustments", "refunds", "payments", "execution"):
                assert state[key] == offline[name][key], "Attestation changed local accounting or execution: " + key
            assert {row["evidenceId"] for row in state["attestationOutbox"]} == {row["evidenceId"] for row in offline[name]["attestationOutbox"]}
            for original in offline[name]["evidenceBatches"]:
                same = next(row for row in state["evidenceBatches"] if row["id"] == original["id"])
                for key in ("manifest", "digest", "issuerJws"):
                    assert same[key] == original[key], "Recovery replaced original signed batch"
            for key, identity in (("commercialTransactions", "submissionId"), ("attestationAttempts", "batchId")):
                for original in offline[name][key]:
                    same = next(row for row in state[key] if row["transactionId"] == original["transactionId"])
                    assert same[identity] == original[identity] and same["recoveryDigest"] == original["recoveryDigest"]
        if all(row["state"] == "committed" for state in recovered.values() for row in state["commercial"]) and all(row["state"] == "anchored" for row in recovered["provider"]["attestationOutbox"]):
            break
        time.sleep(3)
    else:
        raise AssertionError("Original attested records did not recover to VALID")
    provider = recovered["provider"]
    assert len(provider["attestationOutbox"]) == 2
    assert all(row["state"] == "anchored" for row in provider["evidenceBatches"])
    assert sorted(record["sequence"] for row in provider["evidenceBatches"] for record in row["manifest"]["records"]) == ["1", "2"]
    assert {record["kind"] for row in provider["evidenceBatches"] for record in row["manifest"]["records"]} == {"delegation", "acceptance"}
    view = api(query, token=token)["data"]
    assert view["unbatchedEvidenceCount"] == 0 and all(row["state"] == "anchored" for row in view["batches"])
    (logs / "attested-recovered-api.json").write_text(json.dumps(view, indent=2) + "\n")
    (networkroot / "live-attested-proof.json").write_text(json.dumps({"evidenceDirectory": str(logs), "config": config, "scenario": scenario}, indent=2) + "\n")
    print("REAL ATTESTED RECOVERY PASSED: original commercial submissions VALID and admission evidence anchored; exact local balances, original signatures, Jobs and recovery checkpoints unchanged", flush=True)


def verify_native_dispute():
    config = json.loads((root / "source-init.json").read_text())
    path = "federation/commercial-agreements/" + config["request"]["agreementRevisionId"]
    parties = (("source", sourceapi, sourcetoken), ("provider", api, token))
    inspect_ledgers("freeze-before")
    before = {name: json.loads((logs / (name + "-freeze-before.json")).read_text()) for name, _, _ in parties}
    bill = before["source"]["bills"][0]
    unchanged = ("budgets", "reservations", "outbound", "bills", "settlements", "adjustments", "payments", "execution", "gate", "demand")
    orderer("stop")
    try:
        draft = sourceapi(path + "/disputes/draft", {
            "caseId": str(uuid.uuid4()),
            "subject": {"recordType": "bill", "recordId": bill["billId"], "recordDigest": bill["digest"]},
            "reason": "Private original usage review " + uuid.uuid4().hex,
            "requestedResolution": "Keep the signed financial boundary pending review",
        }, sourcetoken)["data"]
        original = sourceapi(path + "/disputes/open", draft, sourcetoken)["data"]
        assert original["state"] == "FREEZE_PENDING"
        freeze_path = path + "/disputes/" + draft["caseId"] + "/freeze"
        for _ in range(100):
            delivery = sourceapi(path + "/disputes/" + draft["caseId"] + "/delivery", token=sourcetoken)["data"]
            assert not delivery["sync"] or delivery["sync"]["state"] != "needs_review", json.dumps(delivery)
            statuses = {name: read(freeze_path, token=auth)["data"] for name, read, auth in parties if name == "source" or read(path + "/disputes?caseId=" + draft["caseId"], token=auth)["data"]["data"]}
            for status in statuses.values():
                assert not status["sync"] or status["sync"]["state"] != "needs_review", json.dumps(status)
            if len(statuses) == 2 and all(value["sync"] and value["sync"]["state"] == "ledger_pending" for value in statuses.values()):
                break
            time.sleep(2)
        else:
            raise AssertionError("Native freeze did not exchange original signatures")
        assert statuses["source"]["attestation"] and statuses["provider"]["attestation"] is None
        submission_id = statuses["source"]["attestation"]["id"]
        for _ in range(100):
            inspect_ledgers("freeze-offline")
            offline = {name: json.loads((logs / (name + "-freeze-offline.json")).read_text()) for name, _, _ in parties}
            attempts = [row for row in offline["source"]["commercialTransactions"] if row["submissionId"] == submission_id]
            if len(attempts) == 1 and attempts[0]["stage"] == "transaction":
                break
            assert all(row["state"] != "needs_review" for row in offline["source"]["commercial"]), "Freeze proposal requires review"
            time.sleep(2)
        else:
            raise AssertionError("Native transaction checkpoint was not persisted")
        for name, read, auth in parties:
            state = offline[name]
            assert len(state["freezes"]) == 1 and len(state["disputes"]) == 1
            assert state["freezes"][0]["state"] == "ledger_pending" and state["freezes"][0]["ledgerReceipt"] is None
            assert state["disputes"][0]["state"] == "FREEZE_PENDING"
            for key in unchanged:
                assert state[key] == before[name][key], "Freeze changed original state: " + key
        source_proof, target_proof = offline["source"]["freezes"][0], offline["provider"]["freezes"][0]
        assert source_proof["approvalJws"] == target_proof["counterpartyJws"] and source_proof["counterpartyJws"] == target_proof["approvalJws"]
        assert source_proof["digest"] == target_proof["digest"]
        checkpoint = attempts[0]
        recovery = restart_commercial_servers()
        inspect_ledgers("freeze-restarted")
        for name, read, auth in parties:
            restarted = json.loads((logs / (name + "-freeze-restarted.json")).read_text())
            assert restarted["disputes"][0]["state"] == "FREEZE_PENDING"
            for key in ("payload", "digest", "approvalJws", "counterpartyJws", "financialView", "confirmedAt", "ledgerReceipt"):
                assert restarted["freezes"][0][key] == offline[name]["freezes"][0][key], "Restart changed signed freeze proof"
        (logs / "freeze-crash-recovery.json").write_text(json.dumps({**recovery, "checkpoint": checkpoint}, indent=2) + "\n")
        print("REAL NATIVE FREEZE OFFLINE PASSED: independent platforms retain dual proof and original endorsed transaction across SIGKILL; neither case claims DISPUTED", flush=True)
    finally:
        orderer("start")
    for _ in range(140):
        statuses = {name: read(freeze_path, token=auth)["data"] for name, read, auth in parties}
        assert all(value["sync"]["state"] != "needs_review" for value in statuses.values()), json.dumps(statuses)
        assert statuses["source"]["attestation"]["state"] != "needs_review", json.dumps(statuses)
        if all(value["sync"]["state"] == "confirmed" for value in statuses.values()) and statuses["source"]["attestation"]["state"] == "committed":
            break
        time.sleep(3)
    else:
        raise AssertionError("Native freeze did not recover to independently verified receipts")
    inspect_ledgers("freeze-committed")
    committed = {name: json.loads((logs / (name + "-freeze-committed.json")).read_text()) for name, _, _ in parties}
    for name, read, auth in parties:
        state = committed[name]
        assert state["disputes"][0]["state"] == "DISPUTED"
        assert state["freezes"][0]["ledgerReceipt"] == {"recordId": draft["caseId"], "digest": source_proof["digest"]}
        for key in ("payload", "digest", "approvalJws", "counterpartyJws", "financialView"):
            assert state["freezes"][0][key] == offline[name]["freezes"][0][key]
        for key in unchanged:
            assert state[key] == before[name][key], "Confirmed freeze changed original state: " + key
        added = [row for row in state["commercial"] if row["input"]["operation"] == "freeze-disputed-task"]
        assert len(added) == (1 if name == "source" else 0), "Duplicate native submission"
    transactions = [row for row in committed["source"]["commercialTransactions"] if row["submissionId"] == submission_id]
    assert len(transactions) == 1 and transactions[0]["stage"] == "committed" and transactions[0]["validationCode"] == 0
    for key in ("transactionId", "submissionId", "recoveryDigest"):
        assert transactions[0][key] == checkpoint[key], "Native recovery replaced the transaction"
    replay = sourceapi(path + "/disputes/open", draft, sourcetoken)["data"]
    assert replay["openingJws"] == original["openingJws"] and replay["state"] == "DISPUTED"
    settlement = before["provider"]["settlements"][0]
    adjustment = api(path + "/adjustments/draft", {"settlementId": settlement["settlementId"], "adjustmentId": str(uuid.uuid4()), "chargedAmount": "0", "reason": "Must remain frozen", "supportingEvidenceDigest": None}, token)["data"]
    for name, read, auth in parties:
        try:
            read(path + "/adjustments/approve", adjustment, auth)
        except urllib.error.HTTPError as error:
            assert json.load(error)["error"]["code"] == "DATA_WAITING"
        else:
            raise AssertionError("Disputed task accepted a new financial commitment")
    submission = next(row for row in committed["source"]["commercial"] if row["id"] == submission_id)
    proof = {"draft": source_proof["payload"], "opening": draft, "envelope": submission["input"]["envelope"],
             "receipt": committed["source"]["freezes"][0]["ledgerReceipt"], "transaction": transactions[0], "evidenceDirectory": str(logs)}
    (networkroot / "live-freeze-proof.json").write_text(json.dumps(proof, indent=2) + "\n")
    (logs / "freeze-recovery-evidence.json").write_text(json.dumps({"statuses": statuses, "transaction": transactions[0]}, indent=2) + "\n")
    print("REAL NATIVE FREEZE RECOVERY PASSED: original transaction VALID, each platform confirmed its private receipt, immutable proof and unchanged money/Jobs; new financial approvals refused", flush=True)


def restart_commercial_servers():
    global server, sourceserver
    crashed = []
    for name, process in (("provider", server), ("source", sourceserver)):
        assert process.poll() is None and os.getpgid(process.pid) == process.pid
        os.killpg(process.pid, signal.SIGKILL)
        assert process.wait(timeout=15) == -signal.SIGKILL
        crashed.append({"site": name, "oldPid": process.pid, "exitCode": process.returncode})
    request_id = str(uuid.uuid4())
    acknowledgement = networkroot / ("execution-case-restart.ack" if case_scenario else "execution-commercial-restart.ack")
    (networkroot / ("execution-case-restart" if case_scenario else "execution-commercial-restart")).write_text(request_id)
    deadline = time.monotonic() + 45
    while True:
        try:
            reply = json.loads(acknowledgement.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            reply = {}
        if reply.get("requestId") == request_id:
            break
        assert time.monotonic() < deadline, "Commercial Adapter restart timeout"
        time.sleep(0.3)
    assert len(reply["restarts"]) == (3 if case_scenario else 2) and {r["site"] for r in reply["restarts"]} == ({"A", "B", "R"} if case_scenario else {"A", "B"})
    for row in reply["restarts"]:
        assert row["oldPid"] != row["newPid"] and row["exitCode"] != 0
    command = ["bun", "--no-env-file", "run", "scripts/federation-live/server.ts"]
    server = subprocess.Popen(command, cwd=repo, env=env, stdout=serverlog, stderr=serverlog, start_new_session=True)
    sourceserver = subprocess.Popen(command, cwd=repo, env=sourceenv, stdout=sourcelog, stderr=sourcelog, start_new_session=True)
    for row, process, read in zip(crashed, (server, sourceserver), (api, sourceapi)):
        row["newPid"] = process.pid
        assert row["oldPid"] != process.pid
        for _ in range(45):
            assert process.poll() is None, "Restarted Server exited"
            try:
                read("health")
                break
            except (OSError, ValueError):
                time.sleep(1)
        else:
            raise AssertionError("Restarted Server health timeout")
    return {"servers": crashed, "adapters": reply["restarts"]}


def verify_adjustments():
    config = json.loads((root / "source-init.json").read_text())
    original = json.loads((logs / "settlement-committed-evidence.json").read_text())["draft"]
    path = "federation/commercial-agreements/" + config["request"]["agreementRevisionId"] + "/adjustments"
    parties = (("provider", api, token), ("source", sourceapi, sourcetoken))
    previous = None
    for number, amount in enumerate(("0", original["chargedAmount"]), 1):
        label = "adjustment-" + str(number)
        draft = api(path + "/draft", {"settlementId": original["settlementId"], "adjustmentId": str(uuid.uuid4()), "chargedAmount": amount, "reason": "Isolated recovery acceptance " + str(number), "supportingEvidenceDigest": None}, token)["data"]
        assert draft["previous"] == previous
        assert draft["previousChargedAmount"] == (original["chargedAmount"] if number == 1 else "0")
        statuses, approvals, original_ids = {}, {}, {}

        def refresh():
            for name, read, auth in parties:
                result = read(path + "?recordId=" + draft["adjustmentId"] + "&settlementId=" + draft["settlementId"], token=auth)["data"]
                assert len(result["data"]) == 1
                record = result["data"][0]
                assert record["adjustment"]["payload"] == draft
                assert record["adjustment"]["approvalJws"] == approvals[name]["approvalJws"]
                if record["ledger"]:
                    original_ids.setdefault(name, record["ledger"]["id"])
                    assert record["ledger"]["id"] == original_ids[name]
                    assert record["ledger"]["state"] != "needs_review", json.dumps(record["ledger"])
                statuses[name] = {"record": record, "summary": result["summary"]}

        orderer("stop")
        try:
            for name, read, auth in parties:
                approvals[name] = read(path + "/approve", draft, auth)["data"]
            for _ in range(90):
                refresh()
                if len(original_ids) == 2:
                    break
                time.sleep(2)
            else:
                raise AssertionError("Adjustment originals were not exchanged over mTLS")
            for name, other in (("provider", "source"), ("source", "provider")):
                record = statuses[name]["record"]
                assert record["adjustment"]["counterpartyJws"] == approvals[other]["approvalJws"]
                assert record["ledger"]["state"] == "pending" and record["adjustment"]["appliedAt"] is None
                assert statuses[name]["summary"]["currentChargedAmount"] == draft["previousChargedAmount"]
            for _ in range(60):
                inspect_ledgers(label + "-offline")
                checkpoints = {}
                for name, _, _ in parties:
                    local = json.loads((logs / (name + "-" + label + "-offline.json")).read_text())
                    checkpoints[name] = [r for r in local["commercialTransactions"] if r["submissionId"] == original_ids[name]]
                if all(len(rows) == 1 and rows[0]["stage"] == "transaction" and rows[0]["recoveryDigest"] for rows in checkpoints.values()):
                    break
                time.sleep(3)
            else:
                raise AssertionError("Signed adjustment transaction checkpoints were not persisted")
            if number == 1:
                recovery = restart_commercial_servers()
                refresh()
                inspect_ledgers(label + "-restarted")
                for name, _, _ in parties:
                    local = json.loads((logs / (name + "-" + label + "-restarted.json")).read_text())
                    attempts = [r for r in local["commercialTransactions"] if r["submissionId"] == original_ids[name]]
                    assert attempts == checkpoints[name], "Restart replaced a durable transaction checkpoint"
                    assert statuses[name]["record"]["adjustment"]["appliedAt"] is None
                (logs / "adjustment-crash-recovery.json").write_text(json.dumps({**recovery, "checkpoints": checkpoints}, indent=2) + "\n")
            for name, _, _ in parties:
                local = json.loads((logs / (name + "-" + label + "-offline.json")).read_text())
                assert not local["budgets"]
                tasks = local["reservations"] if name == "provider" else local["outbound"]
                assert len(tasks) == 1 and tasks[0]["settledAmount"] == draft["previousChargedAmount"]
            (logs / (label + "-offline-evidence.json")).write_text(json.dumps({"draft": draft, "statuses": statuses, "checkpoints": checkpoints}, indent=2) + "\n")
        finally:
            orderer("start")
        for _ in range(100):
            refresh()
            if all(v["record"]["adjustment"]["appliedAt"] and v["record"]["ledger"]["state"] == "committed" for v in statuses.values()):
                break
            time.sleep(3)
        else:
            raise AssertionError("Adjustment did not recover to VALID on both platforms")
        for name, read, auth in parties:
            replay = read(path + "/approve", draft, auth)["data"]
            assert replay == statuses[name]["record"]["adjustment"], "Approval replay changed an applied original"
            assert statuses[name]["summary"]["currentChargedAmount"] == amount
            assert statuses[name]["summary"]["pendingAdjustmentId"] is None
        inspect_ledgers(label + "-committed")
        transactions = {}
        for name, _, _ in parties:
            local = json.loads((logs / (name + "-" + label + "-committed.json")).read_text())
            before = json.loads((logs / (name + "-" + label + "-offline.json")).read_text())
            for key in ("bills", "settlements", "gate", "demand", "execution"):
                assert local[key] == before[key], "Adjustment changed original " + key
            assert not local["budgets"] and len(local["adjustments"]) == number
            tasks = local["reservations"] if name == "provider" else local["outbound"]
            assert len(tasks) == 1 and tasks[0]["amount"] == original["reservedAmount"] and tasks[0]["settledAmount"] == amount
            attempts = [r for r in local["commercialTransactions"] if r["submissionId"] == original_ids[name]]
            valid = [r for r in attempts if r["stage"] == "committed" and r["validationCode"] == 0 and r["blockNumber"] is not None]
            assert len(valid) == 1
            recovered = next(r for r in attempts if r["transactionId"] == checkpoints[name][0]["transactionId"])
            assert recovered["recoveryDigest"] == checkpoints[name][0]["recoveryDigest"]
            transactions[name] = attempts
        evidence = {"draft": draft, "statuses": statuses, "transactions": transactions, "budgetDomainId": config["request"]["budgetDomainId"], "epoch": config["request"]["epoch"], "evidenceDirectory": str(logs)}
        (logs / (label + "-committed-evidence.json")).write_text(json.dumps(evidence, indent=2) + "\n")
        (networkroot / ("live-" + label + "-proof.json")).write_text(json.dumps(evidence, indent=2) + "\n")
        previous = {"adjustmentId": draft["adjustmentId"], "digest": statuses["provider"]["record"]["adjustment"]["digest"]}
        print("REAL " + label.upper() + " RECOVERY PASSED: original signatures exchanged; durable transactions VALID; net charge " + amount + "; replay and original settlement unchanged", flush=True)


try:
    if disk_pressure:
        image_file = root / "storage-pressure.ext4"
        with image_file.open("xb") as image_handle:
            image_handle.truncate(1024 * 1024 * 1024)
        run(["mkfs.ext4", "-q", "-F", "-m", "0", str(image_file)])
        run(["mount", "-o", "loop,nodev,nosuid,noexec", str(image_file), str(pgroot)])
        pressure_mounted = True
        assert pgroot.stat().st_dev != root.stat().st_dev, "Pressure requires its own filesystem"
        os.chown(pgroot, 65534, 65534)
        (pgroot / ".kq-storage-id").write_text(str(uuid.uuid4()))
    if attested:
        orderer("stop")
    # Executed only inside the disposable lab namespace.
    k(["create", "namespace", namespace])
    created = True
    rootuser = "lab-root"
    rootsecret = secrets.token_hex(24)
    committer = "lab-committer"
    commitsecret = secrets.token_hex(24)
    k(
        ["apply", "-f", "-"],
        json.dumps(
            {
                "apiVersion": "v1",
                "kind": "Secret",
                "metadata": {"name": "storage-credentials", "namespace": namespace},
                "stringData": {"root": rootsecret, "committer": commitsecret},
            }
        ),
    )

    def secret(name, key):
        return {
            "name": name,
            "valueFrom": {"secretKeyRef": {"name": "storage-credentials", "key": key}},
        }

    storage = {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": "storage", "namespace": namespace},
        "spec": {
            "automountServiceAccountToken": False,
            "restartPolicy": "Never",
            "containers": [
                {
                    "name": "storage",
                    "image": "docker.io/rustfs/rustfs@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff",
                    "imagePullPolicy": "Never",
                    "args": ["rustfs", "/data"],
                    "env": [
                        {"name": "RUSTFS_ACCESS_KEY", "value": rootuser},
                        secret("RUSTFS_SECRET_KEY", "root"),
                        {"name": "RUSTFS_CONSOLE_ENABLE", "value": "false"},
                        {"name": "RUSTFS_OBS_LOG_DIRECTORY", "value": "/tmp/logs"},
                    ],
                    "resources": {
                        "requests": {"cpu": "10m", "memory": "128Mi"},
                        "limits": {"cpu": "500m", "memory": "768Mi"},
                    },
                    "volumeMounts": [{"name": "data", "mountPath": "/data"}],
                }
            ],
            "volumes": [{"name": "data", "emptyDir": {}}],
        },
    }
    k(["apply", "-f", "-"], json.dumps(storage))
    for _ in range(60):
        pod = json.loads(
            k(["get", "pod", "storage", "-n", namespace, "-o", "json"]).stdout
        )
        storageip = pod.get("status", {}).get("podIP")
        if storageip:
            try:
                with urllib.request.urlopen(
                    f"http://{storageip}:9000/health", timeout=2
                ):
                    break
            except OSError:
                pass
        time.sleep(1)
    else:
        raise RuntimeError("Isolated RustFS failed to start")
    cm = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": "storage-bootstrap", "namespace": namespace},
        "data": {
            "bootstrap.sh": (
                repo / "deploy/rustfs/bootstrap-object-lock.sh"
            ).read_text()
        },
    }
    k(["apply", "-f", "-"], json.dumps(cm))
    bootenv = {
        "RUSTFS_ENDPOINT": f"http://{storageip}:9000",
        "RUSTFS_ACCESS_KEY": rootuser,
        "DATA_MARKET_COMMITTER_ACCESS_KEY": committer,
        "NETDRIVE_BUCKET": "lab-netdrive",
        "DATA_MARKET_STAGING_BUCKET": "lab-staging",
        "DATA_MARKET_IMMUTABLE_BUCKET": "lab-immutable",
        "DATA_MARKET_IMMUTABLE_RETENTION_DAYS": "1",
        "RUSTFS_READY_TIMEOUT_SECONDS": "60",
    }
    bootstrap = {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": "storage-bootstrap", "namespace": namespace},
        "spec": {
            "automountServiceAccountToken": False,
            "restartPolicy": "Never",
            "containers": [
                {
                    "name": "bootstrap",
                    "image": "docker.io/rustfs/rc@sha256:ab024bfebee49a750ce886b4c70963ccd9ddaa03f491704a90710641d7a26699",
                    "imagePullPolicy": "Never",
                    "command": ["/bin/sh", "/bootstrap/bootstrap.sh"],
                    "env": [{"name": a, "value": b} for a, b in bootenv.items()]
                    + [
                        secret("RUSTFS_SECRET_KEY", "root"),
                        secret("DATA_MARKET_COMMITTER_SECRET_KEY", "committer"),
                    ],
                    "resources": {
                        "requests": {"cpu": "10m", "memory": "32Mi"},
                        "limits": {"cpu": "500m", "memory": "256Mi"},
                    },
                    "volumeMounts": [
                        {"name": "script", "mountPath": "/bootstrap", "readOnly": True}
                    ],
                }
            ],
            "volumes": [{"name": "script", "configMap": {"name": "storage-bootstrap"}}],
        },
    }
    k(["apply", "-f", "-"], json.dumps(bootstrap))
    for _ in range(90):
        status = json.loads(
            k(["get", "pod", "storage-bootstrap", "-n", namespace, "-o", "json"]).stdout
        )["status"]["phase"]
        if status in ["Succeeded", "Failed"]:
            break
        time.sleep(1)
    (logs / "storage-bootstrap.log").write_text(
        k(["logs", "storage-bootstrap", "-n", namespace], check=False).stdout
    )
    assert status == "Succeeded", "Storage bootstrap failed; see storage-bootstrap.log"
    env.update(
        NETDRIVE_ENABLED="true",
        NETDRIVE_ENDPOINT=storageip,
        NETDRIVE_PORT="9000",
        NETDRIVE_ACCESS_KEY=committer,
        NETDRIVE_SECRET_KEY=commitsecret,
        NETDRIVE_BUCKET="lab-netdrive",
        DATA_MARKET_COMMITTER_ACCESS_KEY=committer,
        DATA_MARKET_STAGING_BUCKET="lab-staging",
        DATA_MARKET_IMMUTABLE_BUCKET="lab-immutable",
        DATA_MARKET_IMMUTABLE_RETENTION_DAYS="1",
    )
    k(
        ["apply", "-f", "-"],
        json.dumps(
            {
                "apiVersion": "v1",
                "kind": "PersistentVolumeClaim",
                "metadata": {
                    "name": "artifacts",
                    "namespace": namespace,
                    "annotations": {
                        "volume.kubernetes.io/selected-node": json.loads(
                            k(["get", "nodes", "-o", "json"]).stdout
                        )["items"][0]["metadata"]["name"]
                    },
                },
                "spec": {
                    "accessModes": ["ReadWriteOnce"],
                    "storageClassName": "local-path",
                    "resources": {"requests": {"storage": "64Mi"}},
                },
            }
        ),
    )
    print(
        "Isolated object storage ready with non-root committer and production Object Lock bootstrap",
        flush=True,
    )
    pg(
        "initdb",
        "-D",
        str(pgroot / "data"),
        "-A",
        "trust",
        "--no-locale",
        "-U",
        "kq",
        *(["-L", pgshare] if pgshare else []),
    )
    start_postgres()
    pgstarted = True
    pg(
        "createdb",
        "-h",
        "127.0.0.1",
        "-p",
        str(pgport),
        "-U",
        "kq",
        "kuintessence_unit_federation_live",
    )
    run(["bun", "--no-env-file", "run", "packages/db/src/pg/migrate.ts"])
    run(
        [
            "bun",
            "--no-env-file",
            "-e",
            "import {ensureCa} from './packages/server/src/auth/ca'; await ensureCa(process.env.SERVER_CA_DIR);",
        ]
    )
    run(
        [
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(root / "tls.key"),
            "-out",
            str(root / "tls.csr"),
            "-subj",
            "/CN=localhost",
        ]
    )
    (root / "tls.ext").write_text(
        f"subjectAltName=IP:127.0.0.1,IP:{nodeip},DNS:localhost\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n"
    )
    run(
        [
            "openssl",
            "x509",
            "-req",
            "-in",
            str(root / "tls.csr"),
            "-CA",
            str(root / "ca/ca.crt"),
            "-CAkey",
            str(root / "ca/ca.key"),
            "-CAcreateserial",
            "-out",
            str(root / "tls.crt"),
            "-days",
            "1",
            "-extfile",
            str(root / "tls.ext"),
        ]
    )
    run(
        [
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(root / "target-client.key"),
            "-out",
            str(root / "target-client.csr"),
            "-subj",
            "/CN=target-client",
        ]
    )
    (root / "target-client.ext").write_text(
        "extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\n"
    )
    run(
        [
            "openssl",
            "x509",
            "-req",
            "-in",
            str(root / "target-client.csr"),
            "-CA",
            str(root / "ca/ca.crt"),
            "-CAkey",
            str(root / "ca/ca.key"),
            "-CAcreateserial",
            "-out",
            str(root / "target-client.crt"),
            "-days",
            "1",
            "-extfile",
            str(root / "target-client.ext"),
        ]
    )
    os.chmod(root / "target-client.key", 0o600)
    env.update(
        FEDERATION_CLIENT_CERT_FILE=str(root / "target-client.crt"),
        FEDERATION_CLIENT_KEY_FILE=str(root / "target-client.key"),
        FEDERATION_CLIENT_CA_FILE=str(root / "ca/ca.crt"),
        LAB_SOURCE_ORIGIN=f"https://127.0.0.1:{sourcegatewayport}",
    )
    shutil.copyfile(siteb["businessKeyFile"], root / "federation.pem")
    os.chmod(root / "federation.pem", 0o600)
    run(
        [
            "openssl",
            "genpkey",
            "-algorithm",
            "ED25519",
            "-out",
            str(root / "sandbox.key"),
        ]
    )
    os.chmod(root / "sandbox.key", 0o600)
    run(
        [
            "openssl",
            "pkey",
            "-in",
            str(root / "sandbox.key"),
            "-pubout",
            "-out",
            str(root / "sandbox.pub"),
        ]
    )
    env.update(
        SANDBOX_ENABLED="true",
        SANDBOX_SIGNING_KEY_ID="lab-sandbox",
        SANDBOX_SIGNING_PRIVATE_KEY_PEM=(root / "sandbox.key").read_text(),
    )
    if hpc_execution:
        from media_hpc import prepare_runtime, configure_target, validate_pbs_cache
        hpc_pbs = validate_pbs_cache(os.environ["KQ_MEDIA_PBS_DIR"], image) if media_execution == "pbs-pro" else None
        if hpc_pbs:
            shutil.copyfile(hpc_pbs / "pbs-install.json", logs / "pbs-runtime.json")
        hpc_runtime, hpc_metadata = prepare_runtime(root, os.environ["KQ_MEDIA_RUNTIME_DIR"], log)
        import base64
        public_der = subprocess.check_output(["openssl", "pkey", "-pubin", "-in", str(root / "sandbox.pub"), "-outform", "DER"])
        env.update(SANDBOX_IMPERSONATION_ENABLED="false" if self_account else "true",
                   SANDBOX_SELF_ACCOUNT_ENABLED="true" if self_account else "false",
                   ECOSYSTEM_RELEASE_TRUSTED_KEYS=json.dumps({"lab-sandbox": base64.b64encode(public_der).decode()}))
    # Two independent cloud buckets and non-root credentials in the disposable storage instance.
    import copy

    sourcestorage = copy.deepcopy(storage)
    sourcestorage["metadata"]["name"] = "storage-source"
    k(["apply", "-f", "-"], json.dumps(sourcestorage))
    for _ in range(60):
        sourcepodstate = json.loads(
            k(["get", "pod", "storage-source", "-n", namespace, "-o", "json"]).stdout
        )
        sourcestorageip = sourcepodstate.get("status", {}).get("podIP")
        if sourcestorageip:
            try:
                with urllib.request.urlopen(
                    f"http://{sourcestorageip}:9000/health", timeout=2
                ):
                    break
            except OSError:
                pass
        time.sleep(1)
    else:
        raise RuntimeError("Independent source RustFS failed to start")
    sourcecommitsecret = secrets.token_hex(24)
    k(
        [
            "patch",
            "secret",
            "storage-credentials",
            "-n",
            namespace,
            "--type=merge",
            "-p",
            json.dumps({"stringData": {"source-committer": sourcecommitsecret}}),
        ]
    )
    sourceboot = copy.deepcopy(bootstrap)
    sourceboot["metadata"]["name"] = "storage-source-bootstrap"
    for item in sourceboot["spec"]["containers"][0]["env"]:
        if item["name"] == "RUSTFS_ENDPOINT":
            item["value"] = f"http://{sourcestorageip}:9000"
        if item["name"] == "NETDRIVE_BUCKET":
            item["value"] = "lab-source-netdrive"
        if item["name"] == "DATA_MARKET_COMMITTER_ACCESS_KEY":
            item["value"] = "source-committer"
        if item["name"] == "DATA_MARKET_COMMITTER_SECRET_KEY":
            item["valueFrom"]["secretKeyRef"]["key"] = "source-committer"
    k(["apply", "-f", "-"], json.dumps(sourceboot))
    for _ in range(90):
        phase = json.loads(
            k(
                [
                    "get",
                    "pod",
                    "storage-source-bootstrap",
                    "-n",
                    namespace,
                    "-o",
                    "json",
                ]
            ).stdout
        )["status"]["phase"]
        if phase in ["Succeeded", "Failed"]:
            break
        time.sleep(1)
    (logs / "source-storage-bootstrap.log").write_text(
        k(["logs", "storage-source-bootstrap", "-n", namespace], check=False).stdout
    )
    assert phase == "Succeeded", "Source storage bootstrap failed"
    targetstorageport, sourcestorageport = port(), port()
    targetorigin = f"https://{nodeip}:{targetstorageport}"
    sourceorigin = f"https://{nodeip}:{sourcestorageport}"
    proxy_config = {
        "root": str(root),
        "upstream": storageip,
        "listeners": [
            [targetstorageport, "lab-netdrive", storageip],
            [sourcestorageport, "lab-source-netdrive", sourcestorageip],
        ],
    }
    (root / "storage-proxy.json").write_text(json.dumps(proxy_config))
    os.chmod(root / "storage-proxy.json", 0o600)
    (root / "storage-proxy.mjs").write_text("""import {createServer} from 'node:https';
 import {request} from 'node:http'; import {readFileSync} from 'node:fs';
 const c=JSON.parse(readFileSync(process.argv[2]));
 for(const [port,bucket,upstreamHost] of c.listeners) {
  const s=createServer({key:readFileSync(c.root+'/tls.key'),cert:readFileSync(c.root+'/tls.crt')},(req,res)=>{
   if(!req.url.startsWith('/'+bucket+'/')&&!req.url.startsWith('/'+bucket+'?')&&req.url!=='/'+bucket){res.writeHead(404).end();return;}
   const upstream=request({host:upstreamHost,port:9000,method:req.method,path:req.url,headers:req.headers},out=>{
     res.writeHead(out.statusCode,out.headers);out.pipe(res);out.on('error',()=>res.destroy());
   });upstream.on('error',()=>res.destroy());req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
  });s.listen(port,'0.0.0.0');
 }
 """)
    proxylog = open(logs / "storage-proxy.log", "w")
    storageproxy = subprocess.Popen(
        ["node", str(root / "storage-proxy.mjs"), str(root / "storage-proxy.json")],
        stdout=proxylog,
        stderr=proxylog,
    )
    for _ in range(30):
        try:
            with socket.create_connection(("127.0.0.1", targetstorageport), timeout=1):
                break
        except OSError:
            time.sleep(0.2)
    env.update(
        NETDRIVE_PUBLIC_URL=targetorigin,
        NETDRIVE_REGION="us-east-1",
        NODE_EXTRA_CA_CERTS=str(root / "ca/ca.crt"),
        FEDERATION_RESULT_DOWNLOAD_ORIGINS=targetorigin,
    )
    print(
        "Two versioned cloud buckets and independently scoped HTTPS storage endpoints ready",
        flush=True,
    )
    if task_media:
        env["FEDERATION_INPUT_DOWNLOAD_ORIGINS"] = targetorigin
        env["FEDERATION_MEDIA_OBJECT_DOWNLOAD_ORIGINS"] = targetorigin
    if disk_pressure:
        configure_storage(env, "provider")
    server = subprocess.Popen(
        ["bun", "--no-env-file", "run", "scripts/federation-live/server.ts"],
        cwd=repo,
        env=env,
        stdout=serverlog,
        stderr=serverlog,
        start_new_session=True,
    )
    for _ in range(45):
        if server.poll() is not None:
            raise RuntimeError("Server exited; inspect private server.log")
        try:
            api("health")
            break
        except (OSError, ValueError):
            time.sleep(1)
    else:
        raise RuntimeError("Server health timeout")
    print("Full Server healthy with direct mTLS and federation enabled", flush=True)
    seed = r"""
import {createPgDb,orgs,users} from '@kuintessence/db';
import {ensureCa} from './packages/server/src/auth/ca';
import {AgentRegistrationService} from './packages/server/src/services/agent-registration';
const db=createPgDb(process.env.DATABASE_URL);const userId=crypto.randomUUID(),orgId=crypto.randomUUID();
await db.insert(orgs).values({id:orgId,name:'Isolated federation provider'});
await db.insert(users).values({id:userId,orgId,email:'federation-lab-admin@test.invalid',role:'platform_admin'});
const token=await new AgentRegistrationService(db,await ensureCa(process.env.SERVER_CA_DIR)).createToken({agentId:process.env.LAB_AGENT,siteName:'Isolated Kubernetes',providerOrgId:orgId,expiresInSec:600,createdBy:userId});
await Bun.write(process.env.LAB_ROOT+'/registration.json',JSON.stringify({token:token.token,orgId,userId}));await db.$client.end();
"""
    run(["bun", "--no-env-file", "-e", seed])
    os.chmod(root / "registration.json", 0o600)
    registration = json.loads((root / "registration.json").read_text())
    # CLI consumes the actual registration token, validates enrollment, and stores the private certificate bundle.
    run(
        [
            "bun",
            "--no-env-file",
            "run",
            "packages/cli/src/index.ts",
            "agent",
            "register",
            "--url",
            f"http://127.0.0.1:{httpport}",
            "--grpc-url",
            f"https://{nodeip}:{grpcport}",
            "--token",
            registration["token"],
            "--output-dir",
            str(root / "agent"),
            "--scheduler",
            hpc_execution or "kubernetes",
        ]
    )
    (root / "agent/agent.env").open("a").write(
        "\nAGENT_DB_PATH=/var/lib/kuintessence/agent.db\nHEARTBEAT_INTERVAL_SEC=1\nAGENT_QUEUE_INVENTORY_INTERVAL_SEC=2\n"
    )
    print("Agent enrolled using the production registration API and CLI", flush=True)
    node = json.loads(k(["get", "nodes", "-o", "json"]).stdout)["items"][0]["metadata"][
        "name"
    ]
    runtimeimage = "sif@" + hpc_metadata["digest"] if hpc_execution else "docker.io/bitnamilegacy/kubectl@sha256:f65b74480c37b65099453fb3a5ca7eaaea235b3d4268ef3b1ed0f0150d340646"
    profileroot = pathlib.Path("/var/lib/kubelet/seccomp")
    profileroot.mkdir(mode=0o755, exist_ok=True)
    profilepath = profileroot / (namespace + ".json")
    profilepath.write_text(
        json.dumps(
            {
                "defaultAction": "SCMP_ACT_ALLOW",
                "architectures": ["SCMP_ARCH_X86_64"],
                "syscalls": [
                    {
                        "names": ["socket"],
                        "action": "SCMP_ACT_ERRNO",
                        "errnoRet": 1,
                        "args": [{"index": 0, "value": 1, "op": "SCMP_CMP_NE"}],
                    },
                    {
                        "names": ["io_uring_setup"],
                        "action": "SCMP_ACT_ERRNO",
                        "errnoRet": 1,
                    },
                ],
            }
        )
    )
    profilepath.chmod(0o444)
    import hashlib

    profilehash = hashlib.sha256(profilepath.read_bytes()).hexdigest()
    env.update(LAB_RUNTIME_IMAGE=runtimeimage, LAB_NAMESPACE=namespace)
    digest = runtimeimage.split("@")[1]
    if not hpc_execution:
        raw = subprocess.check_output(["k3s", "ctr", "content", "get", digest])
        assert "sha256:" + hashlib.sha256(raw).hexdigest() == digest, "Runtime OCI manifest digest mismatch"
    (root / "runtime-digest").write_text(digest)
    run(
        [
            "openssl",
            "pkeyutl",
            "-sign",
            "-rawin",
            "-inkey",
            str(root / "sandbox.key"),
            "-in",
            str(root / "runtime-digest"),
            "-out",
            str(root / "runtime.sig"),
        ]
    )
    run(
        [
            "openssl",
            "pkeyutl",
            "-verify",
            "-rawin",
            "-pubin",
            "-inkey",
            str(root / "sandbox.pub"),
            "-in",
            str(root / "runtime-digest"),
            "-sigfile",
            str(root / "runtime.sig"),
        ]
    )
    import base64

    (root / "runtime-signature.txt").write_text(
        base64.b64encode((root / "runtime.sig").read_bytes()).decode()
    )
    kubeconfig = {
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [
            {
                "name": "lab",
                "cluster": {
                    "server": "https://kubernetes.default.svc",
                    "certificate-authority": "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
                },
            }
        ],
        "users": [
            {
                "name": "agent",
                "user": {
                    "tokenFile": "/var/run/secrets/kubernetes.io/serviceaccount/token"
                },
            }
        ],
        "contexts": [
            {
                "name": "lab",
                "context": {"cluster": "lab", "user": "agent", "namespace": namespace},
            }
        ],
        "current-context": "lab",
    }
    (root / "kubeconfig").write_text(json.dumps(kubeconfig))
    agentenv = {
        "KQ_AGENT_ENV_FILE": str(root / "agent/agent.env"),
        "KQ_AGENT_REGISTRATION_ENABLED": "0",
        "AGENT_SPACK_ENABLED": "false",
        "AGENT_SSH_ENABLED": "false",
        "AGENT_SCHEDULER": "kubernetes",
        "HEARTBEAT_INTERVAL_SEC": "1",
        "LOG_LEVEL": "info",
        "KUBECONFIG": str(root / "kubeconfig"),
        "AGENT_SANDBOX_ENABLED": "true",
        "AGENT_SANDBOX_K8S_ARTIFACT_PVC": "artifacts",
        "AGENT_SANDBOX_EXECUTION_MODE": "root-impersonation",
        "AGENT_SANDBOX_NETWORK_ISOLATION": "true",
        "AGENT_SANDBOX_CGROUPS": "true",
        "AGENT_SANDBOX_SECCOMP": "true",
        "AGENT_SANDBOX_PUBLIC_KEYS_JSON": json.dumps(
            {"lab-sandbox": (root / "sandbox.pub").read_text()}
        ),
        "AGENT_SANDBOX_RUNTIME_CACHE_JSON": json.dumps(
            {
                runtimeimage.split("@")[1]: {
                    "kind": "OCI",
                    "localPath": runtimeimage,
                    "signatureVerified": True,
                }
            }
        ),
        "AGENT_SANDBOX_K8S_SECCOMP_ROOT": str(profileroot),
        "AGENT_SANDBOX_K8S_SECCOMP_PROFILE": profilepath.name,
        "AGENT_SANDBOX_K8S_SECCOMP_PROFILE_SHA256": profilehash,
        "AGENT_SANDBOX_K8S_SECCOMP_NODE_NAME": node,
        "NODE_ENV": "development",
        "NODE_EXTRA_CA_CERTS": str(root / "ca/ca.crt"),
    }
    if uses_media:
        agentenv.update(AGENT_DATASET_ROOTS_JSON=json.dumps({media_target_root: "."}),
                        AGENT_FEDERATION_MEDIA_IMPORT=json.dumps({"mediaDirectory": "/var/lib/kuintessence/media", "ageDirectory": "/opt/kq/age"}))
    if task_media:
        agentenv.update(
            AGENT_FEDERATION_INPUT_COPY=json.dumps({"stagingRoot": "/var/lib/kuintessence/input-staging", "maxStagingBytes": 1048576, "allowedDestinationOrigins": [targetorigin]}),
            AGENT_FEDERATION_MEDIA_EXPORT=json.dumps({"mediaDirectory": "/var/lib/kuintessence/media", "ageDirectory": "/opt/kq/age", "allowedSourceOrigins": [targetorigin]}))
    resources = [
        {
            "apiVersion": "v1",
            "kind": "ServiceAccount",
            "metadata": {"name": name, "namespace": namespace},
        }
        for name in ["agent", "worker"]
    ]
    resources += [
        {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "Role",
            "metadata": {"name": "agent", "namespace": namespace},
            "rules": [
                {
                    "apiGroups": ["", "batch", "networking.k8s.io"],
                    "resources": [
                        "pods",
                        "pods/log",
                        "pods/exec",
                        "jobs",
                        "configmaps",
                        "networkpolicies",
                    ],
                    "verbs": ["get", "list", "watch", "create", "patch", "delete"],
                },
                {"apiGroups": [""], "resources": ["serviceaccounts"], "verbs": ["get"]},
            ],
        },
        {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "RoleBinding",
            "metadata": {"name": "agent", "namespace": namespace},
            "subjects": [
                {"kind": "ServiceAccount", "name": "agent", "namespace": namespace}
            ],
            "roleRef": {
                "apiGroup": "rbac.authorization.k8s.io",
                "kind": "Role",
                "name": "agent",
            },
        },
    ]
    clusterrole = namespace
    resources += [
        {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "ClusterRole",
            "metadata": {"name": clusterrole},
            "rules": [
                {
                    "apiGroups": [""],
                    "resources": ["nodes", "namespaces"],
                    "verbs": ["get", "list"],
                }
            ],
        },
        {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "ClusterRoleBinding",
            "metadata": {"name": clusterrole},
            "subjects": [
                {"kind": "ServiceAccount", "name": "agent", "namespace": namespace}
            ],
            "roleRef": {
                "apiGroup": "rbac.authorization.k8s.io",
                "kind": "ClusterRole",
                "name": clusterrole,
            },
        },
    ]
    k(
        ["apply", "-f", "-"],
        json.dumps({"apiVersion": "v1", "kind": "List", "items": resources}),
    )
    # Agent alone receives namespace-scoped credentials; workload token mounting stays disabled.
    pod = {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": "scheduler", "namespace": namespace},
        "spec": {
            "hostname": node,
            "nodeName": node,
            "dnsPolicy": "ClusterFirst",
            "serviceAccountName": "agent",
            "restartPolicy": "Never",
            "terminationGracePeriodSeconds": 15,
            "containers": [
                {
                    "name": "scheduler",
                    "workingDir": "/var/lib/kuintessence",
                    "image": image,
                    "imagePullPolicy": "Never",
                    "command": [
                        "/bin/bash",
                        "-c",
                        'set -a; source "$KQ_AGENT_ENV_FILE"; exec python3 /workspace/deploy/schedulers/common/supervise-agent.py',
                    ],
                    "env": [{"name": a, "value": b} for a, b in agentenv.items()],
                    "resources": {
                        "requests": {"cpu": "10m", "memory": "256Mi"},
                        "limits": {"cpu": "1", "memory": "768Mi"},
                    },
                    "volumeMounts": [
                        {"name": "source", "mountPath": "/workspace", "readOnly": True},
                        {"name": "identity", "mountPath": str(root), "readOnly": True},
                        {"name": "state", "mountPath": "/var/lib/kuintessence"},
                        {
                            "name": "kubectl",
                            "mountPath": "/usr/local/bin/kubectl",
                            "readOnly": True,
                        },
                        {
                            "name": "seccomp",
                            "mountPath": str(profileroot),
                            "readOnly": True,
                        },
                    ],
                }
            ],
            "volumes": [
                {
                    "name": "source",
                    "hostPath": {"path": str(repo), "type": "Directory"},
                },
                {
                    "name": "identity",
                    "hostPath": {"path": str(root), "type": "Directory"},
                },
                {"name": "state", "emptyDir": {}},
                {
                    "name": "kubectl",
                    "hostPath": {
                        "path": str(pathlib.Path(shutil.which("kubectl")).resolve()),
                        "type": "File",
                    },
                },
                {
                    "name": "seccomp",
                    "hostPath": {"path": str(profileroot), "type": "Directory"},
                },
            ],
        },
    }
    if uses_media:
        pod["spec"]["volumes"].append({"name": "age", "hostPath": {"path": str(media_age), "type": "Directory"}})
        pod["spec"]["containers"][0]["volumeMounts"].append({"name": "age", "mountPath": "/opt/kq/age", "readOnly": True})
    source_pod_template = copy.deepcopy(pod)
    if self_account:
        from selfaccount import configure_target as configure_selfaccount, inspect_native, interrupt_agent
        configure_selfaccount(pod, root, hpc_runtime, hpc_metadata)
        source_files = [pathlib.Path(__file__), *[repo / "packages/agent/src" / name for name in
            ("federation-watchdog.ts", "sandbox/stager.ts", "adapters/base.ts")], *[repo / "scripts/federation-live" / name for name in
            ("target.ts", "selfaccount.py", "selfaccount-bootstrap.sh", "selfaccount-accounting.sh", "slurm-cgroup-inner.sh", "slurm-cgroup-outer.sh")]]
        (logs / "checkout.json").write_text(json.dumps({"commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
            "image": pod["spec"]["containers"][0]["image"], "namespace": namespace,
            "runtime": hpc_metadata, "sourceSha256": {str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest() for path in source_files}}, indent=2))
    elif media_execution:
        configure_target(pod, root, hpc_runtime, hpc_metadata, media_execution, hpc_pbs)
    k(["apply", "-f", "-"], json.dumps(pod))
    token = api(
        "auth/login",
        {"email": "federation-lab-admin@test.invalid", "role": "platform_admin"},
    )["token"]
    for _ in range(240 if hpc_execution else 60):
        if hpc_execution:
            phase = json.loads(k(["get", "pod", "scheduler", "-n", namespace, "-o", "json"]).stdout)["status"].get("phase")
            assert phase not in ("Failed", "Succeeded"), "HPC Agent bootstrap exited; inspect agent.log"
        status = api("agents", token=token)
        rows = (
            status
            if isinstance(status, list)
            else status.get("agents", status.get("items", []))
        )
        if any(
            row.get("agentId") == env["LAB_AGENT"] and row.get("status") == "online"
            for row in rows
        ):
            break
        time.sleep(1)
    else:
        raise RuntimeError("Agent did not become online")
    print("Real " + (hpc_execution or "Kubernetes") + " Agent online through direct mTLS", flush=True)
    if hpc_execution:
        media_queue = "sandbox" if self_account else "workq" if media_execution == "pbs-pro" else "debug"
        for _ in range(90):
            inventory = api("admin/agents/" + env["LAB_AGENT"] + "/queue-inventory", token=token)
            if inventory["status"] == "available" and any(q["queueName"] == media_queue for q in inventory["queues"]):
                break
            time.sleep(1)
        else:
            (logs / "media-queue-inventory.json").write_text(json.dumps(inventory, indent=2))
            raise RuntimeError("Actual HPC queue inventory is unavailable")
    api(
        "admin/queues",
        {
            "queueId": "federation-lab-debug",
            "name": "Isolated " + hpc_execution if hpc_execution else "Isolated Kubernetes",
            "providerOrgId": registration["orgId"],
            "visibleOrgIds": [registration["orgId"]],
            "agentId": env["LAB_AGENT"],
            "schedulerType": hpc_execution or "kubernetes",
            "queueName": media_queue if hpc_execution else namespace,
        },
        token,
    )
    # Receive the signed request through the actual Node mTLS gateway.
    run(
        [
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(root / "peer.key"),
            "-out",
            str(root / "peer.csr"),
            "-subj",
            "/CN=source-lab",
        ]
    )
    (root / "peer.ext").write_text(
        "extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\n"
    )
    run(
        [
            "openssl",
            "x509",
            "-req",
            "-in",
            str(root / "peer.csr"),
            "-CA",
            str(root / "ca/ca.crt"),
            "-CAkey",
            str(root / "ca/ca.key"),
            "-CAcreateserial",
            "-out",
            str(root / "peer.crt"),
            "-days",
            "1",
            "-extfile",
            str(root / "peer.ext"),
        ]
    )
    run(["bun", "--no-env-file", "run", "scripts/federation-live/target.ts"])
    token = api(
        "auth/login",
        {"email": "federation-lab-admin@test.invalid", "role": "platform_admin"},
    )["token"]
    gatewayport = port()
    env.update(
        FEDERATION_TLS_PORT=str(gatewayport),
        FEDERATION_TLS_HOST="127.0.0.1",
        FEDERATION_TLS_CA_FILE=str(root / "ca/ca.crt"),
        FEDERATION_TLS_CERT_FILE=str(root / "tls.crt"),
        FEDERATION_TLS_KEY_FILE=str(root / "tls.key"),
    )
    run(
        [
            "bun",
            "--no-env-file",
            "build",
            "packages/server/src/federation/gateway-main.ts",
            "--target=node",
            "--outfile=" + str(root / "gateway.mjs"),
        ]
    )
    gateway = subprocess.Popen(
        ["node", str(root / "gateway.mjs")],
        cwd=repo,
        env=env,
        stdout=serverlog,
        stderr=serverlog,
    )
    for _ in range(30):
        try:
            with socket.create_connection(("127.0.0.1", gatewayport), timeout=1):
                break
        except OSError:
            time.sleep(0.2)
    # Start the independent source Server only after the receiving gateway is ready.
    sourcehttp, sourcegrpc = port(), port()
    env["LAB_SOURCE_HTTP"] = f"http://127.0.0.1:{sourcehttp}"
    sourceenv = env.copy()
    if case_scenario:
        sourceenv["FEDERATION_CASE_SOCKET_PATH"] = str(networkroot / "live-A-case/case.sock")
    if uses_media:
        sourceenv.update(FEDERATION_MEDIA_WRAPPING_KEY=secrets.token_hex(32), LAB_MEDIA_ROOT_ID=media_source_root)
    if coordinated or attested:
        sourceenv["FEDERATION_COMMERCIAL_SOCKET_PATH"] = str(networkroot / "live-A-commercial/commercial.sock")
    if coordinated:
        sourceenv["FEDERATION_MARKET_SOCKET_PATH"] = str(networkroot / "live-A-market/market.sock")
    if attested:
        sourceenv.pop("FEDERATION_ATTESTATION_SOCKET_PATH", None)
    configuration = json.loads((root / "source-init.json").read_text())
    env["SOURCE_DATABASE_URL"] = (
        f"postgres://kq@127.0.0.1:{pgport}/kuintessence_unit_federation_source"
    )
    env["LAB_TARGET_ORIGIN"] = f"https://127.0.0.1:{gatewayport}"
    pg(
        "createdb",
        "-h",
        "127.0.0.1",
        "-p",
        str(pgport),
        "-U",
        "kq",
        "kuintessence_unit_federation_source",
    )
    sourceenv.update(
        DATABASE_URL=env["SOURCE_DATABASE_URL"],
        SERVER_PORT=str(sourcehttp),
        SERVER_GRPC_PORT=str(sourcegrpc),
        NETDRIVE_ENABLED="true",
        NETDRIVE_ENDPOINT=sourcestorageip,
        NETDRIVE_BUCKET="lab-source-netdrive",
        NETDRIVE_ACCESS_KEY="source-committer",
        DATA_MARKET_COMMITTER_ACCESS_KEY="source-committer",
        NETDRIVE_SECRET_KEY=sourcecommitsecret,
        NETDRIVE_PUBLIC_URL=sourceorigin,
        FEDERATION_RESULT_DOWNLOAD_ORIGINS=sourceorigin,
        FEDERATION_RESULT_IMPORT_SOURCE_ORIGINS="" if task_media else targetorigin,
        FEDERATION_INPUT_DOWNLOAD_ORIGINS=sourceorigin if task_media else "",
        FEDERATION_MEDIA_OBJECT_DOWNLOAD_ORIGINS=sourceorigin if task_media else "",
        FEDERATION_SITE_ID=configuration["source"]["siteId"],
        FEDERATION_SIGNING_KEY_ID=configuration["source"]["keyId"],
        FEDERATION_SIGNING_KEY_FILE=str(root / "source-signing.pem"),
        FEDERATION_SOCKET_PATH=str(root / "source/ingress.sock"),
        FEDERATION_CLIENT_CERT_FILE=str(root / "peer.crt"),
        FEDERATION_CLIENT_KEY_FILE=str(root / "peer.key"),
        FEDERATION_CLIENT_CA_FILE=str(root / "ca/ca.crt"),
    )
    subprocess.run(
        ["bun", "--no-env-file", "run", "packages/db/src/pg/migrate.ts"],
        cwd=repo,
        env=sourceenv,
        stdout=log,
        stderr=log,
        timeout=120,
        check=True,
    )
    run(["bun", "--no-env-file", "run", "scripts/federation-live/source.ts"])
    os.chmod(root / "source-signing.pem", 0o600)
    if disk_pressure:
        configure_storage(sourceenv, "source")
    sourcelog = open(logs / "source-server.log", "w")
    sourceserver = subprocess.Popen(
        ["bun", "--no-env-file", "run", "scripts/federation-live/server.ts"],
        cwd=repo,
        env=sourceenv,
        stdout=sourcelog,
        stderr=sourcelog,
        start_new_session=True,
    )

    def sourceapi(path, body=None, token=None):
        req = urllib.request.Request(
            f"http://127.0.0.1:{sourcehttp}/api/" + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Content-Type": "application/json",
                **({"Authorization": "Bearer " + token} if token else {}),
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            body = error.read()
            (logs / "source-http-error.json").write_bytes(body)
            raise urllib.error.HTTPError(error.url, error.code, error.msg, error.headers, io.BytesIO(body)) from error

    for _ in range(45):
        if sourceserver.poll() is not None:
            raise RuntimeError("Source Server exited; see source-server.log")
        try:
            sourceapi("health")
            break
        except (OSError, ValueError):
            time.sleep(1)
    else:
        raise RuntimeError("Source Server health timeout")
    sourcegatewayenv = sourceenv.copy()
    sourcegatewayenv.update(
        FEDERATION_TLS_PORT=str(sourcegatewayport),
        FEDERATION_TLS_HOST="127.0.0.1",
        FEDERATION_TLS_CA_FILE=str(root / "ca/ca.crt"),
        FEDERATION_TLS_CERT_FILE=str(root / "tls.crt"),
        FEDERATION_TLS_KEY_FILE=str(root / "tls.key"),
    )
    sourcegateway = subprocess.Popen(
        ["node", str(root / "gateway.mjs")],
        cwd=repo,
        env=sourcegatewayenv,
        stdout=sourcelog,
        stderr=sourcelog,
    )
    for _ in range(30):
        try:
            with socket.create_connection(("127.0.0.1", sourcegatewayport), timeout=1):
                break
        except OSError:
            time.sleep(0.2)
    sourcetoken = sourceapi(
        "auth/login", {"email": "source-admin@test.invalid", "role": "platform_admin"}
    )["token"]
    # Keep compile/typecheck CPU contention out of the real scheduling acceptance.
    healthy = 0
    for _ in range(90):
        current = api("agents/" + env["LAB_AGENT"], token=token)
        cpu = current.get("cpuUsagePercent")
        healthy = healthy + 1 if isinstance(cpu, (int, float)) and 0 <= cpu < 80 else 0
        if healthy >= 3:
            break
        time.sleep(2)
    else:
        raise RuntimeError("Lab node is busy; retry without concurrent builds")
    run(["bun", "--no-env-file", "run", "scripts/federation-live/" + ("business.ts" if coordinated else "bilateral.ts")], timeout=1200)
    configuration = json.loads((root / "source-init.json").read_text())
    if scenario == "workflow":
        (logs / "source-workflow.json").write_text((root / "source-workflow.json").read_text())
    if coordinated:
        (logs / "ledger-proof.json").write_text((root / "ledger-proof.json").read_text())
    (logs / "agreement-exchange.json").write_text((root / "agreement-exchange.json").read_text())
    (logs / "approval-exchange.json").write_text((root / "approval-exchange.json").read_text())
    if coordinated:
        (logs / "market-requests.json").write_text((root / "market-requests.json").read_text())
    if coordinated:
        (logs / "reservation-proposals.json").write_text((root / "reservation-proposals.json").read_text())
    if coordinated:
        (logs / "execution-automation.json").write_text((root / "execution-automation.json").read_text())
    def inspect_ledgers(suffix):
        for name, setting in [("source", sourceenv), ("provider", env)]:
            subprocess.run(
                ["bun", "--no-env-file", "scripts/federation-live/inspect.ts"]
                + (["--closed"] if scenario in ("success", "workflow") and (suffix in ("after", "settlement-offline", "settlement-committed") or suffix.startswith(("adjustment-", "payment-", "freeze-"))) else []),
                cwd=repo,
                env={
                    **setting,
                    "LAB_EVIDENCE": str(logs / (name + "-" + suffix + ".json")),
                },
                stdout=log,
                stderr=log,
                check=True,
                timeout=30,
            )

    inspect_ledgers("before")

    if refund_scenario:
        verify_refund()
        if attested:
            verify_attested_recovery()
        if disk_pressure:
            verify_storage_closure()
    else:
        terminal_policies = {}
        if coordinated and scenario in ("success", "workflow"):
            policy_path = "federation/commercial-agreements/" + configuration["request"]["agreementRevisionId"] + "/terminal-policies"
            policy_input = {"outcomes": ["completed"], "validUntil": configuration["request"].get("executionExpiresAt", configuration["request"]["expiresAt"])}
            terminal_policies["provider"] = api(policy_path, policy_input, token=token)["data"]
            terminal_policies["source"] = sourceapi(policy_path, policy_input, sourcetoken)["data"]
            (logs / "terminal-policies.json").write_text(json.dumps(terminal_policies, indent=2) + "\n")
        if not coordinated and not media_scenario:
            path = "federation/commercial-agreements/" + configuration["request"]["agreementRevisionId"]
            grant_closing(path, "bill")
            grant_closing(path, "settlement")
            (logs / "preauthorized-closing.json").write_text(json.dumps(closing_grants, indent=2) + "\n")
        if media_scenario:
            print("Media execution scenario: submission waits for source dataset setup" if media_execution else "Media-only scenario: no compute submission", flush=True)
        elif scenario in ("workflow", "task-media"):
            print("Ordinary Workflow owns delegation; no manual outbound submission", flush=True)
        else:
            first = sourceapi("federation/outbound", configuration["request"], sourcetoken)
            second = sourceapi("federation/outbound", configuration["request"], sourcetoken)
            assert (
                first["data"]["operationId"] == second["data"]["operationId"]
            ), "Source created a new operation on replay"
            print(
                "Source Server accepted the original request twice; production worker is responsible for mTLS delivery",
                flush=True,
            )

        if self_account:
            verify_selfaccount_restart()

        # Enroll a separate production Agent with the source institution, using its actual API.
        sourceagent = "federation-source-copy-" + namespace[-8:]
        sourceenv["LAB_AGENT"] = sourceagent
        seed = r"""
     import {createPgDb} from '@kuintessence/db';
     import {ensureCa} from './packages/server/src/auth/ca';
     import {AgentRegistrationService} from './packages/server/src/services/agent-registration';
     const db=createPgDb(process.env.DATABASE_URL);const actor=await Bun.file(process.env.LAB_ROOT+'/source-actor.json').json();
     const token=await new AgentRegistrationService(db,await ensureCa(process.env.SERVER_CA_DIR)).createToken({agentId:process.env.LAB_AGENT,siteName:'Source result storage',providerOrgId:actor.orgId,expiresInSec:600,createdBy:actor.userId});
     await Bun.write(process.env.LAB_ROOT+'/source-registration.json',JSON.stringify({token:token.token}));await db.$client.end();
     """
        subprocess.run(
            ["bun", "--no-env-file", "-e", seed],
            cwd=repo,
            env=sourceenv,
            stdout=log,
            stderr=log,
            timeout=60,
            check=True,
        )
        os.chmod(root / "source-registration.json", 0o600)
        source_registration = json.loads((root / "source-registration.json").read_text())
        subprocess.run(
            [
                "bun",
                "--no-env-file",
                "run",
                "packages/cli/src/index.ts",
                "agent",
                "register",
                "--url",
                f"http://127.0.0.1:{sourcehttp}",
                "--grpc-url",
                f"https://{nodeip}:{sourcegrpc}",
                "--token",
                source_registration["token"],
                "--output-dir",
                str(root / "source-agent"),
                "--scheduler",
                "kubernetes",
            ],
            cwd=repo,
            env=sourceenv,
            stdout=log,
            stderr=log,
            timeout=60,
            check=True,
        )
        (root / "source-agent/agent.env").open("a").write(
            "\nAGENT_DB_PATH=/var/lib/kuintessence/agent.db\nHEARTBEAT_INTERVAL_SEC=1\nAGENT_QUEUE_INVENTORY_INTERVAL_SEC=2\n"
        )
        sourcepod = copy.deepcopy(source_pod_template)
        sourcepod["metadata"]["name"] = "result-copy-agent"
        sourceagentenv = {
            **agentenv,
            "KQ_AGENT_ENV_FILE": str(root / "source-agent/agent.env"),
            "AGENT_SANDBOX_ENABLED": "false",
            "AGENT_FEDERATION_RESULT_COPY": json.dumps(
                {
                    "stagingRoot": "/var/lib/kuintessence/result-staging",
                    "maxStagingBytes": 1048576,
                    "allowedSourceOrigins": [] if task_media else [targetorigin],
                    "allowedDestinationOrigins": [sourceorigin],
                }
            ),
        }
        if media_scenario:
            sourceagentenv.pop("AGENT_FEDERATION_MEDIA_IMPORT", None)
            sourceagentenv.update(AGENT_DATASET_ROOTS_JSON=json.dumps({media_source_root: "."}),
                                  AGENT_FEDERATION_MEDIA_EXPORT=json.dumps({"mediaDirectory": "/var/lib/kuintessence/media", "ageDirectory": "/opt/kq/age"}))
        if task_media:
            sourceagentenv.pop("AGENT_FEDERATION_INPUT_COPY", None)
            sourceagentenv.update(AGENT_DATASET_ROOTS_JSON=json.dumps({media_source_root: "."}),
                                  AGENT_FEDERATION_MEDIA_EXPORT=json.dumps({"mediaDirectory": "/var/lib/kuintessence/media", "ageDirectory": "/opt/kq/age", "allowedSourceOrigins": [sourceorigin]}))
        sourcepod["spec"]["containers"][0]["env"] = [
            {"name": a, "value": b} for a, b in sourceagentenv.items()
        ]
        k(["apply", "-f", "-"], json.dumps(sourcepod))
        for _ in range(60):
            status = sourceapi("agents", token=sourcetoken)
            rows = (
                status
                if isinstance(status, list)
                else status.get("agents", status.get("items", []))
            )
            if any(
                row.get("agentId") == sourceagent and row.get("status") == "online"
                for row in rows
            ):
                break
            time.sleep(1)
        else:
            raise RuntimeError("Source copy Agent did not come online")
        print(
            "Source Agent independently enrolled and online; result copy/verification enabled",
            flush=True,
        )

        if media_scenario:
            from media import verify_media, verify_media_accounting
            verify_media(root, logs, namespace, env, sourceenv,
                         lambda path, body=None: api(path, body, token),
                         lambda path, body=None: sourceapi(path, body, sourcetoken))
        elif task_media:
            from task_media import verify_task_media
            verify_task_media(root, logs, namespace, env, sourceenv,
                              lambda path, body=None: api(path, body, token),
                              lambda path, body=None: sourceapi(path, body, sourcetoken),
                              {"serverUrl": f"http://127.0.0.1:{httpport}", "token": token},
                              {"serverUrl": f"http://127.0.0.1:{sourcehttp}", "token": sourcetoken})
        elif scenario in ("outage", "stop"):
            verify_interruption()
        else:
            verify_success()
            if coordinated:
                verify_terminal()
            bill_record = verify_billing()
            if coordinated:
                verify_settlement()
                if native_dispute:
                    verify_native_dispute()
                else:
                    verify_adjustments()
                    verify_payments()
            else:
                verify_bilateral_finance()
                if disclosure_scenario:
                    from disclosure import verify_disclosure

                    def provider_gateway(running):
                        global gateway
                        if not running:
                            assert gateway.poll() is None
                            gateway.terminate()
                            assert gateway.wait(timeout=15) == 0
                            return
                        gateway = subprocess.Popen(["node", str(root / "gateway.mjs")], cwd=repo, env=env, stdout=serverlog, stderr=serverlog)
                        for _ in range(30):
                            assert gateway.poll() is None, "Provider gateway restart failed"
                            try:
                                with socket.create_connection(("127.0.0.1", gatewayport), timeout=1):
                                    return
                            except OSError:
                                time.sleep(0.2)
                        raise AssertionError("Provider gateway restart timeout")

                    verify_disclosure(root, logs, env,
                                      lambda path, body=None: sourceapi(path, body, sourcetoken),
                                      lambda path, body=None: api(path, body, token),
                                      pg, port, inspect_ledgers, provider_gateway,
                                      orderer if case_scenario else None,
                                      restart_commercial_servers if case_scenario else None)
                else:
                    verify_payments()
                if attested:
                    verify_attested_recovery()
        inspect_ledgers("after")
        if media_scenario and not media_execution:
            verify_media_accounting(logs)
        if coordinated and scenario in ("success", "workflow"):
            state = json.loads((logs / "provider-after.json").read_text())
            transactions = [r for r in state["commercialTransactions"] if r["submissionId"] == bill_record["id"]]
            valid = [r for r in transactions if r["stage"] == "committed" and r["validationCode"] == 0 and r["blockNumber"] is not None]
            assert len(valid) == 1, "Expected one original VALID bill transaction"
            (logs / "billing-committed-evidence.json").write_text(json.dumps({"record": bill_record, "transactions": transactions}, indent=2) + "\n")
            print("REAL BILL EVIDENCE PASSED: original durable intent -> VALID private bill after Orderer recovery; bill confirmation alone does not settle balances", flush=True)

finally:
    cleanup_errors = []

    def clean(action):
        try:
            action()
        except Exception as error:
            cleanup_errors.append(str(error))
            print("Lab cleanup failure: " + str(error), flush=True)

    def stop_process(process):
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    def capture(name, args):
        result = k(args, check=False)
        (logs / name).write_text(result.stdout + result.stderr)

    for process in [sourcegateway, gateway, sourceserver, server, storageproxy, *storage_observers]:
        clean(lambda process=process: stop_process(process))
    if created:
        if self_account:
            clean(lambda: capture("slurm-daemons.log", ["exec", "-n", namespace, "scheduler", "--", "tail", "-n", "80", "/tmp/mysql.log", "/tmp/slurmdbd.log", "/tmp/slurmctld.log", "/tmp/slurmd.log"]))
        for name, args in [
            (
                "source-agent.log",
                ["logs", "-n", namespace, "result-copy-agent", "--tail=200"],
            ),
            ("agent.log", ["logs", "-n", namespace, "scheduler", "--tail=300"]),
            (
                "events.log",
                ["get", "events", "-n", namespace, "--sort-by=.lastTimestamp"],
            ),
            ("storage.log", ["logs", "storage", "-n", namespace, "--tail=30"]),
            (
                "workload-state.json",
                ["get", "jobs,pods", "-n", namespace, "-o", "json"],
            ),
        ]:
            clean(lambda name=name, args=args: capture(name, args))
        clean(
            lambda: k(
                [
                    "delete",
                    "namespace",
                    namespace,
                    "--ignore-not-found",
                    "--timeout=90s",
                ],
                timeout=100,
            )
        )
    if clusterrole:
        clean(
            lambda: k(
                [
                    "delete",
                    "clusterrole,clusterrolebinding",
                    clusterrole,
                    "--ignore-not-found",
                ]
            )
        )
    if pgstarted:
        clean(
            lambda: pg(
                "pg_ctl", "-D", str(pgroot / "data"), "-m", "immediate", "-w", "stop"
            )
        )
    if (pgroot / "postgres.log").exists():
        clean(lambda: shutil.copyfile(pgroot / "postgres.log", logs / "postgres.log"))
    for handle in [log, serverlog, sourcelog, proxylog]:
        if handle:
            clean(handle.close)
    # Retain mounts and private diagnostics if cleanup could not confirm resources stopped.
    if not cleanup_errors:
        if profilepath:
            clean(lambda: profilepath.unlink(missing_ok=True))
        if pressure_mounted:
            clean(lambda: subprocess.run(["umount", str(pgroot)], check=True, capture_output=True, timeout=30))
        if not cleanup_errors:
            clean(lambda: shutil.rmtree(pgroot))
        if not cleanup_errors:
            clean(lambda: shutil.rmtree(root))
    if cleanup_errors:
        raise RuntimeError(
            "Incomplete cleanup; inspect private evidence at " + str(logs)
        )
    print(
        "Cleaned isolated Server, database, credentials and scheduler namespace",
        flush=True,
    )

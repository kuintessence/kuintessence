"""Isolated full Server and real Kubernetes artifact pipeline probe; no deployment credentials."""

import json, os, pathlib, secrets, shutil, signal, socket, subprocess, tempfile, time, urllib.request, uuid
from datetime import datetime

repo = pathlib.Path(__file__).resolve().parents[2]
if os.environ.get("KQ_FEDERATION_EXECUTION_LAB") != "1":
    raise SystemExit(
        "Set KQ_FEDERATION_EXECUTION_LAB=1 for the disposable local k3s lab"
    )
if os.geteuid() != 0:
    raise SystemExit("Run on a disposable local k3s node as root")
os.umask(0o077)
scenario = os.environ.get("LAB_SCENARIO", "success")
assert scenario in ("success", "outage", "stop")
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
env["LAB_FABRIC_ROOT"] = os.environ["LAB_FABRIC_ROOT"]


def port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


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
networkroot = pathlib.Path(os.environ["LAB_FABRIC_ROOT"])
network = json.loads((networkroot / "network.json").read_text())
siteb = next(site for site in network["sites"] if site["name"] == "B")
env.update(
    FEDERATION_SITE_ID=siteb["siteId"],
    FEDERATION_SIGNING_KEY_ID="batch-1",
    FEDERATION_COMMERCIAL_SOCKET_PATH=str(
        networkroot / "live-B-commercial/commercial.sock"
    ),
    FEDERATION_MARKET_SOCKET_PATH=str(networkroot / "live-B-market/market.sock"),
)
logs = pathlib.Path(
    tempfile.mkdtemp(prefix="federation-execution-" + scenario + "-", dir=repo / "temp")
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


def run(args, **kw):
    return subprocess.run(
        args, cwd=repo, env=env, check=True, stdout=log, stderr=log, timeout=120, **kw
    )


def pg(*args):
    run(["runuser", "-u", "nobody", "--", pgbin + args[0], *args[1:]])


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
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)


def orderer(action):
    (networkroot / ("execution-orderer-" + action)).write_text(action)
    deadline = time.monotonic() + 45
    while not (networkroot / ("execution-orderer-" + action + ".ack")).exists():
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
    importid = str(uuid.uuid4())
    path = f"federation/outbound/{operation}/result-imports"
    created_import = sourceapi(path, {"importId": importid}, sourcetoken)
    assert created_import["data"]["state"] == "pending"
    for _ in range(120):
        result = sourceapi(path + "/" + importid, token=sourcetoken)["data"]
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


try:
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
    pg(
        "pg_ctl",
        "-D",
        str(pgroot / "data"),
        "-l",
        str(pgroot / "postgres.log"),
        "-o",
        f"-h 127.0.0.1 -p {pgport} -k {pgroot}",
        "-w",
        "start",
    )
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
            "kubernetes",
        ]
    )
    (root / "agent/agent.env").open("a").write(
        "\nAGENT_DB_PATH=/var/lib/kuintessence/agent.db\nHEARTBEAT_INTERVAL_SEC=1\nAGENT_QUEUE_INVENTORY_INTERVAL_SEC=2\n"
    )
    print("Agent enrolled using the production registration API and CLI", flush=True)
    node = json.loads(k(["get", "nodes", "-o", "json"]).stdout)["items"][0]["metadata"][
        "name"
    ]
    runtimeimage = "docker.io/bitnamilegacy/kubectl@sha256:f65b74480c37b65099453fb3a5ca7eaaea235b3d4268ef3b1ed0f0150d340646"
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
    raw = subprocess.check_output(["k3s", "ctr", "content", "get", digest])
    assert (
        "sha256:" + hashlib.sha256(raw).hexdigest() == digest
    ), "Runtime OCI manifest digest mismatch"
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
    k(["apply", "-f", "-"], json.dumps(pod))
    token = api(
        "auth/login",
        {"email": "federation-lab-admin@test.invalid", "role": "platform_admin"},
    )["token"]
    for _ in range(60):
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
    print("Real Kubernetes Agent online through direct mTLS", flush=True)
    api(
        "admin/queues",
        {
            "queueId": "federation-lab-debug",
            "name": "Isolated Kubernetes",
            "providerOrgId": registration["orgId"],
            "visibleOrgIds": [registration["orgId"]],
            "agentId": env["LAB_AGENT"],
            "schedulerType": "kubernetes",
            "queueName": namespace,
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
    sourceenv = env.copy()
    sourceenv.update(
        FEDERATION_COMMERCIAL_SOCKET_PATH=str(
            networkroot / "live-A-commercial/commercial.sock"
        ),
        FEDERATION_MARKET_SOCKET_PATH=str(networkroot / "live-A-market/market.sock"),
    )
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
        FEDERATION_RESULT_IMPORT_SOURCE_ORIGINS=targetorigin,
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
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.load(response)

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
    run(["bun", "--no-env-file", "run", "scripts/federation-live/business.ts"])
    (logs / "ledger-proof.json").write_text((root / "ledger-proof.json").read_text())
    first = sourceapi("federation/outbound", configuration["request"], sourcetoken)
    second = sourceapi("federation/outbound", configuration["request"], sourcetoken)
    assert (
        first["data"]["operationId"] == second["data"]["operationId"]
    ), "Source created a new operation on replay"
    print(
        "Source Server accepted the original request twice; production worker is responsible for mTLS delivery",
        flush=True,
    )

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
    sourcepod = copy.deepcopy(pod)
    sourcepod["metadata"]["name"] = "result-copy-agent"
    sourceagentenv = {
        **agentenv,
        "KQ_AGENT_ENV_FILE": str(root / "source-agent/agent.env"),
        "AGENT_SANDBOX_ENABLED": "false",
        "AGENT_FEDERATION_RESULT_COPY": json.dumps(
            {
                "stagingRoot": "/var/lib/kuintessence/result-staging",
                "maxStagingBytes": 1048576,
                "allowedSourceOrigins": [targetorigin],
                "allowedDestinationOrigins": [sourceorigin],
            }
        ),
    }
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

    def inspect_ledgers(suffix):
        for name, setting in [("source", sourceenv), ("provider", env)]:
            subprocess.run(
                ["bun", "--no-env-file", "scripts/federation-live/inspect.ts"],
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
    if scenario in ("outage", "stop"):
        verify_interruption()
    else:
        verify_success()
    inspect_ledgers("after")

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

    for process in [sourcegateway, gateway, sourceserver, server, storageproxy]:
        clean(lambda process=process: stop_process(process))
    if created:
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
    for handle in [log, serverlog, sourcelog, proxylog]:
        if handle:
            clean(handle.close)
    # Retain mounts and private diagnostics if cleanup could not confirm resources stopped.
    if not cleanup_errors:
        if profilepath:
            clean(lambda: profilepath.unlink(missing_ok=True))
        clean(lambda: shutil.rmtree(pgroot))
        clean(lambda: shutil.rmtree(root))
    if cleanup_errors:
        raise RuntimeError(
            "Incomplete cleanup; inspect private evidence at " + str(logs)
        )
    print(
        "Cleaned isolated Server, database, credentials and scheduler namespace",
        flush=True,
    )

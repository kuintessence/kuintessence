"""Three isolated full Servers: offline policy withdrawal, mTLS and native transaction recovery."""
import base64
import hashlib
import json
import os
import pathlib
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

repo = pathlib.Path(__file__).resolve().parents[2]
network_root = pathlib.Path(os.environ["LAB_FABRIC_ROOT"]).resolve()
assert network_root.parent == repo / "temp" and network_root.name.startswith("fabric-network-")
pgbin = pathlib.Path(os.environ["KQ_FEDERATION_PG_BIN"]).resolve()
assert os.geteuid() == 0 and all((pgbin / name).is_file() for name in ("initdb", "pg_ctl", "createdb"))
os.umask(0o077)
root = pathlib.Path(tempfile.mkdtemp(prefix="arbitration-platforms-", dir=repo / "temp"))
pgroot = pathlib.Path(tempfile.mkdtemp(prefix="kq-arbitration-pg-"))
os.chown(pgroot, 65534, 65534)
env = {key: value for key, value in os.environ.items() if key in ("PATH", "HOME", "LANG", "TMPDIR")}
if os.environ.get("KQ_FEDERATION_PG_LIB"):
    env["LD_LIBRARY_PATH"] = os.environ["KQ_FEDERATION_PG_LIB"]
env.update(LAB_ARBITRATION_ROOT=str(root), LAB_FABRIC_ROOT=str(network_root))
log = (root / "setup.log").open("w")
processes = []
logs = []
servers = {}
gateways = {}
settings = {}
tokens = {}
pgstarted = False
ports = set()


def interrupted(signum, frame):
    raise RuntimeError("Arbitration lab interrupted; cleaning owned processes")


signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)


def port():
    while True:
        value = 10000 + secrets.randbelow(20000)
        if value in ports:
            continue
        try:
            with socket.socket() as s:
                s.bind(("127.0.0.1", value))
        except OSError:
            continue
        ports.add(value)
        return value


def run(args, setting=env):
    return subprocess.run(args, cwd=repo, env=setting, stdout=log, stderr=log, check=True, timeout=120)


def pg(*args):
    return run(["runuser", "-u", "nobody", "--", str(pgbin / args[0]), *args[1:]])


def probe(action, label, extra=None):
    path = root / (label + ".json")
    run(["bun", "--no-env-file", "scripts/federation-live/arbitration.ts", action],
        {**env, "LAB_EVIDENCE": str(path), **(extra or {})})
    return json.loads(path.read_text())


def snapshot(label):
    return probe("snapshot", label)


def request(name, path, body=None):
    headers = {"content-type": "application/json"}
    if name in tokens:
        headers["authorization"] = "Bearer " + tokens[name]
    req = urllib.request.Request(f"http://127.0.0.1:{settings[name]['SERVER_PORT']}/api/" + path,
                                 data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as response:
        if path.startswith("federation/"):
            assert response.headers.get("cache-control") == "no-store"
        value = json.load(response)
        return value.get("data", value)


def wait_for(check, description, timeout=180):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(1)
    raise AssertionError(description)


def launch(name, gateway=False):
    setting = settings[name]
    handle = (root / (name + ("-gateway.log" if gateway else "-server.log"))).open("a")
    logs.append(handle)
    command = ["node", str(root / "gateway.mjs")] if gateway else ["bun", "--no-env-file", "scripts/federation-live/server.ts"]
    process = subprocess.Popen(command, cwd=repo, env=setting, stdout=handle, stderr=handle, start_new_session=True)
    processes.append(process)

    def ready():
        assert process.poll() is None, "Owned Server or gateway exited; inspect private log"
        try:
            if gateway:
                with socket.create_connection(("127.0.0.1", int(setting["FEDERATION_TLS_PORT"])), timeout=1):
                    return True
            return request(name, "health")
        except (OSError, ValueError):
            return False
    wait_for(ready, "Platform readiness timeout", 60)
    return process


def kill(process):
    assert process.poll() is None and os.getpgid(process.pid) == process.pid
    os.killpg(process.pid, signal.SIGKILL)
    assert process.wait(timeout=15) == -signal.SIGKILL


def control(action):
    value = {"id": str(uuid.uuid4()), "action": action}
    temporary = network_root / "arbitration-control.tmp"
    temporary.write_text(json.dumps(value))
    temporary.replace(network_root / "arbitration-control.json")

    def acknowledged():
        try:
            result = json.loads((network_root / "arbitration-control.ack").read_text())
            return result if result.get("id") == value["id"] else None
        except (FileNotFoundError, json.JSONDecodeError):
            return None
    return wait_for(acknowledged, "Fabric control timeout", 60)


def denied(name, path, body):
    try:
        request(name, path, body)
    except urllib.error.HTTPError as error:
        result = json.load(error)
        assert error.code == 409 and result["error"]["code"] == "AUTHORIZATION_EXPIRED"
        return
    raise AssertionError("Received withdrawal must prevent new approval")


print("Private arbitration evidence: " + str(root), flush=True)
try:
    pgport = port()
    init = ["initdb", "-D", str(pgroot / "data"), "-A", "trust", "--no-locale", "-U", "kq"]
    if os.environ.get("KQ_FEDERATION_PG_SHARE"):
        init += ["-L", os.environ["KQ_FEDERATION_PG_SHARE"]]
    pg(*init)
    pg("pg_ctl", "-D", str(pgroot / "data"), "-l", str(pgroot / "postgres.log"), "-o",
       f"-h 127.0.0.1 -p {pgport} -k {pgroot}", "-w", "start")
    pgstarted = True
    (root / "ca").mkdir()
    run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(root / "ca/ca.key"),
         "-out", str(root / "ca/ca.crt"), "-days", "1", "-subj", "/CN=Isolated arbitration CA"])
    (root / "leaf.ext").write_text("extendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n")
    network = json.loads((network_root / "network.json").read_text())
    platforms = []
    for site in network["sites"]:
        name = site["name"]
        assert name in ("A", "B", "C")
        database = "kuintessence_unit_arbitration_" + name.lower()
        pg("createdb", "-h", "127.0.0.1", "-p", str(pgport), "-U", "kq", database)
        directory = root / name
        directory.mkdir()
        run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", str(directory / "tls.key"),
             "-out", str(directory / "tls.csr"), "-subj", "/CN=" + name])
        run(["openssl", "x509", "-req", "-in", str(directory / "tls.csr"), "-CA", str(root / "ca/ca.crt"),
             "-CAkey", str(root / "ca/ca.key"), "-CAcreateserial", "-out", str(directory / "tls.crt"),
             "-days", "1", "-extfile", str(root / "leaf.ext")])
        gateway_port = port()
        setting = {**env, "DATABASE_URL": f"postgres://kq@127.0.0.1:{pgport}/{database}",
                   "REDIS_URL": "redis://127.0.0.1:1", "JWT_SECRET": secrets.token_hex(32),
                   "SERVER_PORT": str(port()), "SERVER_GRPC_PORT": str(port()), "SERVER_CA_DIR": str(root / "ca"),
                   "SERVER_GRPC_TLS_CERT_FILE": str(directory / "tls.crt"), "SERVER_GRPC_TLS_KEY_FILE": str(directory / "tls.key"),
                   "MTLS_MODE": "direct", "LOG_LEVEL": "warn", "NODE_ENV": "development", "NETDRIVE_ENABLED": "false", "AUTHZ_MODE": "off",
                   "FEDERATION_ENABLED": "true", "FEDERATION_SITE_ID": site["siteId"], "FEDERATION_SIGNING_KEY_ID": "batch-1",
                   "FEDERATION_SIGNING_KEY_FILE": site["businessKeyFile"], "FEDERATION_SOCKET_PATH": str(directory / "ingress.sock"),
                   "FEDERATION_CLIENT_CERT_FILE": str(directory / "tls.crt"), "FEDERATION_CLIENT_KEY_FILE": str(directory / "tls.key"),
                   "FEDERATION_CLIENT_CA_FILE": str(root / "ca/ca.crt"), "FEDERATION_TLS_HOST": "127.0.0.1",
                   "FEDERATION_TLS_PORT": str(gateway_port), "FEDERATION_TLS_CA_FILE": str(root / "ca/ca.crt"),
                   "FEDERATION_TLS_CERT_FILE": str(directory / "tls.crt"), "FEDERATION_TLS_KEY_FILE": str(directory / "tls.key")}
        if name != "C":
            setting["FEDERATION_COMMERCIAL_SOCKET_PATH"] = str(network_root / f"live-{name}-commercial/commercial.sock")
        settings[name] = setting
        run(["bun", "--no-env-file", "packages/db/src/pg/migrate.ts"], setting)
        platforms.append({"name": name, "siteId": site["siteId"], "businessKeyFile": site["businessKeyFile"],
                          "databaseUrl": setting["DATABASE_URL"], "endpoint": f"https://127.0.0.1:{gateway_port}", "certificateFile": str(directory / "tls.crt")})
    (root / "platforms.json").write_text(json.dumps({"domainId": network["trust"]["domains"][0]["domainId"], "sites": platforms}))
    probe("setup", "actors")
    run(["bun", "build", "--target=node", "--format=esm", "packages/server/src/federation/gateway-main.ts", "--outfile", str(root / "gateway.mjs")])
    for name in settings:
        servers[name] = launch(name)
        gateways[name] = launch(name, True)
        tokens[name] = request(name, "auth/login", {"email": name.lower() + "@test.invalid", "role": "platform_admin"})["token"]
    terms = json.loads((root / "terms.json").read_text())
    revision = terms["agreement"]["agreementRevisionId"]
    contract_path = "federation/commercial-agreements/" + revision
    approvals = {name: request(name, "federation/commercial-agreements/approve", {"terms": terms}) for name in ("A", "B")}
    for own, other in (("A", "B"), ("B", "A")):
        request(own, contract_path + "/counterparty", {"approvalJws": approvals[other]["approvalJws"]})

    def contract_committed():
        values = [request(name, contract_path + "/submissions")["submissions"] for name in ("A", "B")]
        return all(rows and all(row["state"] == "committed" for row in rows) for rows in values)
    wait_for(contract_committed, "Original contract did not commit", 180)
    path = contract_path + "/arbitration-policies"
    policies = []
    for both in (True, False):
        policy = request("A", path + "/draft", {"policyId": str(uuid.uuid4()), "arbitratorSiteId": next(s["siteId"] for s in platforms if s["name"] == "C"),
                         "subjectTypes": ["bill"], "disclosures": [{"recordType": "bill", "fields": ["dueAmount"]}],
                         "requiredEvidence": [{"recordType": "bill", "fields": ["dueAmount"]}],
                         "decisionRule": "designated-arbitrator", "actions": ["settle"], "maxChargedAmount": "50", "validUntil": terms["agreement"]["validUntil"]})
        request("A", path + "/approve", policy)
        if both:
            request("B", path + "/approve", policy)
            def paired():
                rows = [request(name, path + "?policyId=" + policy["policyId"])["data"] for name in ("A", "B")]
                return all(len(value) == 1 and value[0]["counterpartyJws"] for value in rows)
            wait_for(paired, "Original arbitration signatures did not exchange", 100)
        policies.append(policy)
    control("stop")
    kill(gateways["B"])
    for policy in policies:
        request("A", path + "/" + policy["policyId"] + "/revoke", {})
    submitted = request("A", path + "/" + policies[0]["policyId"] + "/ledger-revocation", {})

    def durable():
        state = snapshot("pending")
        attempts = [a for a in state[0]["attempts"] if a["submissionId"] == submitted["id"] and a["stage"] == "transaction"]
        if len(state[0]["deliveries"]) == 4 and all(row["noticeJws"] for row in state[0]["deliveries"]) and len(state[2]["notices"]) == 2 and attempts:
            assert not state[1]["notices"]
            return state
        return None
    before = wait_for(durable, "Notifications and original transaction must persist during outage", 180)
    print("ARBITRATION: R received both withdrawals during Orderer/B gateway outage; B notices and original transaction persisted", flush=True)
    crashed = []
    for name, process in servers.items():
        kill(process)
        crashed.append({"site": name, "oldPid": process.pid, "exitCode": process.returncode})
    adapters = control("restart")["restarts"]
    assert len(adapters) == 2 and all(r["oldPid"] != r["newPid"] and r["exitCode"] != 0 for r in adapters)
    for row in crashed:
        servers[row["site"]] = launch(row["site"])
        row["newPid"] = servers[row["site"]].pid
        assert row["oldPid"] != row["newPid"]
    restored = snapshot("restored")
    for original, current in zip(before, restored):
        assert original["policies"] == current["policies"] and original["notices"] == current["notices"]
    original_attempt = next(a for a in before[0]["attempts"] if a["submissionId"] == submitted["id"])
    restored_attempt = next(a for a in restored[0]["attempts"] if a["id"] == original_attempt["id"])
    assert all(original_attempt[k] == restored_attempt[k] for k in ("transactionId", "recovery"))
    gateways["B"] = launch("B", True)
    for policy in policies:
        url = path + "/" + policy["policyId"] + "/revocation-deliveries"
        wait_for(lambda: all(row["state"] == "received" for row in request("A", url)["sent"]), "B withdrawal delivery recovery", 180)
        denied("B", path + "/approve", policy)
    delivered = snapshot("delivered")
    assert len(delivered[1]["notices"]) == len(delivered[2]["notices"]) == 2
    for previous in before[0]["deliveries"]:
        current = next(r for r in delivered[0]["deliveries"] if r["policyId"] == previous["policyId"] and r["receivingSiteId"] == previous["receivingSiteId"])
        assert current["noticeJws"] == previous["noticeJws"]
        if previous["receiptJws"]:
            assert current["receiptJws"] == previous["receiptJws"]
    assert not delivered[2]["contracts"] and not delivered[2]["policies"] and not delivered[2]["submissions"]
    control("start")
    wait_for(lambda: any(row["id"] == submitted["id"] and row["state"] == "committed" for row in request("A", contract_path + "/submissions?arbitrationPolicyId=" + policies[0]["policyId"])["submissions"]), "Original native withdrawal must commit after restart", 180)
    finished = snapshot("finished")
    attempts = [a for a in finished[0]["attempts"] if a["submissionId"] == submitted["id"]]
    assert len(attempts) == 1 and attempts[0]["transactionId"] == original_attempt["transactionId"] and attempts[0]["stage"] == "committed"
    signed = next(p for p in finished[0]["policies"] if p["policyId"] == policies[0]["policyId"])
    raw = signed["revocationJws"].split(".")[1]
    digest = "sha256:" + hashlib.sha256(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))).hexdigest()
    receipt = {"receipt": {"recordId": signed["revocationPayload"]["revocationId"], "digest": digest}}
    wait_for(lambda: probe("receipts", "receipts", {"LAB_REVOCATION_ID": receipt["receipt"]["recordId"]}) == [receipt, receipt], "A/B private native receipts differ", 60)
    withdrawals = [s for state in finished for s in state["submissions"] if s["input"]["operation"] == "revoke-arbitration-policy"]
    assert len(withdrawals) == 1 and withdrawals[0]["input"]["envelope"]["revocationJws"] == signed["revocationJws"]
    report = {"servers": 3, "databases": 3, "notificationRecipients": 2, "policies": 2, "originalTransactionRecovered": True,
              "originalNoticesAndReceiptsPreserved": True, "earlyWithdrawalBlocksApproval": True, "privateReceiptMembers": 2,
              "rHasNoContractsOrPolicyApproval": True, "serverCrashes": crashed, "adapterCrashes": adapters}
    (root / "report.json").write_text(json.dumps(report, indent=2))
    if os.environ.get("KQ_FABRIC_REPORT"):
        pathlib.Path(os.environ["KQ_FABRIC_REPORT"]).write_text(json.dumps(report, indent=2))
    print("REAL THREE-SERVER ARBITRATION PASSED: offline mTLS delivery, early withdrawal, Server/Adapter SIGKILL, original notices/receipts/transaction and A/B native receipts", flush=True)
finally:
    for process in reversed(processes):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=10)
    if pgstarted:
        pg("pg_ctl", "-D", str(pgroot / "data"), "-m", "immediate", "-w", "stop")
    shutil.rmtree(pgroot)
    for handle in logs:
        handle.close()
    log.close()

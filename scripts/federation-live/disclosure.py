"""Three full Servers: exact evidence over mTLS, fresh consent and durable recipient state."""

import io
import json
import os
import pathlib
import signal
import subprocess
import time
import urllib.error
import urllib.request
import urllib.parse
import uuid


def verify_disclosure(root, logs, env, sourceapi, providerapi, pg, port,
                      inspect_ledgers, provider_gateway):
    repo = pathlib.Path(__file__).resolve().parents[2]
    config = json.loads((root / "source-init.json").read_text())
    recipient_id = str(uuid.uuid4())
    (root / "disclosure-recipient.json").write_text(json.dumps({"siteId": recipient_id}))
    http_port, grpc_port = port(), port()
    recipient_url = env["DATABASE_URL"].rsplit("/", 1)[0] + "/kuintessence_unit_federation_recipient"
    settings = {**env, "LAB_RECIPIENT_DATABASE_URL": recipient_url}
    recipient_env = {key: value for key, value in env.items()
                     if not key.startswith(("NETDRIVE_", "DATA_MARKET_", "FEDERATION_"))}
    recipient_env.update(
        DATABASE_URL=recipient_url, SERVER_PORT=str(http_port), SERVER_GRPC_PORT=str(grpc_port),
        JWT_SECRET=os.urandom(32).hex(), NETDRIVE_ENABLED="false", FEDERATION_ENABLED="true",
        FEDERATION_SITE_ID=recipient_id, FEDERATION_SIGNING_KEY_ID="recipient-1",
        FEDERATION_SIGNING_KEY_FILE=str(root / "recipient-signing.pem"),
        FEDERATION_SOCKET_PATH=str(root / "recipient/ingress.sock"),
        FEDERATION_CLIENT_CERT_FILE=str(root / "recipient-client.crt"),
        FEDERATION_CLIENT_KEY_FILE=str(root / "recipient-client.key"),
        FEDERATION_CLIENT_CA_FILE=str(root / "ca/ca.crt"),
    )
    server = None
    handle = open(logs / "recipient-server.log", "w")

    def run(args, setting=settings):
        subprocess.run(args, cwd=repo, env=setting, check=True, stdout=handle, stderr=handle, timeout=120)

    def request(path, body=None, token=None):
        req = urllib.request.Request(
            f"http://127.0.0.1:{http_port}/api/" + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})},
        )
        try:
            with urllib.request.urlopen(req, timeout=25) as response:
                result = json.load(response)
                if path.startswith("federation/evidence-cases"):
                    assert response.headers.get("cache-control") == "no-store"
                return result
        except urllib.error.HTTPError as error:
            content = error.read()
            (logs / "recipient-http-error.json").write_bytes(content)
            raise urllib.error.HTTPError(error.url, error.code, error.msg, error.headers, io.BytesIO(content)) from error

    def start():
        process = subprocess.Popen(["bun", "--no-env-file", "run", "scripts/federation-live/server.ts"],
                                   cwd=repo, env=recipient_env, stdout=handle, stderr=handle, start_new_session=True)
        try:
            for _ in range(45):
                assert process.poll() is None, "Recipient Server exited"
                try:
                    request("health")
                    return process
                except (OSError, ValueError):
                    time.sleep(1)
            raise AssertionError("Recipient Server health timeout")
        except BaseException:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=15)
            raise

    def denied(action):
        try:
            action()
        except urllib.error.HTTPError as error:
            value = json.load(error)
            assert error.code in (403, 409, 502, 503), value
            assert "disclosure" not in value and "evidence" not in value, "Denied response leaked material"
            return {"status": error.code, "code": value["error"]["code"]}
        raise AssertionError("Read unexpectedly authorized")

    def paired(path):
        for _ in range(90):
            rows = [read(path)["data"]["data"] for read in (sourceapi, providerapi)]
            if all(len(items) == 1 and items[0]["counterpartyJws"] for items in rows):
                assert rows[0][0]["approvalJws"] == rows[1][0]["counterpartyJws"]
                assert rows[1][0]["approvalJws"] == rows[0][0]["counterpartyJws"]
                return [items[0] for items in rows]
            time.sleep(1)
        raise AssertionError("Original disclosure signatures did not exchange")

    try:
        pg("createdb", "-h", "127.0.0.1", "-p", str(urllib.parse.urlparse(recipient_url).port), "-U", "kq", "kuintessence_unit_federation_recipient")
        run(["bun", "--no-env-file", "run", "packages/db/src/pg/migrate.ts"], recipient_env)
        run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(root / "recipient-signing.pem")])
        run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", str(root / "recipient-client.key"), "-out", str(root / "recipient-client.csr"), "-subj", "/CN=evidence-recipient"])
        run(["openssl", "x509", "-req", "-in", str(root / "recipient-client.csr"), "-CA", str(root / "ca/ca.crt"), "-CAkey", str(root / "ca/ca.key"), "-CAcreateserial", "-out", str(root / "recipient-client.crt"), "-days", "1", "-extfile", str(root / "target-client.ext")])
        run(["bun", "--no-env-file", "scripts/federation-live/disclosure.ts", "setup"])
        server = start()
        token = request("auth/login", {"email": "recipient-admin@test.invalid", "role": "platform_admin"})["token"]
        api = lambda path, body=None: request(path, body, token)
        inspect_ledgers("disclosure-before")
        before = {name: json.loads((logs / (name + "-disclosure-before.json")).read_text()) for name in ("source", "provider")}
        bill = before["source"]["bills"][0]
        path = "federation/commercial-agreements/" + config["request"]["agreementRevisionId"]
        opening = sourceapi(path + "/disputes/draft", {
            "caseId": str(uuid.uuid4()), "subject": {"recordType": "bill", "recordId": bill["billId"], "recordDigest": bill["digest"]},
            "reason": "Review the signed charge", "requestedResolution": "Authorize one exact evidence field",
        })["data"]
        sourceapi(path + "/disputes/open", opening)
        for _ in range(90):
            rows = [read(path + "/disputes?caseId=" + opening["caseId"])["data"]["data"] for read in (sourceapi, providerapi)]
            if all(len(items) == 1 and items[0]["state"] == "DISPUTED" for items in rows):
                break
            time.sleep(1)
        else:
            raise AssertionError("Direct dispute did not confirm on both Servers")
        policy = sourceapi(path + "/disclosure-policies/draft", {
            "policyId": str(uuid.uuid4()), "recipientSiteId": recipient_id,
            "disclosures": [{"recordType": "bill", "fields": ["dueAmount"]}], "validUntil": config["terms"]["validUntil"],
        })["data"]
        for read in (sourceapi, providerapi):
            read(path + "/disclosure-policies/approve", policy)
        policies = paired(path + "/disclosure-policies?policyId=" + policy["policyId"])
        context = {key: policy[key] for key in ("domainId", "agreementRevisionId", "agreementDigest", "sourceSiteId", "targetSiteId")}
        context.update(caseId=opening["caseId"], evidenceRecipientSiteId=recipient_id)
        evidence_path = "federation/evidence-cases/" + opening["caseId"]
        api("federation/evidence-cases", context)
        outcomes = []
        for index, revoke in enumerate((providerapi, sourceapi)):
            draft = sourceapi(path + "/disclosures/draft", {
                "grantId": str(uuid.uuid4()), "caseId": opening["caseId"], "policyId": policy["policyId"],
                "recordType": "bill", "recordId": bill["billId"], "recordDigest": bill["digest"],
                "fields": ["dueAmount"], "validUntil": policy["validUntil"],
            })["data"]
            approval = sourceapi(path + "/disclosures/approve", draft)["data"]
            scope = {**context, "grantId": draft["grant"]["grantId"], "policyId": policy["policyId"],
                     "policyDigest": policies[0]["digest"], "disclosureDigest": approval["digest"]}
            read_path = evidence_path + "/disclosures/" + scope["grantId"]
            one_sided = denied(lambda: api(evidence_path + "/disclosures", scope))
            providerapi(path + "/disclosures/approve", draft)
            paired(path + "/disclosures?grantId=" + scope["grantId"])
            material = api(evidence_path + "/disclosures", scope)["disclosure"]
            assert material == draft
            assert material["evidence"]["values"] == {"dueAmount": bill["payload"]["calculation"]["dueAmount"]}
            assert api(evidence_path + "/disclosures", scope)["disclosure"] == material
            assert api(read_path)["disclosure"] == material
            assert len(api(evidence_path + "/disclosures")["data"]) == index + 1
            result = {"grantId": scope["grantId"], "oneSided": one_sided}
            if index == 0:
                old_pid = server.pid
                os.killpg(old_pid, signal.SIGKILL)
                assert server.wait(timeout=15) == -signal.SIGKILL
                server = start()
                assert server.pid != old_pid
                assert api(read_path)["disclosure"] == material
                result["restart"] = {"oldPid": old_pid, "newPid": server.pid}
                provider_gateway(False)
                try:
                    result["offline"] = denied(lambda: api(read_path))
                finally:
                    provider_gateway(True)
                assert api(read_path)["disclosure"] == material
            revoke(path + "/disclosures/" + scope["grantId"] + "/revoke", {})
            result["revoked"] = denied(lambda: api(read_path))
            result["reimportRevoked"] = denied(lambda: api(evidence_path + "/disclosures", scope))
            outcomes.append(result)
        api(evidence_path + "/close", {})
        run(["bun", "--no-env-file", "scripts/federation-live/disclosure.ts", "inspect"],
            {**settings, "LAB_EVIDENCE": str(logs / "recipient-disclosure-originals.json")})
        inspect_ledgers("disclosure-after")
        for name in ("source", "provider"):
            after = json.loads((logs / (name + "-disclosure-after.json")).read_text())
            for key in ("budgets", "reservations", "outbound", "bills", "settlements", "adjustments", "payments", "execution", "commercial", "commercialTransactions"):
                assert after[key] == before[name][key], "Disclosure changed original " + key
            assert after["disputes"][0]["state"] == "DISPUTED"
        (logs / "three-server-disclosure.json").write_text(json.dumps({"outcomes": outcomes, "field": "dueAmount", "independentDatabases": 3, "recipientCommercialStateEmpty": True}, indent=2) + "\n")
        print("REAL THREE-SERVER DISCLOSURE PASSED: actual bill field over mTLS, four original signatures, R SIGKILL recovery, offline cache refused, A/B independent revocation, original finances unchanged", flush=True)
    finally:
        if server and server.poll() is None:
            os.killpg(server.pid, signal.SIGTERM)
            try:
                server.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL)
                server.wait(timeout=15)
        handle.close()

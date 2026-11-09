"""Production human approval, durable workers, three private receipts and offline withdrawal."""

import hashlib
import base64
import json
import pathlib
import subprocess
import time
import urllib.error
import uuid


def verify_cases(root, logs, env, source, provider, read_material, scope, material, orderer, restart):
    assert orderer and restart
    repo = pathlib.Path(__file__).resolve().parents[2]
    trust = json.loads(pathlib.Path(env["FEDERATION_CASE_TRUST_FILE"]).read_text())
    domain = next(value for value in trust["domains"] if value["commercialDomainId"] == scope["domainId"])
    path = "federation/case-publications/" + scope["agreementRevisionId"]

    def command(action, label, extra=None):
        output = logs / ("case-" + label + ".json")
        with (logs / "case-probe.log").open("a") as handle:
            subprocess.run(["bun", "--no-env-file", "scripts/federation-live/cases.ts", action], cwd=repo,
                           env={**env, "LAB_EVIDENCE": str(output), **(extra or {})},
                           stdout=handle, stderr=handle, timeout=40, check=True)
        return json.loads(output.read_text())

    def snapshot(label):
        return command("snapshot", label)

    def receipts(record_id, record_type, digest):
        expected = {"receipt": {"recordId": record_id, "digest": digest}}
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            values = command("receipts", record_type, {"LAB_CASE_QUERY": json.dumps({
                "domainId": domain["domainId"], "recordId": record_id, "recordType": record_type})})
            if values == [expected] * 3:
                return
            for value in values:
                assert value == expected or value == {"receipt": None} or value in (
                    {"waiting": "DATA_WAITING"}, {"waiting": "LEDGER_UNAVAILABLE"}), "Private receipt mismatch"
            time.sleep(2)
        raise AssertionError("All three members must have the exact private receipt")

    def paired(publication_id):
        deadline = time.monotonic() + 100
        while time.monotonic() < deadline:
            values = [read(path + "?publicationId=" + publication_id)["data"] for read in (source, provider)]
            if all(len(rows) == 1 and rows[0]["counterpartyJws"] for rows in values):
                a, b = (rows[0] for rows in values)
                assert a["approvalJws"] == b["counterpartyJws"] and b["approvalJws"] == a["counterpartyJws"]
                return a, b
            time.sleep(1)
        raise AssertionError("Independent case approvals did not exchange")

    def committed(publication_id, operation, readers):
        deadline = time.monotonic() + 210
        retried = set()
        while time.monotonic() < deadline:
            all_done = True
            for read in readers:
                rows = [row for row in read(path + "/ledger")["data"]
                        if row["publicationId"] == publication_id and row["operation"] == operation]
                if not rows or rows[0]["state"] != "committed":
                    all_done = False
                if rows and rows[0]["state"] == "needs_review":
                    row = rows[0]
                    state = snapshot("review")
                    attempts = [a for db in state for a in db["attempts"] if a["submissionId"] == row["id"]]
                    latest = max(attempts, key=lambda a: a["number"])
                    # Both approved platforms may race to write the same immutable fact.
                    assert latest["stage"] == "invalid" and latest["validationCode"] == 11, row
                    assert row["id"] not in retried, "Repeated MVCC conflict requires review"
                    retried.add(row["id"])
                    read(path + "/" + publication_id + "/ledger/" + row["id"] + "/retry", {})
            if all_done:
                return
            time.sleep(2)
        raise AssertionError("Case ledger did not reach matching private receipts")

    publication = source(path + "/draft", {
        "publicationId": str(uuid.uuid4()), "caseDomainId": domain["domainId"],
        "grantId": scope["grantId"], "validUntil": material["grant"]["validUntil"],
    })
    publication_id = publication["publicationId"]
    stopped = False
    try:
        orderer("stop")
        stopped = True
        source(path + "/approve", publication)
        provider(path + "/approve", publication)
        originals = paired(publication_id)
        print("CASE: both original approvals exchanged while Orderer is offline", flush=True)
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            pending = snapshot("pending")
            if all(any(a["dispatchAuthorizedAt"] and a["stage"] == "transaction" for a in row["attempts"]) for row in pending[:2]):
                break
            time.sleep(2)
        else:
            raise AssertionError("Case transactions did not persist authorization during outage")
        assert not pending[2]["publications"] and not pending[2]["submissions"], "R must not approve for A/B"
        assert all(row["submissions"][0]["state"] == "pending" for row in pending[:2])
        print("CASE: both original transaction authorizations persisted during outage; restarting owned processes", flush=True)
        recovery = restart()
        restarted = snapshot("restarted")
        for before, after in zip(pending[:2], restarted[:2]):
            assert after["publications"] == before["publications"]
            for original in before["attempts"]:
                saved = next(a for a in after["attempts"] if a["id"] == original["id"])
                for key in ("transactionId", "recovery", "dispatchAuthorizedAt"):
                    assert saved[key] == original[key], "Recovery changed original " + key
        orderer("start")
        stopped = False
        committed(publication_id, "record-case-evidence", (source, provider))
        receipts(publication_id, "case-evidence", originals[0]["digest"])
        print("CASE: A/B/R private evidence receipts match", flush=True)
        finished = snapshot("committed")
        for before, after in zip(pending[:2], finished[:2]):
            for original in before["attempts"]:
                saved = next(a for a in after["attempts"] if a["id"] == original["id"])
                assert saved["transactionId"] == original["transactionId"] and saved["stage"] in ("committed", "invalid")

        orderer("stop")
        stopped = True
        revoked = source(path + "/" + publication_id + "/revoke", {})
        deadline = time.monotonic() + 100
        while time.monotonic() < deadline:
            delivery = source(path + "/" + publication_id + "/revocations")
            if len(delivery["sent"]) == 2 and all(row["state"] == "received" for row in delivery["sent"]): break
            time.sleep(1)
        else:
            raise AssertionError("Off-chain withdrawal must reach B and R without Orderer")
        try:
            provider(path + "/approve", publication)
        except urllib.error.HTTPError as error:
            assert error.code == 409 and json.load(error)["error"]["code"] == "AUTHORIZATION_EXPIRED"
        else:
            raise AssertionError("Received withdrawal must prevent approval replay")
        print("CASE: withdrawal reached B/R before chain confirmation", flush=True)
        assert read_material()["disclosure"] == material, "Publication withdrawal must not revoke independent read permission"
        offline = snapshot("withdrawal-offline")
        assert len(offline[1]["notices"]) == len(offline[2]["notices"]) == 1
        assert all(row["state"] != "committed" for row in offline[0]["submissions"] if row["operation"] == "revoke-case-publication")
        orderer("start")
        stopped = False
        committed(publication_id, "revoke-case-publication", (source,))
        payload = revoked["revocationJws"].split(".")[1]
        digest = "sha256:" + hashlib.sha256(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).hexdigest()
        receipts(revoked["revocationPayload"]["revocationId"], "case-revocation", digest)
        receipts(publication_id, "case-evidence", originals[0]["digest"])
        (logs / "three-server-cases.json").write_text(json.dumps({"independentServers": 3, "independentDatabases": 3,
            "recovery": recovery, "bothDispatchedBeforeRestart": True, "outageWithdrawalRecipients": 2, "privateReceiptMembers": 3,
            "originalEvidencePreserved": True, "independentReadPermissionPreserved": True}, indent=2))
        print("REAL THREE-SERVER CASES PASSED: independent human approvals, automatic mTLS signature exchange, persisted original transactions across Orderer outage and Server/Adapter SIGKILL, A/B/R private receipts, off-chain withdrawal before chain confirmation", flush=True)
    finally:
        if stopped: orderer("start")

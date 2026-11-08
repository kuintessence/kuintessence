"""Real dual-platform media transport, publication and source revocation; no compute claim."""
import hashlib
import json
import subprocess
import time
import uuid


def verify_media_accounting(logs):
    for party in ("source", "provider"):
        before = json.loads((logs / (party + "-before.json")).read_text())
        after = json.loads((logs / (party + "-after.json")).read_text())
        assert after["budgets"] == before["budgets"], "Data sharing changed compute balances"
        if party == "source":
            assert not after["budgets"], "Source copied a recipient compute budget"
        for key in ("execution", "bindings", "reservations", "outbound", "bills", "settlements"):
            assert not after[key], "Media-only scenario created " + key


def verify_media(root, logs, namespace, target_env, source_env, target_api, source_api):
    config = json.loads((root / "source-init.json").read_text())

    def fixture(setting, command):
        with (logs / "media-fixture.log").open("a") as output:
            subprocess.run(["bun", "--no-env-file", "scripts/federation-live/media.ts", command],
                           env=setting, check=True, stdout=output, stderr=output, timeout=30)

    def command(pod, argv, data=None):
        return subprocess.run(["kubectl", "exec", "-i", "-n", namespace, pod, "--", *argv],
                              input=data, capture_output=True, check=True, timeout=30).stdout

    def wait(read, predicate, label, timeout=120):
        deadline = time.monotonic() + timeout
        while True:
            value = read()
            assert value.get("state") != "failed", label + ": operation failed"
            if predicate(value):
                return value
            assert time.monotonic() < deadline, label
            time.sleep(2)

    fixture(target_env, "target")
    fixture(source_env, "source")
    dataset = json.loads((root / "media-source.json").read_text())
    command("result-copy-agent", ["bash", "-c", "set -eu; umask 077; mkdir -p /var/lib/kuintessence/datasets/v1; printf data > /var/lib/kuintessence/datasets/v1/input.dat"])
    package_id, authorization_id, policy_id = (str(uuid.uuid4()) for _ in range(3))
    approved = source_api("federation/media/exports", {
        "packageId": package_id, "agreementRevisionId": config["terms"]["agreementRevisionId"],
        "recipientSiteId": config["target"]["siteId"], "versionId": dataset["versionId"],
        "locationId": dataset["locationId"], "expiresAt": config["terms"]["validUntil"],
    })["data"]
    source_api("federation/media/exports/" + package_id + "/run", {})
    exported = wait(lambda: source_api("federation/media/exports/" + package_id + "/operation")["data"],
                    lambda row: row["state"] == "exported", "Source Agent did not finish encrypted export")
    package_path = "/var/lib/kuintessence/media/outbox/" + package_id + "/bundle.age"
    encrypted = command("result-copy-agent", ["cat", package_path])
    assert encrypted.startswith(b"age-encryption.org/v1\n")
    inbox = "/var/lib/kuintessence/media/inbox/" + package_id
    command("scheduler", ["bash", "-c", 'set -eu; umask 077; mkdir -p "$1"; cat > "$1/bundle.age"', "media-copy", inbox], encrypted)
    assert hashlib.sha256(command("scheduler", ["cat", inbox + "/bundle.age"])).digest() == hashlib.sha256(encrypted).digest()
    target_api("federation/media/packages", {
        "senderSiteId": config["source"]["siteId"], "signedManifest": approved["signedManifest"],
    })
    package_route = "federation/media/packages/" + package_id
    target_api(package_route + "/import-authorizations", {
        "authorizationId": authorization_id, "agentId": target_env["LAB_AGENT"],
        "managedRootId": target_env["LAB_MEDIA_ROOT_ID"], "maxBytes": 4,
        "expiresAt": config["terms"]["validUntil"],
    })
    import_route = package_route + "/import-authorizations/" + authorization_id
    initial = target_api(import_route + "/run", {})["data"]
    imported = wait(lambda: target_api(import_route + "/operation")["data"],
                    lambda row: row["state"] == "verified", "Target Agent did not verify the encrypted package")
    assert imported["generation"] == initial["generation"] and imported["verifiedBytes"] == 4
    assert target_api("federation/media/datasets")["data"] == [], "Import implicitly published a dataset"
    private_path = "/var/lib/kuintessence/datasets/.federation-media/" + package_id + "/files/input.dat"
    assert command("scheduler", ["cat", private_path]) == b"data"
    receipt = wait(lambda: target_api(import_route + "/receipt")["data"],
                   lambda row: row["state"] == "recorded", "Signed import receipt was not acknowledged")
    source_api("federation/media/dataset-use-policies", {
        "policyId": policy_id, "versionId": dataset["versionId"],
        "recipientSiteId": config["target"]["siteId"],
        "agreementRevisionId": config["terms"]["agreementRevisionId"],
        "expiresAt": config["terms"]["validUntil"], "reason": "Isolated cross-platform media acceptance",
    })
    publication = {"replicaId": str(uuid.uuid4()), "authorizationId": authorization_id,
                   "sourcePolicyId": policy_id, "name": "Partner observations"}
    published = target_api(package_route + "/datasets", publication)["data"]
    replay = target_api(package_route + "/datasets", publication)["data"]
    for field in ("replicaId", "assetId", "versionId", "locationId", "authorizationId", "sourcePolicyId", "publishedAt"):
        assert replay[field] == published[field]
    assert len(target_api("federation/media/datasets")["data"]) == 1
    fixture(target_env, "inspect")
    before = json.loads((root / "media-authority.json").read_text())
    assert before["allowed"] and before["jobs"] == 0
    assert before["entries"] == [{"sha256": dataset["sha256"], "sizeBytes": 4, "metadata": dataset["metadata"]}]
    assert approved["manifest"]["files"][0]["sha256"] == dataset["sha256"]
    assert approved["manifest"]["files"][0]["license"] == dataset["metadata"]["license"]
    assert approved["manifest"]["files"][0]["provenance"] == dataset["metadata"]["provenance"]
    source_api("federation/media/dataset-use-policies/" + policy_id + "/revoke", {"reason": "Source withdrew use permission"})

    def authority():
        fixture(target_env, "inspect")
        return json.loads((root / "media-authority.json").read_text())

    revoked = wait(authority, lambda row: not row["allowed"] and row["lastError"] is not None,
                   "Source revocation did not invalidate receiver authority")
    assert revoked["jobs"] == 0
    assert command("scheduler", ["cat", private_path]) == b"data", "Use revocation erased imported evidence"
    assert target_api(import_route + "/receipt")["data"]["state"] == "recorded"
    (logs / "media-evidence.json").write_text(json.dumps({
        "packageId": package_id, "ciphertextSha256": hashlib.sha256(encrypted).hexdigest(),
        "fileSha256": dataset["sha256"], "exportState": exported["state"],
        "importState": imported["state"], "receiptState": receipt["state"],
        "beforeRevocation": before, "afterRevocation": revoked, "replicaId": published["replicaId"],
    }, indent=2) + "\n")
    print("REAL MEDIA PASSED: two Server databases and mTLS Agents; encrypted export/import, signed receipt, separate publication, source revocation; no compute claim", flush=True)

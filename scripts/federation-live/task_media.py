"""Private Workflow File -> encrypted media -> real Jobs -> media result -> downstream File."""
import hashlib
import json
import ssl
import subprocess
import time
import urllib.request
import uuid


def verify_task_media(root, logs, namespace, target_env, source_env, target_api, source_api, target_cli_config, source_cli_config):
    config = json.loads((root / "source-init.json").read_text())
    tls = ssl.create_default_context(cafile=str(root / "ca/ca.crt"))

    cli_profiles = {}
    for setting, profile, actor_file in ((target_env, target_cli_config, "registration.json"),
                                        (source_env, source_cli_config, "source-actor.json")):
        path = root / ("cli-" + setting["FEDERATION_SITE_ID"] + ".json")
        path.write_text(json.dumps(profile))
        path.chmod(0o600)
        cli_profiles[setting["FEDERATION_SITE_ID"]] = (str(path), json.loads((root / actor_file).read_text())["orgId"])

    def cli(setting, args, body=None):
        profile, org = cli_profiles[setting["FEDERATION_SITE_ID"]]
        input_path = root / ("cli-input-" + str(uuid.uuid4()) + ".json")
        if body is not None:
            input_path.write_text(json.dumps(body))
            input_path.chmod(0o600)
        try:
            command = ["bun", "--no-env-file", "packages/cli/src/index.ts", "federation", "--org", org, "--lang", "en", "--json", "media", *args]
            if body is not None:
                command.append(str(input_path))
            result = subprocess.run(command, env={**setting, "KQ_CONFIG_FILE": profile}, capture_output=True, timeout=40)
            assert result.returncode == 0, "Media CLI failed: " + result.stderr.decode()[-2000:]
            return json.loads(result.stdout)
        finally:
            input_path.unlink(missing_ok=True)

    def fixture(setting, command):
        with (logs / "task-media-fixture.log").open("a") as output:
            subprocess.run(["bun", "--no-env-file", "scripts/federation-live/task-media.ts", command],
                           env=setting, check=True, stdout=output, stderr=output, timeout=30)

    def inspect(setting):
        fixture(setting, "inspect")
        return json.loads((root / "task-media-state.json").read_text())

    def wait(read, predicate, label, timeout=180):
        deadline = time.monotonic() + timeout
        while True:
            value = read()
            assert value.get("state") != "failed", label + ": " + json.dumps(value)
            assert not any(r["status"] in ("failed", "cancelled") for r in value.get("runs", [])), label + ": " + json.dumps(value)
            if predicate(value):
                return value
            assert time.monotonic() < deadline, label + ": " + json.dumps(value)
            time.sleep(2)

    def command(pod, argv, data=None):
        return subprocess.run(["kubectl", "exec", "-i", "-n", namespace, pod, "--", *argv],
                              input=data, capture_output=True, check=True, timeout=30).stdout

    fixture(target_env, "setup-target")
    fixture(source_env, "setup-source")
    data = b"6\n"
    digest = hashlib.sha256(data).hexdigest()
    minted = source_api("netdrive/upload-url", {"path": "private/value.dat", "size": len(data)})["data"]
    request = urllib.request.Request(minted["uploadUrl"], data=data, method="PUT",
                                     headers={"Content-Type": "application/octet-stream"})
    with urllib.request.urlopen(request, context=tls, timeout=30) as response:
        assert response.status == 200
    file = source_api("netdrive/files", {"path": "private/value.dat", "size": len(data),
        "contentType": "application/octet-stream", "sha256": digest,
        "storageKey": minted["storageKey"], "commitToken": minted["commitToken"]})["data"]
    request = config["request"]
    workflow = {
        "name": "Private task media round trip",
        "parameters": [{"name": "file", "type": "json", "required": True,
                        "default": {"fileMetadataId": file["id"], "fileMetadataName": "private/value.dat"}}],
        "spec": {"nodeDrafts": [
            {"id": "remote", "name": "Partner calculation", "type": "Federation",
             **{key: request[key] for key in ("agreementRevisionId", "template", "inputManifestDigest", "environmentLockDigest", "resources", "maxAmount", "executionExpiresAt")},
             "admissionWindowSec": 1200, "inputDelivery": "media", "resultDelivery": "media",
             "inputSlots": [{"descriptor": "value", "type": "File", "from": {"param": "file"}, "expectedFileName": "value.dat"}],
             "outputs": [{"descriptor": "result", "type": "File", "from": {"nodeId": "consumer", "descriptor": "result"}}]},
            {"id": "consume", "name": "Receive verified result", "type": "NoAction",
             "inputSlots": [{"descriptor": "input", "type": "File", "from": {"node": "remote", "output": "result"}}]},
        ], "nodeRelations": [{"fromId": "remote", "toId": "consume", "slotRelations": []}]},
    }
    run_id = source_api("workflows", {"yaml": json.dumps(workflow)})["runId"]
    source = wait(lambda: inspect(source_env), lambda s: len(s["outbound"]) == 1 and s["outbound"][0]["state"] == "accepted", "Normal Workflow did not delegate")
    operation = source["outbound"][0]["operationId"]
    waiting = wait(lambda: inspect(target_env), lambda s: any(p["blocker"] == "DATA_WAITING" for p in s["preparations"]) and len(s["inputs"]) == 1,
                   "Private input did not enter DATA_WAITING")
    assert not waiting["runs"] and not waiting["jobs"] and not waiting["files"] and not waiting["inputAttempts"]
    assert waiting["inputs"][0]["delivery"] == "media" and waiting["inputs"][0]["reservedBytes"] == len(data)
    (logs / "task-media-waiting.json").write_text(json.dumps(waiting, indent=2) + "\n")
    print("PRIVATE INPUT WAITING: ordinary Workflow accepted; no target job/file before physical delivery", flush=True)

    def deliver(kind, receiver, sender_env, receiver_env, sender_pod, receiver_pod, sender_site, recipient_site, size):
        package_id, authorization_id = str(uuid.uuid4()), str(uuid.uuid4())
        approved = cli(sender_env, ["exports", "approve"], {
            "packageId": package_id, "agreementRevisionId": request["agreementRevisionId"],
            "recipientSiteId": recipient_site, "kind": kind, "operationId": operation,
            "agentId": sender_env["LAB_AGENT"], "expiresAt": request["executionExpiresAt"],
        })
        cli(sender_env, ["exports", "run", package_id])
        exported = wait(lambda: cli(sender_env, ["exports", "status", package_id]),
                        lambda row: row["state"] == "exported", kind + " export")
        ciphertext = command(sender_pod, ["cat", "/var/lib/kuintessence/media/outbox/" + package_id + "/bundle.age"])
        assert ciphertext.startswith(b"age-encryption.org/v1\n")
        inbox = "/var/lib/kuintessence/media/inbox/" + package_id
        command(receiver_pod, ["bash", "-c", 'set -eu; umask 077; mkdir -p "$1"; cat > "$1/bundle.age"', "media-copy", inbox], ciphertext)
        assert hashlib.sha256(command(receiver_pod, ["cat", inbox + "/bundle.age"])).digest() == hashlib.sha256(ciphertext).digest()
        registration = root / (package_id + "-registration.json")
        cli(sender_env, ["exports", "manifest", package_id, str(registration)])
        assert json.loads(registration.read_text()) == {"senderSiteId": sender_site, "signedManifest": approved["signedManifest"]}
        cli(receiver_env, ["imports", "register", str(registration)])
        cli(receiver_env, ["imports", "approve", package_id], {"authorizationId": authorization_id, "agentId": receiver_env["LAB_AGENT"],
                        "managedRootId": receiver_env["LAB_MEDIA_ROOT_ID"], "maxBytes": size,
                        "expiresAt": request["executionExpiresAt"]})
        initial = cli(receiver_env, ["imports", "run", package_id, authorization_id])
        imported = wait(lambda: cli(receiver_env, ["imports", "status", package_id, authorization_id]), lambda row: row["state"] == "verified", kind + " private verification")
        assert imported["generation"] == initial["generation"] and imported["verifiedBytes"] == size
        receipt = wait(lambda: cli(receiver_env, ["imports", "receipt", package_id, authorization_id]), lambda row: row["state"] == "recorded", kind + " import receipt")
        assert receiver("federation/media/datasets")["data"] == [], "Private task leaked into dataset catalog"
        print(kind + " PHYSICALLY DELIVERED: actual age bytes, private verification and signed receipt", flush=True)
        return {"packageId": package_id, "authorizationId": authorization_id, "generation": imported["generation"],
                "ciphertextSha256": hashlib.sha256(ciphertext).hexdigest(), "manifest": approved["manifest"],
                "exportState": exported["state"], "receiptState": receipt["state"]}

    input_evidence = deliver("task-input", target_api, source_env, target_env,
                             "result-copy-agent", "scheduler", config["source"]["siteId"], config["target"]["siteId"], len(data))
    target = wait(lambda: inspect(target_env), lambda s: len(s["runs"]) == 1 and s["runs"][0]["status"] == "completed", "Imported input did not resume real workflow", 240)
    assert len(target["jobs"]) == 2 and all(j["status"] == "completed" and j["schedulerJobId"] for j in target["jobs"])
    assert sorted(f["size"] for f in target["files"]) == [2, 3, 12]
    assert sorted(f["sha256"] for f in target["files"]) == sorted(hashlib.sha256(b).hexdigest() for b in (data, b"42\n", b"verified:42\n"))
    for job in target["jobs"]:
        output = subprocess.check_output(["kubectl", "logs", "-n", namespace, "job/" + job["schedulerJobId"]], timeout=30)
        assert b"federation-file-" in output
        (logs / (job["schedulerJobId"] + ".log")).write_bytes(output)
    source = wait(lambda: inspect(source_env), lambda s: len(s["results"]) == 1, "Original Workflow did not request media result")
    assert source["results"][0]["delivery"] == "media" and source["results"][0]["reservedBytes"] == 12
    assert not source["resultAttempts"] and len(source["files"]) == 1
    print("PRIVATE INPUT EXECUTED: two real Kubernetes Jobs; source waits for media result", flush=True)
    result_evidence = deliver("task-result", source_api, target_env, source_env,
                              "scheduler", "result-copy-agent", config["target"]["siteId"], config["source"]["siteId"], 12)
    parent = wait(lambda: source_api("workflows/" + run_id), lambda s: s["status"] == "completed", "Source workflow did not resume after result delivery")
    assert parent["result"]["status"] == {"remote": "Succeeded", "consume": "Succeeded"}
    assert parent["waitingInvocations"] == []
    source = wait(lambda: inspect(source_env), lambda s: s["results"][0]["receiptAck"] is not None, "Original result receipt not acknowledged")
    assert len(source["outbound"]) == 1 and len(source["runs"]) == 1
    assert target["inputs"][0]["reservationId"] == source["outbound"][0]["receipt"]["reservationId"]
    for state, direction, evidence in ((target, "input", input_evidence), (source, "result", result_evidence)):
        imports = state["inputs" if direction == "input" else "results"]
        assert len(imports) == 1 and imports[0]["state"] == "available" and imports[0]["reservedBytes"] == 0
        assert len(state["claims"]) == 1
        claim = state["claims"][0]
        assert claim[direction + "Id"] == imports[0]["id"] and claim["authorizationId"] == evidence["authorizationId"]
        assert claim["generation"] == evidence["generation"]
        attempts = state[direction + "Attempts"]
        assert len(attempts) == 1 and attempts[0]["claimId"] == claim["id"], "Network attempt or duplicate generation"
        assert attempts[0]["verifiedAt"] and attempts[0]["versionId"] not in (None, "", "null")
    result_file = parent["result"]["values"]["remote"]["values"]["result"]["fileMetadataId"]
    grant = source_api("netdrive/files/" + result_file + "/download-url")["data"]
    with urllib.request.urlopen(grant["downloadUrl"], context=tls, timeout=30) as response:
        assert response.read(1024) == b"verified:42\n"
    (logs / "task-media-evidence.json").write_text(json.dumps({"runId": run_id, "input": input_evidence,
        "result": result_evidence, "target": target, "source": source, "workflowStatus": parent["result"]["status"]}, indent=2) + "\n")
    print("REAL TASK MEDIA PASSED: private File -> age media -> automatic upload/version verification -> two Jobs -> result media -> original downstream; real CLI/HTTP, original claims and zero reserved bytes", flush=True)

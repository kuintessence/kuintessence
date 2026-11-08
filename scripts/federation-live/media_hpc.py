"""Disposable Slurm target for the dual-platform media experiment."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess


def prepare_runtime(root, runtime_dir, log):
    runtime = Path(runtime_dir).resolve(strict=True)
    for name, expected in {
        "apptainer.deb": "c3c05120baab7ece2e81d40c1d1be63cc3fd1f5a25f379a4f2b2f99a0f6a1100",
        "apptainer-suid.deb": "5b9308c9bc643d8c8bc62fe545e29a23f6b8deea8d11782e4000bc6d621a2480",
    }.items():
        assert hashlib.sha256((runtime / name).read_bytes()).hexdigest() == expected, name
    destination = root / "hpc"
    destination.mkdir(mode=0o700)
    subprocess.run(["dpkg-deb", "-x", str(runtime / "apptainer.deb"), str(destination / "tools")],
                   check=True, stdout=log, stderr=log, timeout=30)
    binary = str(destination / "tools/usr/bin/apptainer")
    # Public and private keyrings stay in this disposable directory, never the host user's home.
    env = {key: value for key, value in os.environ.items() if key in ("PATH", "HOME")}
    env["APPTAINER_KEYSDIR"] = str(destination / "keys")

    def command(args, stdin=""):
        result = subprocess.run([binary, "--config", str(destination / "tools/etc/apptainer/apptainer.conf"), *args], input=stdin, env=env, text=True,
                                capture_output=True, timeout=30)
        log.write(result.stdout + result.stderr)
        log.flush()
        result.check_returncode()
        return result

    command(["key", "newpair", "--bit-length", "2048", "--name", "KQ isolated media lab",
             "--email", "lab@test.invalid", "--comment", "Disposable acceptance",
             "--password=", "--push=false"])
    shutil.copyfile(runtime / "bash.sif", destination / "bash.sif")
    command(["sign", "--keyidx", "0", str(destination / "bash.sif")])
    verified = command(["verify", "--local", str(destination / "bash.sif")])
    import re
    fingerprint = re.search(r"Fingerprint:\s*([A-F0-9]{40})", verified.stdout)
    assert fingerprint, "Local SIF verification did not identify the signing key"
    command(["key", "export", str(destination / "public.asc")], "0\n")
    # The Agent only receives the public key; execution never needs the signing keyring.
    shutil.rmtree(destination / "keys")
    shutil.rmtree(destination / "tools")
    (destination / "bash.sif").chmod(0o444)
    metadata = {"digest": "sha256:" + hashlib.sha256((destination / "bash.sif").read_bytes()).hexdigest(),
                "fingerprint": fingerprint[1], "resourceLimitScope": "disposable-pod"}
    (destination / "runtime.json").write_text(json.dumps(metadata))
    return runtime, metadata


def configure_target(pod, root, runtime, metadata):
    container = pod["spec"]["containers"][0]
    pod["spec"]["automountServiceAccountToken"] = False
    pod["spec"]["activeDeadlineSeconds"] = 1200
    container["securityContext"] = {"privileged": True}
    container["resources"]["limits"] = {"cpu": "1", "memory": "1Gi"}
    pod["spec"]["volumes"].append({"name": "hpc-runtime", "hostPath": {"path": str(runtime), "type": "Directory"}})
    container["volumeMounts"].append({"name": "hpc-runtime", "mountPath": "/lab-runtime", "readOnly": True})
    setting = {entry["name"]: entry["value"] for entry in container["env"]}
    for key in list(setting):
        if key.startswith("AGENT_SANDBOX_K8S_"):
            del setting[key]
    setting.update(AGENT_SCHEDULER="slurm", AGENT_SANDBOX_ROOT="/scratch/media-sandbox",
                   AGENT_SANDBOX_ROOT_IMPERSONATION="true", AGENT_SANDBOX_SIF_SIGNATURE_VERIFICATION="true",
                   AGENT_SANDBOX_ECL="true", AGENT_RESTRICTED_DATA_ISOLATION="true",
                   AGENT_RESTRICTED_EXECUTION_PROFILE_ID="ca12ed00-4f54-4000-8000-000000000001",
                   AGENT_RESTRICTED_EXECUTION_SIF_DIGEST=metadata["digest"],
                   AGENT_SANDBOX_RUNTIME_CACHE_JSON=json.dumps({metadata["digest"]: {
                       "kind": "SIF", "localPath": "/opt/kq/bash.sif", "signatureVerified": True}}),
                   APPTAINER_KEYSDIR="/opt/kq/keys", LAB_HPC_ROOT=str(root / "hpc"))
    container["env"] = [{"name": key, "value": value} for key, value in setting.items()]
    container["command"] = ["bash", "/workspace/scripts/federation-live/media-hpc-bootstrap.sh"]

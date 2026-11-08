#!/usr/bin/env python3
"""Opt-in, single-host Slurm/Apptainer/media acceptance; no production configuration."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import uuid

assert os.environ.get("KQ_MEDIA_SLURM_LAB") == "1", "Set KQ_MEDIA_SLURM_LAB=1"
case = os.environ.get("KQ_MEDIA_SLURM_CASE", "")
assert case in ("", "complete", "stop", "agent-crash"), "Unknown lab case"
repo = Path(__file__).resolve().parent.parent
runtime = Path(os.environ["KQ_MEDIA_RUNTIME_DIR"]).resolve(strict=True)
age = Path(os.environ["KQ_MEDIA_AGE_BIN"]).resolve(strict=True)
image = "ghcr.io/kuintessence/kq-dev-scheduler@sha256:9436d1c2a6875f53f42e8adc7c3a13068a4903a99920c06ff1201af0fd759e0d"
# Official Apptainer 1.4.3 GitHub release asset digests (amd64).
for name, digest in {
    "apptainer.deb": "c3c05120baab7ece2e81d40c1d1be63cc3fd1f5a25f379a4f2b2f99a0f6a1100",
    "apptainer-suid.deb": "5b9308c9bc643d8c8bc62fe545e29a23f6b8deea8d11782e4000bc6d621a2480",
}.items():
    assert hashlib.sha256((runtime / name).read_bytes()).hexdigest() == digest, name
assert (runtime / "bash.sif").is_file(), "Provide a minimal SIF with bash, cat and sleep"
assert (age / "age").is_file() and (age / "age-keygen").is_file()
namespace = "kq-media-slurm-" + uuid.uuid4().hex[:8]
output = repo / "temp" / namespace
output.mkdir(parents=True, mode=0o700)
created = False


def kubectl(args, data=None, check=True, timeout=45):
    result = subprocess.run(["kubectl", *args], input=data, text=True,
                            capture_output=True, timeout=timeout)
    if check and result.returncode:
        (output / "failure.log").write_text(result.stdout + result.stderr)
        raise RuntimeError(f"Lab command failed; inspect {output}/failure.log")
    return result


def run(args, **kwargs):
    return kubectl(["exec", "-i", "-n", namespace, "scheduler", "--", *args], **kwargs)


def terminate(_signal, _frame):
    raise KeyboardInterrupt


signal.signal(signal.SIGTERM, terminate)
try:
    kubectl(["create", "namespace", namespace])
    created = True
    scripts = {
        "start-agent": "deploy/schedulers/common/start-agent.sh",
        "slurm-entrypoint": "deploy/schedulers/slurm/entrypoint.sh",
        "supervisor.py": "deploy/schedulers/common/supervise-agent.py",
    }
    kubectl(["apply", "-f", "-"], json.dumps({
        "apiVersion": "v1", "kind": "ConfigMap",
        "metadata": {"name": "supervisor", "namespace": namespace},
        "data": {name: (repo / path).read_text() for name, path in scripts.items()},
    }))
    env = {
        "KQ_AGENT_REGISTRATION_ENABLED": "0", "AGENT_ID": "media-lab",
        "AGENT_SITE_NAME": "media-lab", "SERVER_GRPC_URL": "http://127.0.0.1:1",
        "AGENT_DB_PATH": "/var/lib/kuintessence/agent.db", "AGENT_SPACK_ENABLED": "false",
        "AGENT_SSH_ENABLED": "false", "LOG_LEVEL": "warn", "NODE_ENV": "development",
    }
    mounts = [
        {"name": "source", "mountPath": "/workspace", "readOnly": True},
        {"name": "runtime", "mountPath": "/lab-runtime", "readOnly": True},
        {"name": "age", "mountPath": "/opt/kq/age", "readOnly": True},
        {"name": "state", "mountPath": "/var/lib/kuintessence"},
    ] + [{"name": "scripts", "mountPath": "/usr/local/bin/" + dest,
          "subPath": source, "readOnly": True} for source, dest in [
              ("start-agent", "kq-start-agent"),
              ("slurm-entrypoint", "kq-slurm-entrypoint"),
              ("supervisor.py", "kq-supervise-agent.py"),
          ]]
    volumes = [{"name": name, "hostPath": {"path": str(path), "type": "Directory"}}
               for name, path in [("source", repo), ("runtime", runtime), ("age", age)]]
    volumes += [{"name": "state", "emptyDir": {}},
                {"name": "scripts", "configMap": {"name": "supervisor", "defaultMode": 0o755}}]
    kubectl(["apply", "-f", "-"], json.dumps({
        "apiVersion": "v1", "kind": "Pod", "metadata": {"name": "scheduler", "namespace": namespace},
        "spec": {
            "restartPolicy": "Never", "automountServiceAccountToken": False,
            "activeDeadlineSeconds": 1200, "terminationGracePeriodSeconds": 20,
            "containers": [{
                "name": "scheduler", "image": image, "imagePullPolicy": "Never",
                # Nested Apptainer namespaces/mounts, confined to this disposable lab Pod.
                "securityContext": {"privileged": True},
                "command": ["/bin/bash", "/usr/local/bin/kq-slurm-entrypoint"],
                "env": [{"name": key, "value": value} for key, value in env.items()],
                "resources": {"requests": {"cpu": "100m", "memory": "256Mi"},
                              "limits": {"cpu": "1", "memory": "1024Mi"}},
                "volumeMounts": mounts,
            }], "volumes": volumes,
        },
    }))
    print(f"Created isolated lab {namespace}", flush=True)
    for attempt in range(60):
        result = run(["sh", "-c", "sinfo -h -o '%T' | grep -Eq 'idle|alloc|mix' && test -f /var/lib/kuintessence/agent.db"], check=False)
        if result.returncode == 0:
            break
        assert attempt < 59, "Slurm/Agent readiness timeout"
        time.sleep(1)
    setup = run(["bash"], data="""set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends liblzo2-2 libfuse3-3
dpkg-deb -x /lab-runtime/apptainer.deb /
dpkg-deb -x /lab-runtime/apptainer-suid.deb /
mkdir -p /opt/kq /etc/kuintessence /usr/libexec/kuintessence
cp /lab-runtime/bash.sif /opt/kq/bash.sif
cp /workspace/packages/agent/scripts/kq-sandbox-wrapper /usr/libexec/kuintessence/kq-sandbox-wrapper
chmod 755 /usr/libexec/kuintessence/kq-sandbox-wrapper
useradd -u 24001 -m scientist
""", timeout=180)
    (output / "setup.log").write_text(setup.stdout + setup.stderr)
    print("Real Slurm ready; testing media input, persisted stop and Agent crash", flush=True)
    probe = run(["env", "KQ_MEDIA_SLURM_LAB=1", "KQ_MEDIA_AGE_TEST_BIN=/opt/kq/age",
                 "KQ_MEDIA_SLURM_CASE=" + case,
                 "bun", "/workspace/scripts/federation-media-slurm-probe.ts"], timeout=150)
    (output / "observations.jsonl").write_text(probe.stdout)
    (output / "probe.log").write_text(probe.stderr)
    (output / "checkout.json").write_text(json.dumps({
        "image": image, "namespace": namespace,
        "sifSha256": hashlib.sha256((runtime / "bash.sif").read_bytes()).hexdigest(),
    }))
    print(probe.stdout, end="", flush=True)
    print(f"PASS; evidence: {output}", flush=True)
finally:
    if created:
        try:
            logs = kubectl(["logs", "-n", namespace, "scheduler", "--tail=30"], check=False)
            (output / "scheduler.log").write_text(logs.stdout + logs.stderr)
        finally:
            kubectl(["delete", "namespace", namespace, "--ignore-not-found", "--wait=false"], check=False)
            print(f"Cleanup requested for {namespace}", flush=True)

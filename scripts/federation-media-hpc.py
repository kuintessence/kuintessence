#!/usr/bin/env python3
"""Opt-in, single-host Slurm/PBS/Apptainer/media acceptance; no production configuration."""
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import time
import uuid

assert os.environ.get("KQ_MEDIA_HPC_LAB") == "1", "Set KQ_MEDIA_HPC_LAB=1"
case = os.environ.get("KQ_MEDIA_HPC_CASE", "")
assert case in ("", "complete", "stop", "agent-crash", "cgroup"), "Unknown lab case"
scheduler = os.environ.get("KQ_MEDIA_SCHEDULER", "slurm")
assert scheduler in ("slurm", "pbs-pro"), "Unsupported scheduler"
assert case != "cgroup" or scheduler == "pbs-pro", "The cgroup hook lab requires PBS"
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
pbs_source_hash = "297ea4d5933e867b51366b213184a5251a41261f16079ffde86511e0bbc6606c"
pbs_commit = "be361a18ef37652bece0811ec709f0fe4fc52710"
pbs = Path(os.environ["KQ_MEDIA_PBS_DIR"]).resolve(strict=True) if scheduler == "pbs-pro" else None
cached_pbs = False
if pbs:
    assert hashlib.sha256((pbs / "openpbs.tar.gz").read_bytes()).hexdigest() == pbs_source_hash
    cached_pbs = (pbs / "pbs-install.tar.gz").is_file()
    if cached_pbs:
        metadata = json.loads((pbs / "pbs-install.json").read_text())
        assert metadata["sourceCommit"] == pbs_commit and metadata["sourceSha256"] == pbs_source_hash
        assert metadata["image"] == image and metadata["version"] == "23.06.06"
        assert hashlib.sha256((pbs / "pbs-install.tar.gz").read_bytes()).hexdigest() == metadata["archiveSha256"]
namespace = f"kq-media-{scheduler}-" + uuid.uuid4().hex[:8]
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
        "scheduler-entrypoint": f"deploy/schedulers/{'pbs' if pbs else 'slurm'}/entrypoint.sh",
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
    if pbs:
        env.update({"PATH": "/opt/pbs/bin:/opt/pbs/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                    "AGENT_SCHEDULER_TYPE": "pbs-pro", "AGENT_SCHEDULER_VERSION": "23.06.06",
                    "AGENT_SANDBOX_ROOT_IMPERSONATION": "true", "AGENT_SANDBOX_EXECUTION_MODE": "root-impersonation"})
    mounts = [
        {"name": "source", "mountPath": "/workspace", "readOnly": True},
        {"name": "runtime", "mountPath": "/lab-runtime", "readOnly": True},
        {"name": "age", "mountPath": "/opt/kq/age", "readOnly": True},
        {"name": "state", "mountPath": "/var/lib/kuintessence"},
    ] + [{"name": "scripts", "mountPath": "/usr/local/bin/" + dest,
          "subPath": source, "readOnly": True} for source, dest in [
              ("start-agent", "kq-start-agent"),
              ("scheduler-entrypoint", "kq-lab-scheduler-entrypoint"),
              ("supervisor.py", "kq-supervise-agent.py"),
          ]]
    volumes = [{"name": name, "hostPath": {"path": str(path), "type": "Directory"}}
               for name, path in [("source", repo), ("runtime", runtime), ("age", age)]]
    if pbs:
        volumes.append({"name": "pbs", "hostPath": {"path": str(pbs), "type": "Directory"}})
        mounts.append({"name": "pbs", "mountPath": "/lab-pbs", "readOnly": True})
    volumes += [{"name": "state", "emptyDir": {}},
                {"name": "scripts", "configMap": {"name": "supervisor", "defaultMode": 0o755}}]
    kubectl(["apply", "-f", "-"], json.dumps({
        "apiVersion": "v1", "kind": "Pod", "metadata": {"name": "scheduler", "namespace": namespace},
        "spec": {
            "restartPolicy": "Never", "automountServiceAccountToken": False,
            "activeDeadlineSeconds": 3600 if pbs and not cached_pbs else 1200, "terminationGracePeriodSeconds": 20,
            "containers": [{
                "name": "scheduler", "image": image, "imagePullPolicy": "Never",
                # Nested Apptainer namespaces/mounts, confined to this disposable lab Pod.
                "securityContext": {"privileged": True},
                "command": ["sleep", "3600"] if pbs else ["/bin/bash", "/usr/local/bin/kq-lab-scheduler-entrypoint"],
                "env": [{"name": key, "value": value} for key, value in env.items()],
                "resources": {"requests": {"cpu": "100m", "memory": "256Mi"},
                              "limits": {"cpu": "2" if pbs else "1", "memory": "2Gi" if pbs else "1Gi"}},
                "volumeMounts": mounts,
            }], "volumes": volumes,
        },
    }))
    print(f"Created isolated lab {namespace}", flush=True)
    for attempt in range(60):
        result = run(["true"] if pbs else ["sh", "-c", "sinfo -h -o '%T' | grep -Eq 'idle|alloc|mix' && test -f /var/lib/kuintessence/agent.db"], check=False)
        if result.returncode == 0:
            break
        assert attempt < 59, "Scheduler Pod readiness timeout"
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
cp /workspace/packages/agent/scripts/kq-sandbox-cgroup-check /usr/libexec/kuintessence/kq-sandbox-cgroup-check
chmod 755 /usr/libexec/kuintessence/kq-sandbox-cgroup-check
useradd -u 24001 -m scientist
""", timeout=180)
    (output / "setup.log").write_text(setup.stdout + setup.stderr)
    if pbs:
        install = run(["bash"], data="set -eu\nexport DEBIAN_FRONTEND=noninteractive\napt-get install -y --no-install-recommends postgresql postgresql-contrib libical3 libedit2 libpython3.8 libhwloc15 libtcl8.6 libtk8.6\n" + (
            "tar xzf /lab-pbs/pbs-install.tar.gz -C /opt\n" if cached_pbs else
            "KQ_MEDIA_HPC_LAB=1 bash /workspace/deploy/federation/build-pbs-lab.sh /lab-pbs/openpbs.tar.gz\n"
        ), timeout=180 if cached_pbs else 1800)
        (output / "pbs-install.log").write_text(install.stdout + install.stderr)
        assert run(["/opt/pbs/bin/qsub", "--version"]).stdout.strip() == "pbs_version = 23.06.06"
        if not cached_pbs:
            archive = output / "pbs-install.tar.gz"
            with archive.open("wb") as target:
                subprocess.run(["kubectl", "exec", "-n", namespace, "scheduler", "--", "tar", "czf", "-", "-C", "/opt", "pbs"], stdout=target, stderr=subprocess.PIPE, check=True, timeout=60)
            shutil.copyfile(pbs / "openpbs.tar.gz", output / "openpbs.tar.gz")
            (output / "pbs-install.json").write_text(json.dumps({"version": "23.06.06", "sourceCommit": pbs_commit, "sourceSha256": pbs_source_hash, "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "image": image}))
        run(["bash", "-c", "nohup bash /usr/local/bin/kq-lab-scheduler-entrypoint >/tmp/pbs-entrypoint.log 2>&1 </dev/null &"])
        for attempt in range(90):
            result = run(["sh", "-c", "qstat -B >/dev/null && test -f /var/lib/kuintessence/agent.db"], check=False)
            if result.returncode == 0:
                break
            assert attempt < 89, "PBS/Agent readiness timeout"
            time.sleep(1)
    print(f"Real {scheduler} ready; testing imported data and scheduler stopping", flush=True)
    if case == "cgroup":
        probe = run(["env", "KQ_MEDIA_CGROUP_LAB=1", "bash", "/workspace/scripts/pbs-cgroup-lab.sh"], timeout=180)
    else:
        if pbs:
            setup = run(["env", "KQ_MEDIA_CGROUP_LAB=1", "bash", "/workspace/scripts/federation-live/pbs-cgroup-setup.sh"], timeout=60)
            (output / "cgroup-setup.log").write_text(setup.stdout + setup.stderr)
        probe = run(["env", "KQ_MEDIA_HPC_LAB=1", "KQ_MEDIA_AGE_TEST_BIN=/opt/kq/age",
                     "KQ_MEDIA_HPC_CASE=" + case, "KQ_MEDIA_SCHEDULER=" + scheduler,
                     "bun", "/workspace/scripts/federation-media-hpc-probe.ts"], timeout=150)
    (output / "observations.jsonl").write_text(probe.stdout)
    (output / "probe.log").write_text(probe.stderr)
    (output / "checkout.json").write_text(json.dumps({
        "image": image, "namespace": namespace, "scheduler": scheduler,
        "sifSha256": hashlib.sha256((runtime / "bash.sif").read_bytes()).hexdigest(),
    }))
    print(probe.stdout, end="", flush=True)
    print(f"PASS; evidence: {output}", flush=True)
finally:
    if created:
        try:
            logs = run(["tail", "-30", "/tmp/pbs-entrypoint.log"], check=False) if pbs else kubectl(["logs", "-n", namespace, "scheduler", "--tail=30"], check=False)
            (output / "scheduler.log").write_text(logs.stdout + logs.stderr)
        finally:
            kubectl(["delete", "namespace", namespace, "--ignore-not-found", "--wait=false"], check=False)
            print(f"Cleanup requested for {namespace}", flush=True)

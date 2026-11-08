"""Real non-root Slurm target for the isolated two-platform execution lab."""
import json
import re
import shutil


def configure_target(pod, root, runtime, metadata):
    container = pod["spec"]["containers"][0]
    container["image"] = "docker.io/library/debian@sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392"
    container["imagePullPolicy"] = "IfNotPresent"
    container["securityContext"] = {"privileged": True}
    container["resources"]["limits"] = {"cpu": "1", "memory": "1Gi"}
    pod["spec"]["automountServiceAccountToken"] = False
    pod["spec"]["activeDeadlineSeconds"] = 1200
    for name, path in [("runtime", str(runtime)), ("bun", shutil.which("bun"))]:
        assert path
        pod["spec"]["volumes"].append({"name": name, "hostPath": {"path": path}})
        container["volumeMounts"].append({"name": name, "mountPath": "/lab-" + name, "readOnly": True})
    setting = {entry["name"]: entry["value"] for entry in container["env"]}
    for key in list(setting):
        if key.startswith("AGENT_SANDBOX_K8S_"):
            del setting[key]
    setting.update(AGENT_SCHEDULER_TYPE="slurm", AGENT_SCHEDULER_VERSION="24.11.5",
                   AGENT_SANDBOX_EXECUTION_MODE="self-account", AGENT_SANDBOX_ROOT_IMPERSONATION="false",
                   AGENT_SANDBOX_ROOT="/scratch/sandbox", AGENT_SANDBOX_ATTESTATION_QUEUE="sandbox",
                   AGENT_SANDBOX_SIF_PGP_FINGERPRINT=metadata["fingerprint"],
                   AGENT_SANDBOX_RUNTIME_CACHE_JSON=json.dumps({metadata["digest"]: {
                       "kind": "SIF", "localPath": "/opt/kq/bash.sif", "signatureVerified": False}}),
                   LAB_HPC_ROOT=str(root / "hpc"), KQ_SLURM_CGROUP_LAB="1", KQ_SLURM_AGENT="1")
    container["env"] = [{"name": key, "value": value} for key, value in setting.items()]
    container["command"] = ["bash", "/workspace/scripts/federation-live/selfaccount-bootstrap.sh"]


def inspect_native(k, namespace, job):
    job_id = job["schedulerJobId"]
    assert re.fullmatch(r"[0-9]+", job_id), "Expected native Slurm allocation ID"
    rows = k(["exec", "-n", namespace, "scheduler", "--", "scontrol", "show", "jobs", "-o"]).stdout.splitlines()
    matches = [row for row in rows if re.search(r"(?:^|\s)Comment=KQ_JOB_ID=" + re.escape(job["id"]) + r"(?:\s|$)", row)]
    assert len(matches) == 1, "Original KQ UUID must identify exactly one real Slurm job"
    row = matches[0]

    def field(name):
        match = re.search(r"(?:^|\s)" + name + r"=([^\s]+)", row)
        assert match, (name, row)
        return match[1]

    assert field("JobId") == job_id and field("UserId") == "scientist(24001)"
    assert field("Partition") == "sandbox"
    path = field("StdOut")
    assert path == f"/scratch/sandbox/{job['id']}/.scheduler-logs/kq-{job['id']}.out", path
    result = k(["exec", "-n", namespace, "scheduler", "--", "cat", path], check=False)
    if result.returncode:
        # Successful collection may already have removed the sandbox; use the original UUID's retained log.
        retained = f"/var/lib/kuintessence/jobs/.scheduler-logs/kq-{job['id']}.out"
        result = k(["exec", "-n", namespace, "scheduler", "--", "cat", retained], check=False)
    return {"schedulerJobId": job_id, "jobId": job["id"], "state": field("JobState"),
            "exitCode": field("ExitCode"), "uid": 24001, "queue": "sandbox"}, result.stdout


def interrupt_agent(k, namespace):
    # Target only the actual Agent process, preserving its supervisor and separate watchdog.
    code = r'''
import json,os,signal,time
from pathlib import Path
def agent_pids():
    found=[]
    for path in Path('/proc').iterdir():
        if not path.name.isdigit(): continue
        try:
            args=(path/'cmdline').read_bytes().split(b'\0')
            if b'/workspace/packages/agent/src/index.ts' in args and b'--federation-watchdog' not in args:
                assert path.stat().st_uid == 24001
                found.append(int(path.name))
        except FileNotFoundError: pass
    return found
old=agent_pids()
assert len(old)==1, old
os.kill(old[0],signal.SIGKILL)
for attempt in range(100):
    current=agent_pids()
    if len(current)==1 and current[0]!=old[0]: break
    time.sleep(.1)
else: raise RuntimeError('Production supervisor did not restart the Agent')
print(json.dumps({'oldPid':old[0],'newPid':current[0],'uid':24001}))
'''
    return json.loads(k(["exec", "-n", namespace, "scheduler", "--", "python3", "-c", code]).stdout)

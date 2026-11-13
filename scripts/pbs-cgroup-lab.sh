#!/usr/bin/env bash
# Run only inside the disposable scheduler Pod created by the media lab.
set -euo pipefail
[[ ${KQ_MEDIA_CGROUP_LAB:-} == 1 ]]
diagnostics() {
  local status=$?
  if ((status != 0)); then
    for path in /scratch/cgroup-probe/error /scratch/cgroup-probe/output /var/spool/pbs/spool/*.ER /var/spool/pbs/spool/*.OU; do
      [[ ! -f "$path" ]] || cat "$path"
    done
    tail -60 /var/spool/pbs/mom_logs/???????? || true
  fi
}
trap diagnostics EXIT
bash /workspace/scripts/federation-live/pbs-cgroup-setup.sh
mkdir -p /scratch/cgroup-probe
chown scientist:scientist /scratch/cgroup-probe
cat >/scratch/cgroup-probe/job.sh <<'JOB'
#!/bin/bash
set -euo pipefail
/usr/bin/python3 /usr/libexec/kuintessence/kq-sandbox-cgroup-check --scheduler pbs-pro --job-id "$PBS_JOBID" --cpus 1 --memory-mb 64
/usr/bin/python3 - <<'PY'
import json,os,pathlib,subprocess
root=pathlib.Path('/sys/fs/cgroup')/pathlib.Path('/proc/self/cgroup').read_text().strip()[4:]
assert root.name == os.environ['PBS_JOBID'] and root.parent.name == 'jobid'
def stat(name): return dict(line.split() for line in root.joinpath(name).read_text().splitlines())
try:
    root.parent.joinpath('cgroup.procs').write_text(str(os.getpid()))
except PermissionError: pass
else: raise AssertionError('PBS job escaped its cgroup')
before=stat('cpu.stat')
subprocess.run(['/usr/bin/python3','-c','import os,time\npid=os.fork()\nend=time.monotonic()+2\nwhile time.monotonic()<end: pass\nif pid: os.waitpid(pid,0)'],check=True)
after=stat('cpu.stat')
assert int(after['nr_throttled']) > int(before['nr_throttled'])
child=subprocess.run(['/usr/bin/python3','-c','x=bytearray(128*1024*1024); print(len(x))'])
assert child.returncode == -9, child.returncode
assert int(stat('memory.events')['oom_kill']) > 0
print(json.dumps({'jobId':os.environ['PBS_JOBID'],'cpuThrottled':int(after['nr_throttled'])-int(before['nr_throttled']),'oomKill':int(stat('memory.events')['oom_kill']),'escapeRejected':True}),flush=True)
PY
JOB
chmod 644 /scratch/cgroup-probe/job.sh
job=$(setpriv --reuid=24001 --regid=24001 --init-groups -- /opt/pbs/bin/qsub -q workq -N kqcg -l select=1:ncpus=1:mem=64mb -l walltime=00:01:00 -o /scratch/cgroup-probe/output -e /scratch/cgroup-probe/error /scratch/cgroup-probe/job.sh)
export KQ_CGROUP_LAB_JOB="$job"
python3 - <<'PY'
import json,os,pathlib,subprocess,time
job=os.environ['KQ_CGROUP_LAB_JOB']
for attempt in range(90):
    result=subprocess.run(['/opt/pbs/bin/qstat','-xf','-F','json',job],capture_output=True,text=True)
    if result.returncode == 0:
        facts=json.loads(result.stdout)['Jobs'][job]
        if facts.get('job_state') == 'F':
            print(json.dumps(facts,sort_keys=True),flush=True)
            for suffix in ['error','output']:
                local=pathlib.Path('/scratch/cgroup-probe')/suffix
                spool=pathlib.Path('/var/spool/pbs/spool')/(job+('.ER' if suffix == 'error' else '.OU'))
                if not local.exists() and spool.exists(): local.write_bytes(spool.read_bytes())
            assert facts['Exit_status'] == 0, facts
            break
    time.sleep(1)
else: raise AssertionError('PBS cgroup job did not finish')
root=pathlib.Path(json.loads(pathlib.Path('/etc/kuintessence/pbs-cgroup-v2.json').read_text())['cgroupRoot'])
assert not (root/job).exists(), 'PBS hook did not clean the original cgroup'
text=pathlib.Path('/scratch/cgroup-probe/output').read_text()
print(text,flush=True)
assert '"escapeRejected": true' in text and '"cgroupVersion": 2' in text
print('REAL PBS CGROUP V2 PASSED',flush=True)
PY

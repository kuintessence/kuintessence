#!/usr/bin/env python3
"""Opt-in native Slurm v2 job/checker experiment in one owned k3s Pod."""
import json, os, pathlib, signal, subprocess, uuid
repo=pathlib.Path(__file__).resolve().parent.parent
namespace='kq-slurm-cgroup-'+uuid.uuid4().hex[:8]
output=repo/'temp'/namespace
output.mkdir(mode=0o700)
image='docker.io/library/debian@sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392'
slurm_version='24.11.5-4+deb13u1'
assert os.environ.get('KQ_SLURM_CGROUP_LAB')=='1'
def k(args, data=None, check=True, timeout=40):
    result=subprocess.run(['kubectl',*args],input=data,text=True,capture_output=True,timeout=timeout)
    if check and result.returncode:
        (output/'failure.log').write_text(result.stdout+result.stderr)
        raise RuntimeError('Lab failed; inspect '+str(output/'failure.log'))
    return result
def run(args,**kw):return k(['exec','-i','-n',namespace,'slurm','--',*args],**kw)
source = """import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {buildSelfAccountCgroupCommand} from './packages/agent/src/sandbox/cgroup-command';
console.log(buildSelfAccountCgroupCommand({
  path:'/usr/libexec/kuintessence/kq-sandbox-cgroup-check',
  sha256:createHash('sha256').update(readFileSync('packages/agent/scripts/kq-sandbox-cgroup-check')).digest('hex')
}, {cpus:1, memoryMb:128}));"""
command=subprocess.check_output(['bun','--no-env-file','-e',source],cwd=repo,text=True,timeout=30)
(output/'job.sh').write_text('#!/bin/bash\nset -euo pipefail\n[[ $(id -u) == 24001 ]]\n'+command+'\ncat /proc/self/cgroup\nprintf "REAL_SLURM_CGROUP_OK\\n"\n')
(output/'checkout.json').write_text(json.dumps({'image':image,'slurmVersion':slurm_version,'namespace':namespace,
    'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()}))
def terminate(_signum, _frame):
    raise KeyboardInterrupt("Slurm lab cancelled")

signal.signal(signal.SIGTERM, terminate)
created=False
try:
    k(['create','namespace',namespace]);created=True
    pod={'apiVersion':'v1','kind':'Pod','metadata':{'name':'slurm','namespace':namespace},'spec':{
        'restartPolicy':'Never','activeDeadlineSeconds':600,'terminationGracePeriodSeconds':10,'automountServiceAccountToken':False,
        'containers':[{'name':'slurm','image':image,'imagePullPolicy':'IfNotPresent','securityContext':{'privileged':True},'command':['sleep','900'],
            'resources':{'requests':{'cpu':'100m','memory':'256Mi'},'limits':{'cpu':'1','memory':'1Gi'}},
            'volumeMounts':[{'name':'source','mountPath':'/workspace','readOnly':True}]}],
        'volumes':[{'name':'source','hostPath':{'path':str(repo),'type':'Directory'}}]}}
    k(['apply','-f','-'],json.dumps(pod))
    k(['wait','-n',namespace,'--for=condition=Ready','pod/slurm','--timeout=60s'],timeout=70)
    print('Owned lab '+namespace,flush=True)
    setup=run(['env','KQ_SLURM_VERSION='+slurm_version,'bash','-c',"""set -eu
export DEBIAN_FRONTEND=noninteractive
printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d
chmod 755 /usr/sbin/policy-rc.d
apt-get update -qq
apt-get install -y --no-install-recommends slurmd=$KQ_SLURM_VERSION slurmctld=$KQ_SLURM_VERSION slurm-client=$KQ_SLURM_VERSION slurm-wlm-basic-plugins=$KQ_SLURM_VERSION python3 util-linux procps mount
useradd -u 24001 -m scientist
dpkg-query -W slurmd slurmctld slurm-client slurm-wlm-basic-plugins
sha256sum /usr/sbin/slurmd /usr/sbin/slurmctld /usr/lib/x86_64-linux-gnu/slurm-wlm/cgroup_v2.so
"""],timeout=200)
    (output/'setup.log').write_text(setup.stdout+setup.stderr)
    result=run(['env','KQ_SLURM_CGROUP_LAB=1','KQ_SLURM_CGROUP_JOB=/workspace/temp/'+namespace+'/job.sh','bash','/workspace/scripts/federation-live/slurm-cgroup-outer.sh'],check=False,timeout=150)
    (output/'probe.log').write_text(result.stdout+result.stderr)
    print(result.stdout[-3500:],flush=True)
    assert result.returncode==0, 'Probe failed: '+str(output/'probe.log')
    print('PASS '+str(output),flush=True)
finally:
    if created:
        k(['delete','namespace',namespace,'--wait=false','--ignore-not-found'],check=False)
        print('Cleanup requested '+namespace,flush=True)

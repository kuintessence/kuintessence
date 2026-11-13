"""Validate SSH packaging and rejection before any remote operation."""
from pathlib import Path
import os
import subprocess
import tarfile
import tempfile

with tempfile.TemporaryDirectory(prefix='kq-remote-check-') as directory:
    tmp=Path(directory)
    mock=tmp/'ssh'
    mock.write_text('#!/usr/bin/env python3\nimport os,sys\nfrom pathlib import Path\np=Path(os.environ["KQ_CAPTURE"])\np.with_suffix(".sh").write_text(sys.argv[-1])\np.with_suffix(".tar").write_bytes(sys.stdin.buffer.read())\n')
    mock.chmod(0o700)
    env={**os.environ,'PATH':str(tmp)+':'+os.environ['PATH'],'KQ_CAPTURE':str(tmp/'capture'),
        'KQ_FEDERATION_MODE':'direct','KQ_DEPLOY_REVISION':'a'*40,'FEDERATION_SSH_HOST':'example.com',
        'FEDERATION_SSH_USER':'deploy','FEDERATION_SSH_KEY':'test-placeholder','FEDERATION_SSH_KNOWN_HOSTS':'test-placeholder',
        'RUNNER_TEMP':str(tmp)}
    subprocess.run(['bash','deploy/federation/remote.sh'],env=env,check=True)
    subprocess.run(['bash','-n',str(tmp/'capture.sh')],check=True)
    with tarfile.open(tmp/'capture.tar') as archive:
        paths=archive.getnames()
        assert 'deploy/federation/apply.sh' in paths
        assert len(paths)==5
    text=(tmp/'capture.sh').read_text()
    assert '"$stage"' in text and 'direct' in text
    for key,value in [('KQ_DEPLOY_REVISION','$(false)'),('KQ_FEDERATION_MODE','invalid'),('FEDERATION_SSH_KNOWN_HOSTS','')]:
        result=subprocess.run(['bash','deploy/federation/remote.sh'],env={**env,key:value},capture_output=True)
        assert result.returncode!=0
print('Deployment archive, remote command syntax and invalid-input rejection: passed')

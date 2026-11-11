ARG KQ_SERVER_IMAGE
ARG KQ_SCHEDULER_IMAGE
FROM ${KQ_SERVER_IMAGE} AS tools
COPY packages/agent /app/packages/agent
COPY packages/cli /app/packages/cli
RUN bun build --compile --target=bun-linux-x64 /app/packages/cli/src/agent-registration-entry.ts --outfile=/out/kq-agent-admin

FROM ${KQ_SCHEDULER_IMAGE}
ARG KQ_BUILD_REVISION
COPY --from=tools /opt/kuintessence/agent/kq-agent-bun-linux-x64 /usr/local/bin/kq-agent
COPY --from=tools /opt/kuintessence/agent/manifest.json /usr/local/share/kuintessence/agent-manifest.json
COPY --from=tools /out/kq-agent-admin /usr/local/bin/kq-agent-admin
COPY deploy/federation/aio/register-agent.sh /usr/local/bin/kq-register-compose-agent
COPY deploy/federation/aio/start-agent.py /usr/local/lib/kuintessence/start-agent.py
COPY deploy/federation/aio/managed.py /usr/local/lib/kuintessence/managed.py
COPY deploy/federation/aio/managed-scheduler.service /etc/systemd/system/kq-aio-scheduler.service
COPY deploy/federation/aio/managed-pbs.slice /etc/systemd/system/kq-pbs-jobs.slice
COPY deploy/federation/aio/managed-slurm.conf deploy/federation/aio/managed-cgroup.conf /usr/local/share/kuintessence/
COPY deploy/schedulers/pbs/kq-cgroup-v2.py /usr/local/share/kuintessence/kq-cgroup-v2.py
COPY packages/agent/scripts/kq-sandbox-cgroup-check /usr/libexec/kuintessence/kq-sandbox-cgroup-check
COPY deploy/schedulers/k3s/seccomp-kubernetes-no-network.json /etc/kuintessence/aio-seccomp.json
COPY deploy/schedulers/common/supervise-agent.py /usr/local/bin/kq-supervise-agent.py
COPY deploy/federation/aio/target-facts.py /usr/local/bin/kq-target-facts.py
COPY deploy/federation/aio/verify-agent.py /usr/local/bin/kq-verify-agent.py
RUN printf '#!/bin/sh\nexec /usr/bin/python3 /usr/local/lib/kuintessence/managed.py agent\n' >/usr/local/bin/kq-start-agent \
  && chmod 755 /usr/local/bin/kq-agent /usr/local/bin/kq-agent-admin /usr/local/bin/kq-register-compose-agent /usr/local/bin/kq-start-agent /usr/libexec/kuintessence/kq-sandbox-cgroup-check \
  && /usr/local/bin/kq-verify-architecture /usr/local/bin/kq-agent /usr/local/bin/kq-agent-admin \
  && python3 /usr/local/bin/kq-verify-agent.py "$KQ_BUILD_REVISION" \
  && python3 -c 'import json,pathlib; p=json.loads(pathlib.Path("/etc/kuintessence/aio-seccomp.json").read_text()); p["syscalls"].append({"names":["uname"],"action":"SCMP_ACT_ERRNO","errnoRet":1}); pathlib.Path("/etc/kuintessence/aio-seccomp-probe.json").write_text(json.dumps(p))' \
  && mkdir -p /etc/systemd/system/user@.service.d /srv/kq/spack /etc/kuintessence/managed \
  && printf '[Service]\nDelegate=cpu cpuset io memory pids\n' >/etc/systemd/system/user@.service.d/delegate.conf \
  && systemctl enable kq-aio-scheduler.service \
  && systemctl mask slurmctld.service slurmd.service slurmdbd.service munge.service pbs.service \
  && rm -f /etc/machine-id && touch /etc/machine-id
ENV KQ_AGENT_BINARY=/usr/local/bin/kq-agent
ENV KQ_AGENT_ENV_FILE=/var/lib/kuintessence/registration/agent.env
ENV NODE_ENV=production
ENV SLURM_CONF=/etc/slurm-llnl/slurm.conf
ENV container=docker

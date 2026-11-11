ARG SCHEDULER_BASE_IMAGE=scheduler-base
FROM ${SCHEDULER_BASE_IMAGE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=""
ARG KQ_AIO_ACCOUNTING=false

RUN if [[ -n "${APT_MIRROR}" ]]; then sed -i "s|http://ports.ubuntu.com/ubuntu-ports|${APT_MIRROR}|g" /etc/apt/sources.list; fi \
  && apt-get update && apt-get install -y --no-install-recommends \
    munge \
    slurm-client \
    slurm-wlm \
    slurmctld \
    slurmd \
  && if [[ "$KQ_AIO_ACCOUNTING" == true ]]; then apt-get install -y --no-install-recommends slurmdbd slurm-wlm-mysql-plugin; fi \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/munge/munge.key \
  && mkdir -p /etc/slurm-llnl /var/spool/slurmctld /var/spool/slurmd /var/log/slurm \
  && if [[ -d /etc/slurm && ! -L /etc/slurm ]]; then cp -a /etc/slurm/. /etc/slurm-llnl/ && rm -rf /etc/slurm; fi \
  && ln -sfn /etc/slurm-llnl /etc/slurm \
  && chown -R slurm:slurm /var/spool/slurmctld /var/spool/slurmd /var/log/slurm

COPY common/start-agent.sh /usr/local/bin/kq-start-agent
COPY common/install-agent-deps.sh /usr/local/bin/kq-install-agent-deps
COPY common/register-agent.sh /usr/local/bin/kq-register-compose-agent
COPY common/scheduler-capacity.py /usr/local/bin/kq-scheduler-capacity.py
COPY slurm/slurm.conf.template /etc/slurm-llnl/slurm.conf.template
COPY slurm/entrypoint.sh /usr/local/bin/kq-slurm-entrypoint

RUN chmod +x /usr/local/bin/kq-start-agent /usr/local/bin/kq-install-agent-deps /usr/local/bin/kq-register-compose-agent /usr/local/bin/kq-slurm-entrypoint

ENTRYPOINT ["tini", "--", "/usr/local/bin/kq-slurm-entrypoint"]

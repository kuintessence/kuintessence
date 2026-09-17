FROM scheduler-base

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=""

RUN if [[ -n "${APT_MIRROR}" ]]; then sed -i "s|http://ports.ubuntu.com/ubuntu-ports|${APT_MIRROR}|g" /etc/apt/sources.list; fi \
  && apt-get update && apt-get install -y --no-install-recommends \
    munge \
    slurm-client \
    slurm-wlm \
    slurmctld \
    slurmd \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /etc/slurm-llnl /var/spool/slurmctld /var/spool/slurmd /var/log/slurm \
  && ln -sfn /etc/slurm-llnl /etc/slurm \
  && chown -R slurm:slurm /var/spool/slurmctld /var/spool/slurmd /var/log/slurm

COPY common/start-agent.sh /usr/local/bin/kq-start-agent
COPY common/install-agent-deps.sh /usr/local/bin/kq-install-agent-deps
COPY common/register-agent.sh /usr/local/bin/kq-register-compose-agent
COPY slurm/slurm.conf.template /etc/slurm-llnl/slurm.conf.template
COPY slurm/entrypoint.sh /usr/local/bin/kq-slurm-entrypoint

RUN chmod +x /usr/local/bin/kq-start-agent /usr/local/bin/kq-install-agent-deps /usr/local/bin/kq-register-compose-agent /usr/local/bin/kq-slurm-entrypoint

ENTRYPOINT ["tini", "--", "/usr/local/bin/kq-slurm-entrypoint"]

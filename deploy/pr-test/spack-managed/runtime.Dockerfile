FROM scheduler-runtime AS managed-base

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG DEBIAN_FRONTEND=noninteractive
RUN curl --fail --location --retry 5 \
      https://github.com/apptainer/apptainer/releases/download/v1.4.3/apptainer_1.4.3_amd64.deb \
      -o /tmp/apptainer.deb \
  && echo "c3c05120baab7ece2e81d40c1d1be63cc3fd1f5a25f379a4f2b2f99a0f6a1100  /tmp/apptainer.deb" | sha256sum --check \
  && apt-get update \
  && apt-get install -y --no-install-recommends /tmp/apptainer.deb \
      systemd dbus-user-session libpam-systemd e2fsprogs \
  && rm -rf /var/lib/apt/lists/* /tmp/apptainer.deb \
  && python3 -m pip install --no-cache-dir clingo==5.7.1 \
  && test "$(apptainer --version)" = "apptainer version 1.4.3" \
  && test "$(id -u kq)" = 1000 \
  && rm /etc/sudoers.d/kq \
  && gpasswd -d kq sudo \
  && sed -i -E 's/^sessiondir max size = .*/sessiondir max size = 2048/; s/^memory fs type = .*/memory fs type = tmpfs/' /etc/apptainer/apptainer.conf
COPY --from=test-workspace /workspace/deploy/pr-test/spack-case/empty-config/repos.yaml /opt/spack/etc/spack/repos.yaml

FROM managed-base AS sif-root
RUN mkdir -p /kq/input /kq/work /sys/fs/cgroup \
  && chown kq:kq /kq/work \
  && chmod 0700 /kq/work \
  && rm -rf /workspace /var/lib/kuintessence /var/lib/slurm-llnl /var/spool/slurmctld /var/spool/slurmd \
  && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

FROM managed-base AS sif-builder
COPY --from=sif-root / /sif-rootfs/
ENTRYPOINT ["/usr/bin/apptainer"]
CMD ["build", "--disable-cache", "/runtime/spack.sif", "/sif-rootfs"]

FROM managed-base AS scheduler
COPY --from=test-workspace /workspace /workspace
RUN mkdir -p /etc/systemd/system/user@.service.d /srv/kq/spack /etc/kuintessence/managed \
  && cp /workspace/deploy/pr-test/spack-managed/delegate.conf /etc/systemd/system/user@.service.d/delegate.conf \
  && cp /workspace/deploy/pr-test/spack-managed/scheduler.service /etc/systemd/system/kq-pr-scheduler.service \
  && systemctl enable kq-pr-scheduler.service \
  && systemctl mask slurmctld.service slurmd.service munge.service \
  && rm -f /etc/machine-id \
  && touch /etc/machine-id
ENV container=docker
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/bin/bash", "/workspace/deploy/pr-test/spack-managed/init.sh"]

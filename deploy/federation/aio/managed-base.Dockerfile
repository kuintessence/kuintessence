ARG KQ_SCHEDULER_BASE_IMAGE
FROM ${KQ_SCHEDULER_BASE_IMAGE} AS managed-base
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG DEBIAN_FRONTEND=noninteractive
RUN . /etc/os-release && test "$ID:$VERSION_ID" = ubuntu:24.04 \
  && curl --fail --location --retry 3 https://github.com/apptainer/apptainer/releases/download/v1.4.3/apptainer_1.4.3_amd64.deb -o /tmp/apptainer.deb \
  && curl --fail --location --retry 3 https://github.com/apptainer/apptainer/releases/download/v1.4.3/apptainer-suid_1.4.3_amd64.deb -o /tmp/apptainer-suid.deb \
  && echo 'c3c05120baab7ece2e81d40c1d1be63cc3fd1f5a25f379a4f2b2f99a0f6a1100  /tmp/apptainer.deb' | sha256sum -c - \
  && echo '5b9308c9bc643d8c8bc62fe545e29a23f6b8deea8d11782e4000bc6d621a2480  /tmp/apptainer-suid.deb' | sha256sum -c - \
  && apt-get update && apt-get install -y --no-install-recommends \
      /tmp/apptainer.deb /tmp/apptainer-suid.deb systemd dbus-user-session libpam-systemd \
      e2fsprogs squashfs-tools squashfuse python3-venv libseccomp2 \
  && python3 -m pip install --break-system-packages --no-cache-dir clingo==5.7.1 \
  && rm -rf /var/lib/apt/lists/* /tmp/apptainer.deb /tmp/apptainer-suid.deb \
  && test "$(id -u kq)" = 1000 \
  && test "$(id -g kq)" = 1000 \
  && rm /etc/sudoers.d/kq && gpasswd -d kq sudo \
  && sed -i -E 's/^sessiondir max size = .*/sessiondir max size = 2048/; s/^memory fs type = .*/memory fs type = tmpfs/' /etc/apptainer/apptainer.conf \
  && install -d -m 0755 /opt/spack/opt/spack/.spack-db /usr/local/share/kuintessence/runtime \
  && touch /opt/spack/opt/spack/.spack-db/lock && chmod 0644 /opt/spack/opt/spack/.spack-db/lock \
  && printf 'repos:: {}\n' >/opt/spack/etc/spack/repos.yaml

FROM managed-base AS sif-root
RUN mkdir -p /kq/input /kq/work /sys/fs/cgroup \
  && chown kq:kq /kq/work && chmod 0700 /kq/work \
  && rm -rf /workspace /var/lib/kuintessence \
  && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

FROM managed-base AS sif-builder
COPY --from=sif-root / /sif-rootfs/
# Conversion of a local rootfs uses no recipe, software install or remote image.
RUN mkdir /runtime \
  && apptainer build --disable-cache --mksquashfs-args '-processors 1' /runtime/spack.sif /sif-rootfs \
  && chmod 0444 /runtime/spack.sif

FROM managed-base
COPY --from=sif-builder /runtime/spack.sif /usr/local/share/kuintessence/runtime/spack.sif

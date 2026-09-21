FROM ubuntu:20.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=""
ARG BUN_VERSION=1.4.2
ARG SPACK_REF=v1.0.3
ARG TARGETOS
ARG TARGETARCH

RUN if [[ -n "${APT_MIRROR}" ]]; then sed -i "s|http://ports.ubuntu.com/ubuntu-ports|${APT_MIRROR}|g" /etc/apt/sources.list; fi \
  && apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    file \
    gfortran \
    git \
    iproute2 \
    locales \
    openssh-client \
    procps \
    python3 \
    python3-pip \
    sudo \
    tini \
    unzip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && locale-gen en_US.UTF-8 \
  && target_os="${TARGETOS:-linux}" \
  && target_architecture="${TARGETARCH:-$(dpkg --print-architecture)}" \
  && if [[ "${target_os}" != "linux" ]]; then echo "unsupported scheduler OS: ${target_os}" >&2; exit 1; fi \
  && case "${target_architecture}" in \
    amd64) bun_arch="x64" ;; \
    arm64) bun_arch="aarch64" ;; \
    *) echo "unsupported scheduler architecture: ${target_architecture}" >&2; exit 1 ;; \
  esac \
  && for attempt in 1 2 3 4 5; do \
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip" -o /tmp/bun.zip && break; \
    if [[ "${attempt}" == "5" ]]; then exit 1; fi; \
    sleep 3; \
  done \
  && unzip -q /tmp/bun.zip -d /tmp \
  && mv "/tmp/bun-linux-${bun_arch}/bun" /usr/local/bin/bun \
  && chmod +x /usr/local/bin/bun \
  && rm -rf /tmp/bun.zip "/tmp/bun-linux-${bun_arch}" \
  && useradd -m -s /bin/bash kq \
  && useradd -m -s /bin/bash alice \
  && useradd -m -s /bin/bash bob \
  && usermod -aG sudo kq \
  && echo "kq ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/kq \
  && chmod 0440 /etc/sudoers.d/kq \
  && mkdir -p /opt/spack \
  && for attempt in 1 2 3 4 5; do \
    curl -fsSL "https://github.com/spack/spack/archive/refs/tags/${SPACK_REF}.tar.gz" -o /tmp/spack.tar.gz && break; \
    if [[ "${attempt}" == "5" ]]; then exit 1; fi; \
    sleep 3; \
  done \
  && tar -xzf /tmp/spack.tar.gz --strip-components=1 -C /opt/spack \
  && rm -f /tmp/spack.tar.gz \
  && mkdir -p /etc/kuintessence /workspace /var/lib/kuintessence /var/cache/bun \
  && printf "%s\n" "${target_architecture}" >/etc/kuintessence/image-architecture \
  && chown -R kq:kq /workspace /var/lib/kuintessence /var/cache/bun

COPY common/verify-architecture.sh /usr/local/bin/kq-verify-architecture

RUN chmod +x /usr/local/bin/kq-verify-architecture \
  && /usr/local/bin/kq-verify-architecture /usr/local/bin/bun

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV SPACK_ROOT=/opt/spack
ENV BUN_INSTALL_CACHE_DIR=/var/cache/bun
ENV PATH=/opt/spack/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workspace

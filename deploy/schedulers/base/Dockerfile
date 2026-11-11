ARG SCHEDULER_OS_IMAGE=ubuntu:20.04
FROM ${SCHEDULER_OS_IMAGE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=""
# Bun hashes come from its release SHASUMS256.txt; Spack hashes pin official tag archives.
ARG BUN_VERSION=1.4.2
ARG BUN_SHA256=""
ARG SPACK_REF=v1.0.3
ARG SPACK_SHA256=""
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
    util-linux \
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
  && if [[ -z "${BUN_SHA256}" ]]; then \
    case "${BUN_VERSION}:${bun_arch}" in \
      1.4.2:x64) BUN_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913 ;; \
      1.4.2:aarch64) BUN_SHA256=54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7 ;; \
      *) echo "set BUN_SHA256 for this Bun version and architecture" >&2; exit 1 ;; \
    esac; \
  fi \
  && for attempt in 1 2 3 4 5; do \
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip" -o /tmp/bun.zip && break; \
    if [[ "${attempt}" == "5" ]]; then exit 1; fi; \
    sleep 3; \
  done \
  && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
  && unzip -q /tmp/bun.zip -d /tmp \
  && mv "/tmp/bun-linux-${bun_arch}/bun" /usr/local/bin/bun \
  && chmod +x /usr/local/bin/bun \
  && rm -rf /tmp/bun.zip "/tmp/bun-linux-${bun_arch}" \
  && if id ubuntu >/dev/null 2>&1 && [[ "$(id -u ubuntu)" == 1000 ]]; then userdel -r ubuntu; fi \
  && useradd -m -u 1000 -s /bin/bash kq \
  && useradd -m -s /bin/bash alice \
  && useradd -m -s /bin/bash bob \
  && usermod -aG sudo kq \
  && echo "kq ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/kq \
  && chmod 0440 /etc/sudoers.d/kq \
  && mkdir -p /opt/spack \
  && if [[ -z "${SPACK_SHA256}" ]]; then \
    case "${SPACK_REF}" in \
      v1.0.3) SPACK_SHA256=84cb2f2ef0230d9b3913277202f5fa53ad26ae8fdbc6d46985bbc3f866031581 ;; \
      v1.0.0) SPACK_SHA256=70dceb9abdf1225d596714522a0fc4d0290e8c5496f1bae8192ffe611b60cfa1 ;; \
      *) echo "set SPACK_SHA256 for this Spack ref" >&2; exit 1 ;; \
    esac; \
  fi \
  && for attempt in 1 2 3 4 5; do \
    curl -fsSL "https://github.com/spack/spack/archive/refs/tags/${SPACK_REF}.tar.gz" -o /tmp/spack.tar.gz && break; \
    if [[ "${attempt}" == "5" ]]; then exit 1; fi; \
    sleep 3; \
  done \
  && echo "${SPACK_SHA256}  /tmp/spack.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/spack.tar.gz --strip-components=1 -C /opt/spack \
  && rm -f /tmp/spack.tar.gz \
  && mkdir -p /etc/kuintessence /workspace /var/lib/kuintessence /var/cache/bun \
  && printf "%s\n" "${target_architecture}" >/etc/kuintessence/image-architecture \
  && chown -R kq:kq /workspace /var/lib/kuintessence /var/cache/bun

COPY common/supervise-agent.py /usr/local/bin/kq-supervise-agent.py

COPY common/verify-architecture.sh /usr/local/bin/kq-verify-architecture

RUN chmod +x /usr/local/bin/kq-verify-architecture \
  && /usr/local/bin/kq-verify-architecture /usr/local/bin/bun

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV SPACK_ROOT=/opt/spack
ENV BUN_INSTALL_CACHE_DIR=/var/cache/bun
ENV PATH=/opt/spack/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workspace

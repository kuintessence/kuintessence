ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG TARGET_PROFILE=ubuntu24
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates curl git gcc g++ make perl \
      zlib1g-dev libbz2-dev liblzma-dev libffi-dev libsqlite3-dev libreadline-dev \
      tar gzip bzip2 xz-utils patch diffutils findutils file \
  && rm -rf /var/lib/apt/lists/* \
  && if getent passwd 1000 >/dev/null; then userdel "$(getent passwd 1000 | cut -d: -f1)"; fi \
  && useradd --uid 1000 --create-home kq

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
COPY deploy/pr-test/spack-targets/bootstrap.sh deploy/pr-test/spack-targets/requirements.txt /opt/kq-target/
RUN bash /opt/kq-target/bootstrap.sh
COPY deploy/pr-test/spack-case/prepare.py /opt/kq-target/baseline/prepare.py
COPY deploy/pr-test/spack-case/hello /opt/kq-target/baseline/hello
COPY deploy/pr-test/spack-targets/probe.py /opt/kq-target/probe.py
RUN mkdir -p /delivery /work \
  && chown 1000:1000 /delivery /work \
  && chown -R 1000:1000 /opt/kq-case/upstream

ENV PATH=/opt/kq-python/bin:/opt/spack/bin:/usr/local/bin:/usr/bin:/bin \
    SPACK_PYTHON=/opt/kq-python/bin/python3.11 \
    SPACK_DISABLE_LOCAL_CONFIG=1 \
    SPACK_USER_CONFIG_PATH=/work/user-config \
    SPACK_USER_CACHE_PATH=/work/user-cache \
    PYTHONDONTWRITEBYTECODE=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    HOME=/work/home \
    LC_ALL=C \
    KQ_TARGET_PROFILE=${TARGET_PROFILE}
USER 1000:1000
WORKDIR /work

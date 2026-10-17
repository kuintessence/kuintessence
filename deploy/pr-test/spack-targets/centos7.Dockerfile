FROM quay.io/centos/centos:7

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# EOL compatibility fixture only. Keep TLS and RPM signature verification enabled.
RUN printf '%s\n' \
      '[kq-base]' 'name=CentOS 7 archive' \
      'baseurl=https://vault.centos.org/7.9.2009/os/x86_64/' \
      'enabled=0' 'gpgcheck=1' 'sslverify=1' \
      'gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-CentOS-7' \
      '[kq-updates]' 'name=CentOS 7 updates archive' \
      'baseurl=https://vault.centos.org/7.9.2009/updates/x86_64/' \
      'enabled=0' 'gpgcheck=1' 'sslverify=1' \
      'gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-CentOS-7' \
      > /etc/yum.repos.d/kq-vault.repo \
  && yum --disablerepo='*' --enablerepo=kq-base,kq-updates -y install \
      ca-certificates curl git gcc gcc-c++ make perl-core \
      curl-devel expat-devel openssl-devel gettext \
      zlib-devel bzip2-devel xz-devel libffi-devel sqlite-devel readline-devel \
      tar gzip bzip2 xz patch diffutils findutils which file \
  && yum --disablerepo='*' --enablerepo=kq-base,kq-updates clean all \
  && useradd --uid 1000 --create-home kq

ENV SSL_CERT_FILE=/etc/pki/tls/certs/ca-bundle.crt
COPY deploy/pr-test/spack-targets/bootstrap.sh deploy/pr-test/spack-targets/requirements.txt /opt/kq-target/
RUN KQ_BOOTSTRAP_GIT=1 bash /opt/kq-target/bootstrap.sh
COPY deploy/pr-test/spack-case/prepare.py /opt/kq-target/baseline/prepare.py
COPY deploy/pr-test/spack-case/hello /opt/kq-target/baseline/hello
COPY deploy/pr-test/spack-targets/probe.py /opt/kq-target/probe.py
RUN mkdir -p /delivery /work \
  && chown 1000:1000 /delivery /work \
  && chown -R 1000:1000 /opt/kq-case/upstream

ENV PATH=/opt/kq-git/bin:/opt/kq-python/bin:/opt/spack/bin:/usr/local/bin:/usr/bin:/bin \
    SPACK_PYTHON=/opt/kq-python/bin/python3.11 \
    SPACK_DISABLE_LOCAL_CONFIG=1 \
    SPACK_USER_CONFIG_PATH=/work/user-config \
    SPACK_USER_CACHE_PATH=/work/user-cache \
    PYTHONDONTWRITEBYTECODE=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    HOME=/work/home \
    LC_ALL=C \
    KQ_TARGET_PROFILE=centos7
USER 1000:1000
WORKDIR /work

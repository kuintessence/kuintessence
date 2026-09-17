FROM scheduler-base

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=""
ARG OPENPBS_REF=v23.06.06

RUN if [[ -n "${APT_MIRROR}" ]]; then sed -i "s|http://ports.ubuntu.com/ubuntu-ports|${APT_MIRROR}|g" /etc/apt/sources.list; fi \
  && apt-get update && apt-get install -y --no-install-recommends \
    autoconf \
    automake \
    build-essential \
    expat \
    g++ \
    gcc \
    libedit-dev \
    libedit2 \
    libexpat-dev \
    libhwloc-dev \
    libical-dev \
    libncurses-dev \
    libpam0g-dev \
    libpq-dev \
    libssl-dev \
    libtool \
    libx11-dev \
    libxext-dev \
    libxft-dev \
    libxt-dev \
    net-tools \
    perl \
    pkg-config \
    postgresql \
    postgresql-contrib \
    postgresql-server-dev-all \
    python3-dev \
    sendmail-bin \
    swig \
    tcl-dev \
    tk-dev \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /tmp/openpbs \
  && for attempt in 1 2 3 4 5; do \
    curl -fsSL "https://github.com/openpbs/openpbs/archive/refs/tags/${OPENPBS_REF}.tar.gz" -o /tmp/openpbs.tar.gz && break; \
    if [[ "${attempt}" == "5" ]]; then exit 1; fi; \
    sleep 3; \
  done \
  && tar -xzf /tmp/openpbs.tar.gz --strip-components=1 -C /tmp/openpbs \
  && rm -f /tmp/openpbs.tar.gz \
  && cd /tmp/openpbs \
  && ./autogen.sh \
  && ./configure --prefix=/opt/pbs --with-python=/usr \
  && make -j"$(nproc)" \
  && make install \
  && rm -rf /tmp/openpbs \
  && mkdir -p /var/lib/kuintessence

ENV PBS_EXEC=/opt/pbs
ENV PBS_HOME=/var/spool/pbs
ENV PATH=/opt/pbs/bin:/opt/pbs/sbin:/opt/spack/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

COPY common/start-agent.sh /usr/local/bin/kq-start-agent
COPY common/install-agent-deps.sh /usr/local/bin/kq-install-agent-deps
COPY common/register-agent.sh /usr/local/bin/kq-register-compose-agent
COPY pbs/entrypoint.sh /usr/local/bin/kq-pbs-entrypoint

RUN chmod +x /usr/local/bin/kq-start-agent /usr/local/bin/kq-install-agent-deps /usr/local/bin/kq-register-compose-agent /usr/local/bin/kq-pbs-entrypoint

ENTRYPOINT ["tini", "--", "/usr/local/bin/kq-pbs-entrypoint"]

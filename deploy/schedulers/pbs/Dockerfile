ARG SCHEDULER_BASE_IMAGE=scheduler-base
FROM ${SCHEDULER_BASE_IMAGE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=""
# Pin the official GitHub tag archive before extracting build inputs.
ARG OPENPBS_REF=v23.06.06
ARG OPENPBS_SHA256=""
ARG BUILD_JOBS=1

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
  && if [[ -z "${OPENPBS_SHA256}" ]]; then \
    case "${OPENPBS_REF}" in \
      v23.06.06) OPENPBS_SHA256=689df6caa101422237118d81f9cfb0e6cad432209c77a6b3b8021cf984a91a90 ;; \
      *) echo "set OPENPBS_SHA256 for this OpenPBS ref" >&2; exit 1 ;; \
    esac; \
  fi \
  && for attempt in 1 2 3 4 5; do \
    curl -fsSL "https://github.com/openpbs/openpbs/archive/refs/tags/${OPENPBS_REF}.tar.gz" -o /tmp/openpbs.tar.gz && break; \
    if [[ "${attempt}" == "5" ]]; then exit 1; fi; \
    sleep 3; \
  done \
  && echo "${OPENPBS_SHA256}  /tmp/openpbs.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/openpbs.tar.gz --strip-components=1 -C /tmp/openpbs \
  && rm -f /tmp/openpbs.tar.gz \
  && cd /tmp/openpbs \
  && ./autogen.sh \
  && ./configure --prefix=/opt/pbs --with-python=/usr \
  && make -j"${BUILD_JOBS}" \
  && make install \
  && rm -rf /tmp/openpbs \
  && mkdir -p /var/lib/kuintessence

ENV PBS_EXEC=/opt/pbs
ENV PBS_HOME=/var/spool/pbs
ENV PATH=/opt/pbs/bin:/opt/pbs/sbin:/opt/spack/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

COPY common/start-agent.sh /usr/local/bin/kq-start-agent
COPY common/install-agent-deps.sh /usr/local/bin/kq-install-agent-deps
COPY common/register-agent.sh /usr/local/bin/kq-register-compose-agent
COPY common/scheduler-capacity.py /usr/local/bin/kq-scheduler-capacity.py
COPY pbs/entrypoint.sh /usr/local/bin/kq-pbs-entrypoint

RUN chmod +x /usr/local/bin/kq-start-agent /usr/local/bin/kq-install-agent-deps /usr/local/bin/kq-register-compose-agent /usr/local/bin/kq-pbs-entrypoint

ENTRYPOINT ["tini", "--", "/usr/local/bin/kq-pbs-entrypoint"]

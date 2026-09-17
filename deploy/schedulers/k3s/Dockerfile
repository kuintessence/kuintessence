FROM scheduler-base

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=""
ARG K3S_VERSION=v1.31.6+k3s1
ARG TARGETOS
ARG TARGETARCH

RUN if [[ -n "${APT_MIRROR}" ]]; then sed -i "s|http://ports.ubuntu.com/ubuntu-ports|${APT_MIRROR}|g" /etc/apt/sources.list; fi \
  && apt-get update && apt-get install -y --no-install-recommends \
    iptables \
    kmod \
    mount \
    util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && architecture="${TARGETARCH:-$(dpkg --print-architecture)}" \
  && case "${architecture}" in \
    amd64) k3s_asset="k3s" ;; \
    arm64) k3s_asset="k3s-arm64" ;; \
    *) echo "Unsupported K3s architecture: ${architecture}" >&2; exit 1 ;; \
  esac \
  && for attempt in 1 2 3 4 5; do \
    curl -fsSL "https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION}/${k3s_asset}" -o /usr/local/bin/k3s && break; \
    if [[ "${attempt}" == "5" ]]; then exit 1; fi; \
    sleep 3; \
  done \
  && chmod +x /usr/local/bin/k3s \
  && /usr/local/bin/kq-verify-architecture /usr/local/bin/bun /usr/local/bin/k3s \
  && ln -sf /usr/local/bin/k3s /usr/local/bin/kubectl \
  && mkdir -p /etc/rancher/k3s /var/lib/rancher/k3s /var/lib/kuintessence

ENV KUBECONFIG=/etc/rancher/k3s/k3s.yaml

COPY common/start-agent.sh /usr/local/bin/kq-start-agent
COPY common/install-agent-deps.sh /usr/local/bin/kq-install-agent-deps
COPY common/register-agent.sh /usr/local/bin/kq-register-compose-agent
COPY k3s/entrypoint.sh /usr/local/bin/kq-k3s-entrypoint

RUN chmod +x /usr/local/bin/kq-start-agent /usr/local/bin/kq-install-agent-deps /usr/local/bin/kq-register-compose-agent /usr/local/bin/kq-k3s-entrypoint

ENTRYPOINT ["tini", "--", "/usr/local/bin/kq-k3s-entrypoint"]

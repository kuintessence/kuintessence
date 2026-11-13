FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bash \
    && rm -rf /var/lib/apt/lists/*
# The deployment CLI uses the same verified release as the real-network CI.
RUN curl -fsSL --connect-timeout 15 --max-time 180 --retry 3 https://github.com/hyperledger/fabric/releases/download/v3.1.5/hyperledger-fabric-linux-amd64-3.1.5.tar.gz -o /tmp/fabric.tar.gz \
    && echo 'b9c31fd490991e76f8acb1835dee09fc19fee5428cb13e190ee6e0bdd2c37858  /tmp/fabric.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/fabric.tar.gz -C /usr/local bin config \
    && rm /tmp/fabric.tar.gz
ENV FABRIC_CFG_PATH=/usr/local/config
COPY deploy/federation/fabric-init.sh /usr/local/bin/kq-fabric-init
ENTRYPOINT ["bash", "/usr/local/bin/kq-fabric-init"]

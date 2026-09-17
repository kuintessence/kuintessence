FROM kuintessence/scheduler-base:local

RUN spack install zlib@1.3.1

ENTRYPOINT ["/bin/sh", "-c"]

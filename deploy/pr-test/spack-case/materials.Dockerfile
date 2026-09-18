FROM scheduler-base AS materials

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN python3 -m pip install --no-cache-dir clingo==5.7.1 \
  && mkdir -p /opt/kq-case/upstream \
  && curl --fail --location --retry 5 \
    https://github.com/spack/spack-packages/archive/32c54f0906004d7fd1f72fd1b5970bf2bf094e26.tar.gz \
    | tar -xz --strip-components=1 -C /opt/kq-case/upstream
COPY deploy/pr-test/spack-case /workspace/deploy/pr-test/spack-case
RUN spack python /workspace/deploy/pr-test/spack-case/prepare.py /case

FROM test-workspace
COPY --from=materials /case /opt/kq-case

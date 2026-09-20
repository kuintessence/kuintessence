FROM scheduler-base AS materials

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV GIT_TERMINAL_PROMPT=0 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1
RUN python3 -m pip install --no-cache-dir clingo==5.7.1 \
  && git init /opt/kq-case/upstream \
  && git -C /opt/kq-case/upstream -c fetch.fsckObjects=true fetch --depth=1 --no-tags \
    https://github.com/spack/spack-packages.git 32c54f0906004d7fd1f72fd1b5970bf2bf094e26 \
  && git -C /opt/kq-case/upstream checkout --detach 32c54f0906004d7fd1f72fd1b5970bf2bf094e26
COPY deploy/pr-test/spack-case /workspace/deploy/pr-test/spack-case
RUN spack python /workspace/deploy/pr-test/spack-case/prepare.py /case

FROM test-workspace
COPY --from=materials /case /opt/kq-case

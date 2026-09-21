FROM scheduler-runtime

COPY --from=test-workspace /workspace /workspace
COPY scheduler-entrypoint.sh /usr/local/bin/kq-pr-scheduler-entrypoint
ENV GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1
WORKDIR /workspace

RUN test "$(spack --version)" = "1.0.0" \
  && test -d node_modules/pino \
  && test -d node_modules/ssh2 \
  && test -e node_modules/@kuintessence/db

ENTRYPOINT ["tini", "--", "/bin/bash", "/usr/local/bin/kq-pr-scheduler-entrypoint"]

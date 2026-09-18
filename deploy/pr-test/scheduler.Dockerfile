FROM scheduler-runtime

COPY --from=test-workspace /workspace /workspace
ENV GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1
WORKDIR /workspace

RUN test "$(spack --version)" = "1.0.0" \
  && test -d node_modules/pino \
  && test -d node_modules/ssh2 \
  && test -e node_modules/@kuintessence/db

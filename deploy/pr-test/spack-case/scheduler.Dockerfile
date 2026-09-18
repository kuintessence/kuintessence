FROM scheduler-runtime

COPY --from=test-workspace /workspace /workspace
ENV GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1
WORKDIR /workspace

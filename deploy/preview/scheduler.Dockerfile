FROM scheduler-runtime

COPY --from=preview-workspace /workspace /workspace
# Recipes and source materials must be imported through the platform.
RUN printf 'repos:: {}\n' > /opt/spack/etc/spack/repos.yaml
ENV GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1
WORKDIR /workspace

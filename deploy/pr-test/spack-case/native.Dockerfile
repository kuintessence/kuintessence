FROM scheduler-base

COPY --from=test-workspace /workspace /workspace
COPY deploy/pr-test/spack-case/empty-config/repos.yaml /opt/spack/etc/spack/repos.yaml
RUN python3 -m pip install --no-cache-dir clingo==5.7.1 \
  && rm /etc/sudoers.d/kq
ENV PYTHONDONTWRITEBYTECODE=1 \
    SPACK_DISABLE_LOCAL_CONFIG=1 \
    SPACK_USER_CONFIG_PATH=/tmp/spack-config \
    SPACK_USER_CACHE_PATH=/tmp/spack-cache \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1
USER kq
WORKDIR /workspace

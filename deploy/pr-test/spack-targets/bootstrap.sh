#!/usr/bin/env bash
set -Eeuo pipefail
stage=platform
trap 'printf "Target bootstrap: stage=%s code=FAILED\n" "$stage" >&2' ERR
[[ "$(uname -m)" == x86_64 ]]
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
  curl --fail --location --silent --show-error --retry 3 \
    --proto '=https' --tlsv1.2 --connect-timeout 30 --max-time 300 "$1" -o "$2"
  printf '%s  %s\n' "$3" "$2" | sha256sum --check --status
}

bootstrap_git() {
  stage=git
  fetch https://www.kernel.org/pub/software/scm/git/git-2.43.7.tar.xz \
    "$work/git.tar.xz" 657e2374455d9e62f6cdb3e7c55d867b6db5404d744e97e112cc5b0db687a19f
  mkdir "$work/git"
  tar -xJf "$work/git.tar.xz" --strip-components=1 -C "$work/git"
  (
    cd "$work/git"
    make -j2 prefix=/opt/kq-git NO_TCLTK=YesPlease all
    make prefix=/opt/kq-git NO_TCLTK=YesPlease install
  ) >"$work/git-build.log" 2>&1
  export PATH="/opt/kq-git/bin:$PATH"
  [[ "$(git --version)" == "git version 2.43.7" ]]
  printf 'Target bootstrap: stage=%s code=OK\n' "$stage"
}

bootstrap_tools() {
  stage=openssl
  fetch https://github.com/openssl/openssl/releases/download/openssl-3.5.8/openssl-3.5.8.tar.gz \
    "$work/openssl.tar.gz" a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2
  mkdir "$work/openssl"
  tar -xzf "$work/openssl.tar.gz" --strip-components=1 -C "$work/openssl"
  (
    cd "$work/openssl"
    ./config --prefix=/opt/kq-openssl --libdir=lib --openssldir=/etc/ssl shared
    make -j2
    make install_sw
  ) >"$work/openssl-build.log" 2>&1
  printf 'Target bootstrap: stage=%s code=OK\n' "$stage"

  stage=python
  # Version/checksum from docker-library/python commit fe89472bda6128fef7e964d1f1991534e32dcfb7.
  fetch https://www.python.org/ftp/python/3.11.16/Python-3.11.16.tar.xz \
    "$work/python.tar.xz" 91bcdebfdde239a003ae93738a7fce0f9230fee5c4bc2b86f6e6e8c6f98aabe8
  mkdir "$work/python"
  tar -xJf "$work/python.tar.xz" --strip-components=1 -C "$work/python"
  (
    cd "$work/python"
    ./configure --prefix=/opt/kq-python --with-openssl=/opt/kq-openssl \
      --with-openssl-rpath=auto --with-ensurepip=install
    make -j2
    make install
  ) >"$work/python-build.log" 2>&1
  /opt/kq-python/bin/python3.11 -c \
    'import ssl, sys, bz2, ctypes, lzma, sqlite3, zlib; assert sys.version_info[:3] == (3, 11, 16); assert ssl.OPENSSL_VERSION.startswith("OpenSSL 3.5.8 ")'
  printf 'Target bootstrap: stage=%s code=OK\n' "$stage"

  stage=solver
  /opt/kq-python/bin/python3.11 -m pip --isolated install \
    --disable-pip-version-check --no-cache-dir --only-binary=:all: --require-hashes \
    -r /opt/kq-target/requirements.txt
  /opt/kq-python/bin/python3.11 -c 'import clingo, clingo.ast; assert clingo.__version__ == "5.7.1"'
  printf 'Target bootstrap: stage=%s code=OK\n' "$stage"
}

checkout() {
  git init "$1"
  (
    cd "$1"
    result=0
    git -c fetch.fsckObjects=true fetch --depth=1 --no-tags "$2" "$3" \
      >"$work/git-fetch.log" 2>&1 || result=$?
    if [[ "$result" -ne 0 ]]; then
      reason=other
      if grep -Eiq 'unadvertised object|not our ref' "$work/git-fetch.log"; then
        reason=unadvertised-object
      elif grep -Eiq 'couldn.t find remote ref|no such remote ref' "$work/git-fetch.log"; then
        reason=missing-ref
      elif grep -Eiq 'certificate|SSL|TLS' "$work/git-fetch.log"; then
        reason=tls
      elif grep -Eiq 'resolve host|timed out|connection|RPC failed|early EOF' "$work/git-fetch.log"; then
        reason=transport
      fi
      printf 'Target checkout: component=%s error=%s code=FAILED\n' "$stage" "$reason" >&2
      for hint in shallow protocol usage unknown unsupported upgrade client server \
          fsck object index-pack fetch-pack pack corrupt signature hash sha1 \
          permission denied fork memory file directory version command helper \
          fatal error invalid access remote ref option parent graft missing sorted tree child; do
        if grep -Fiq -- "$hint" "$work/git-fetch.log"; then
          printf 'Target checkout hint: component=%s hint=%s code=FOUND\n' "$stage" "$hint" >&2
        fi
      done
      printf 'Target checkout exit: component=%s status=%s code=FAILED\n' "$stage" "$result" >&2
      exit 1
    fi
    git checkout --detach FETCH_HEAD
    if [[ "$(git rev-parse HEAD)" != "$3" ]]; then
      printf 'Target checkout: component=%s error=commit-mismatch code=FAILED\n' "$stage" >&2
      exit 1
    fi
  )
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${KQ_BOOTSTRAP_GIT:-0}" == 1 ]]; then
    bootstrap_git
  fi
  stage=spack
  checkout /opt/spack https://github.com/spack/spack.git \
    73eaea13f381e3495299284856fd02a64e1d154c
  printf 'Target bootstrap: stage=%s code=OK\n' "$stage"
  stage=recipes
  # Existing reviewed preparation helpers verify every selected upstream blob.
  checkout /opt/kq-case/upstream https://github.com/spack/spack-packages.git \
    32c54f0906004d7fd1f72fd1b5970bf2bf094e26
  printf 'Target bootstrap: stage=%s code=OK\n' "$stage"
  bootstrap_tools
fi

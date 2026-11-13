#!/usr/bin/env bash
# Called only inside the disposable HPC lab Pod, never on the operator's host.
set -euo pipefail
[[ "${KQ_MEDIA_HPC_LAB:-}" == 1 ]] || { echo 'Use the isolated HPC lab runner' >&2; exit 2; }
pbs_source="${1:?OpenPBS source archive required}"
printf '%s  %s\n' 297ea4d5933e867b51366b213184a5251a41261f16079ffde86511e0bbc6606c "${pbs_source}" | sha256sum --check -
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends autoconf automake build-essential libedit-dev libexpat-dev libhwloc-dev libical-dev libncurses-dev libpam0g-dev libpq-dev libssl-dev libtool libx11-dev libxext-dev libxft-dev libxt-dev perl pkg-config postgresql postgresql-contrib postgresql-server-dev-all python3-dev swig tcl-dev tk-dev
pbs_build="$(mktemp -d /tmp/kq-openpbs.XXXXXX)"
trap 'rm -rf "${pbs_build}"' EXIT
tar xzf "${pbs_source}" --strip-components=1 -C "${pbs_build}"
cd "${pbs_build}"
./autogen.sh
./configure --prefix=/opt/pbs --with-python=/usr
make -j2
make install
/opt/pbs/bin/qsub --version

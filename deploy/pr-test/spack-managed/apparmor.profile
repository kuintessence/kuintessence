# Based on Apptainer v1.4.3 dist/debian/apparmor-userns.
# CI-only, non-setuid starter; removed when the dedicated Actions job finishes.
abi <abi/4.0>,
include <tunables/global>

profile kq-pr-apptainer /usr/libexec/apptainer/bin/starter flags=(unconfined) {
  userns,
}

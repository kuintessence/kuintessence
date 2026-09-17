#!/bin/sh
set -eu

ORIGIN="${CASDOOR_ORIGIN:-${SSO_BOOTSTRAP_ISSUER_URL:-${KQ_CASDOOR_BOOTSTRAP_ISSUER_URL:-${KQ_SCHEDULER_CASDOOR_BOOTSTRAP_ISSUER_URL:-${CASDOOR_DEFAULT_ORIGIN:-http://casdoor.localhost:15180}}}}}"

app_conf_template="${CASDOOR_APP_CONF_TEMPLATE:-/conf/app.conf.template}"
app_conf="/conf/app.conf"

if [ -f "$app_conf_template" ]; then
  awk -v origin="$ORIGIN" '
    BEGIN { found = 0 }
    /^origin = / {
      print "origin = " origin
      found = 1
      next
    }
    { print }
    END {
      if (found == 0) {
        print "origin = " origin
      }
    }
  ' "$app_conf_template" > "$app_conf"
elif [ -f "$app_conf" ]; then
  awk -v origin="$ORIGIN" '
    BEGIN { found = 0 }
    /^origin = / {
      print "origin = " origin
      found = 1
      next
    }
    { print }
    END {
      if (found == 0) {
        print "origin = " origin
      }
    }
  ' "$app_conf" > "${app_conf}.tmp"
  mv "${app_conf}.tmp" "$app_conf"
fi

exec /server "$@"

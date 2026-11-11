#!/usr/bin/env python3
"""Read the CLI registration bundle as data, never as shell instructions."""
import json
import os
from pathlib import Path
import sys

path = Path(os.environ["KQ_AGENT_ENV_FILE"])
registration = {}
for line in path.read_text().splitlines():
    key, value = line.split("=", 1)
    if key not in {"SERVER_GRPC_URL", "SERVER_HTTP_URL", "AGENT_ID", "AGENT_SITE_NAME",
                   "AGENT_SCHEDULER_TYPE", "AGENT_SCHEDULER_VERSION", "AGENT_MTLS_REQUIRED",
                   "AGENT_CERT_DIR", "AGENT_DB_PATH"} or key in registration:
        raise SystemExit("Invalid registration bundle")
    registration[key] = json.loads(value)
if registration.get("AGENT_ID") != os.environ["AGENT_ID"]:
    raise SystemExit("Registration belongs to a different Agent")
if registration.get("SERVER_HTTP_URL") != os.environ["SERVER_HTTP_URL"]:
    raise SystemExit("Registration belongs to a different Server")
if registration.get("SERVER_GRPC_URL") != os.environ["SERVER_GRPC_URL"]:
    raise SystemExit("Registration belongs to a different RPC endpoint")
os.environ.update(registration)
os.execv(sys.executable, [sys.executable, "/usr/local/bin/kq-supervise-agent.py"])

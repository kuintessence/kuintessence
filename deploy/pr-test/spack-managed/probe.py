"""Test-only invocation of the unchanged production runtime boundary verifier."""
from pathlib import Path
import sys

sys.path.insert(0, "/kq/input")
import boundary

try:
    boundary.verify_runtime_boundary(Path("/kq/input"))
    print("managed-runtime-boundary-ok")
except (Exception, SystemExit) as error:
    # No exception messages, environment, input paths or native logs.
    print("managed-runtime-boundary-failed:" + type(error).__name__)
    raise SystemExit(1) from None

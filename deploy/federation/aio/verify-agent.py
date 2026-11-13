#!/usr/bin/env python3
"""Bind the installed Agent binary to the Server build's immutable manifest."""
import hashlib
import json
from pathlib import Path
import re
import sys


def verify(binary, manifest, revision):
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("A fixed Agent build revision is required")
    value = json.loads(manifest.read_text())
    entries = [entry for entry in value["files"] if entry["target"] == "bun-linux-x64"]
    if value["version"] != 1 or value["revision"] != revision or len(entries) != 1:
        raise ValueError("Agent build provenance mismatch")
    entry = entries[0]
    contents = binary.read_bytes()
    if (entry["name"] != "kq-agent-bun-linux-x64" or type(entry["size"]) is not int
            or len(contents) != entry["size"] or hashlib.sha256(contents).hexdigest() != entry["sha256"]):
        raise ValueError("Agent binary does not match its build manifest")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: verify-agent.py <full-revision>")
    verify(Path("/usr/local/bin/kq-agent"),
           Path("/usr/local/share/kuintessence/agent-manifest.json"), sys.argv[1])

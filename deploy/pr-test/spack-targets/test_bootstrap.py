"""Actions-only checkout contracts using a Git stub; never fetch or build."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


BOOTSTRAP = Path(__file__).with_name("bootstrap.sh").resolve()
COMMIT = "a" * 40
PARENT_ERROR = f"error: object {COMMIT}:parent objects missing"
GRAFT_ERROR = f"error: object {COMMIT}:graft objects missing"
PROTOCOL_ERROR = "fatal: git fetch-pack: expected shallow list"
UNSAFE = "UNSAFE_RAW_LOG_DO_NOT_PUBLISH"

GIT_STUB = r"""
import json
import os
from pathlib import Path
import sys

root = Path(os.environ["STUB_ROOT"])
args = sys.argv[1:]
with (root / "calls.jsonl").open("a") as stream:
    stream.write(json.dumps(args) + "\n")
if args[:2] == ["-c", "fetch.fsckObjects=true"]:
    args = args[2:]
if args[0] == "init":
    (Path(args[1]) / ".git").mkdir(parents=True)
elif args[0] == "fetch":
    counter = root / "fetch-count"
    count = int(counter.read_text()) + 1 if counter.exists() else 1
    counter.write_text(str(count))
    message = os.environ.get("STUB_FIRST_ERROR" if count == 1 else "STUB_SECOND_ERROR", "")
    if message:
        print(message, file=sys.stderr)
        print("UNSAFE_RAW_LOG_DO_NOT_PUBLISH", file=sys.stderr)
        sys.exit(128)
elif args[0] == "checkout":
    assert args == ["checkout", "--detach", "FETCH_HEAD"]
elif args[0] == "rev-parse":
    assert args == ["rev-parse", "HEAD"]
    print(os.environ.get("STUB_HEAD", "a" * 40))
else:
    sys.exit(99)
"""


class CheckoutTests(unittest.TestCase):
    def invoke(self, **overrides: str):
        with tempfile.TemporaryDirectory(prefix="kq-target-bootstrap-test-") as directory:
            root = Path(directory).resolve()
            binary = root / "bin"
            binary.mkdir()
            (root / "tmp").mkdir()
            git = binary / "git"
            git.write_text(f"#!{sys.executable}\n" + GIT_STUB)
            git.chmod(0o700)
            for name in ("curl", "make", "tar"):
                forbidden = binary / name
                forbidden.write_text("#!/bin/sh\nexit 99\n")
                forbidden.chmod(0o700)
            result = subprocess.run(
                [
                    shutil.which("bash"), "-c",
                    'source "$1"; stage=spack; checkout "$2" '
                    '"https://example.invalid/repo.git" "$3"',
                    "checkout-test", str(BOOTSTRAP), str(root / "checkout"), COMMIT,
                ],
                env={
                    "PATH": str(binary) + os.pathsep + os.defpath,
                    "HOME": str(root), "TMPDIR": str(root / "tmp"), "STUB_ROOT": str(root),
                    **overrides,
                },
                text=True, capture_output=True, timeout=15,
            )
            calls = [json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()]
            self.assertEqual(list((root / "tmp").iterdir()), [])
            self.assertNotIn(UNSAFE, result.stdout + result.stderr)
            self.assertNotIn("Target bootstrap: stage=openssl", result.stdout + result.stderr)
            return result, calls

    def test_success_uses_shallow_fetch_with_integrity_check(self):
        result, calls = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        fetches = [call for call in calls if "fetch" in call]
        self.assertEqual(len(fetches), 1)
        self.assertEqual(fetches[0], [
            "-c", "fetch.fsckObjects=true", "fetch", "--depth=1", "--no-tags",
            "https://example.invalid/repo.git", COMMIT,
        ])
        self.assertIn(["rev-parse", "HEAD"], calls)

    def test_object_and_transport_failures_do_not_retry_or_checkout(self):
        for error in (
            PARENT_ERROR, GRAFT_ERROR, PROTOCOL_ERROR,
            PARENT_ERROR + " unexpected", "prefix " + PARENT_ERROR,
            PARENT_ERROR.replace(COMMIT, "z" * 40),
            PROTOCOL_ERROR + " unexpected", "fatal: bad object", UNSAFE,
        ):
            with self.subTest(error=error):
                result, calls = self.invoke(STUB_FIRST_ERROR=error)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("code=RETRY", result.stdout)
                self.assertEqual(len([call for call in calls if "fetch" in call]), 1)
                self.assertFalse(any(call[0] == "checkout" for call in calls))

    def test_tls_failure_is_classified_without_raw_logs(self):
        result, calls = self.invoke(STUB_FIRST_ERROR="fatal: SSL certificate verification failed")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error=tls code=FAILED", result.stderr)
        self.assertEqual(len([call for call in calls if "fetch" in call]), 1)
        self.assertFalse(any(call[0] == "checkout" for call in calls))

    def test_commit_mismatch_fails_after_fetch(self):
        result, calls = self.invoke(STUB_HEAD="b" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error=commit-mismatch code=FAILED", result.stderr)
        self.assertIn(["rev-parse", "HEAD"], calls)


if __name__ == "__main__":
    unittest.main()

"""Actions-only runner contracts; Docker is always replaced by a stdlib stub."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest


RUNNER = Path(__file__).with_name("run.sh").resolve()
ROOT = RUNNER.parents[3]
IMAGE_ID = "sha256:" + "a" * 64
RAW_LOG = "UNSAFE_RAW_LOG_DO_NOT_PUBLISH"

DOCKER_STUB = r"""
import json
import os
from pathlib import Path
import signal
import sys

root = Path(os.environ["STUB_ROOT"])
args = sys.argv[1:]
assert args[:2] == ["--host", "unix:///var/run/docker.sock"]
args = args[2:]
with (root / "calls.jsonl").open("a", encoding="utf-8") as stream:
    stream.write(json.dumps(args) + "\n")
state_path = root / "state.json"
state = json.loads(state_path.read_text()) if state_path.exists() else {
    "containers": {}, "volumes": [], "images": [],
}
failure = os.environ.get("STUB_FAILURE", "")
command = " ".join(args[:2])
phase = args[-1].rsplit("-", 1)[-1]
if args[0] == "start" and failure == "signal-" + phase:
    os.kill(os.getppid(), signal.SIGTERM)
    sys.exit(0)
if (
    (failure == "build" and args[0] == "build")
    or (failure in {"volume create", "container inspect"} and failure == command)
    or (args[0] == "start" and failure == "start-" + phase)
    or (args[0] == "create" and failure == "create-" + args[-3])
    or (failure == "cleanup" and command == "container rm")
):
    print("UNSAFE_RAW_LOG_DO_NOT_PUBLISH", file=sys.stderr)
    if args[0] == "build":
        print("#8 1.234 Target bootstrap: stage=openssl code=FAILED")
        print("#8 1.235 Target bootstrap: stage=UNSAFE_RAW_LOG_DO_NOT_PUBLISH code=FAILED")
        print("#8 1.236 Target checkout: component=spack error=missing-ref code=FAILED")
        print("#8 1.237 Target checkout: component=spack error=UNSAFE_RAW_LOG_DO_NOT_PUBLISH code=FAILED")
    if args[0] == "start":
        created = state["containers"][args[-1]]
        print(f"Target probe: phase={created[-3]} profile={created[-2]} "
              "stage=platform code=FAILED")
    sys.exit(1)

def option(name):
    return args[args.index(name) + 1]

if command == "container ls":
    names = list(state["containers"])
    if "--filter" in args:
        exact = option("--filter").removeprefix("name=^/").removesuffix("$")
        names = [name for name in names if name == exact]
    print("\n".join(names))
elif command == "volume ls":
    names = state["volumes"]
    if "--filter" in args:
        exact = option("--filter").removeprefix("name=^").removesuffix("$")
        names = [name for name in names if name == exact]
    print("\n".join(names))
elif command == "image ls":
    names = state["images"]
    if "--quiet" in args:
        names = [name for name in names if name == args[-1]]
    print("\n".join(names))
elif args[0] == "build":
    Path(option("--iidfile")).write_text(
        "invalid" if failure == "image-identity" else "sha256:" + "a" * 64
    )
    state["images"].append(option("--tag"))
    print("UNSAFE_RAW_LOG_DO_NOT_PUBLISH")
    print("#8 1.234 Target bootstrap: stage=recipes code=OK")
elif command == "volume create":
    state["volumes"].append(args[-1])
elif args[0] == "create":
    name = option("--name")
    assert name not in state["containers"]
    state["containers"][name] = args
elif command == "container inspect":
    created = state["containers"][args[-1]]
    def created_option(name):
        return created[created.index(name) + 1]
    mount = dict(
        field.split("=", 1) for field in created_option("--mount").split(",")
        if "=" in field
    )
    info = {
        "Image": created[-6],
        "Config": {"User": created_option("--user")},
        "State": {"Status": "created"},
        "HostConfig": {
            "NetworkMode": created_option("--network"),
            "ReadonlyRootfs": "--read-only" in created,
            "CapDrop": [created_option("--cap-drop")],
            "SecurityOpt": [created_option("--security-opt")],
            "NanoCpus": 2_000_000_000,
            "Memory": 4 * 1024**3,
            "PidsLimit": int(created_option("--pids-limit")),
            "Tmpfs": {"/tmp": "", "/work": ""},
        },
        "Mounts": [{
            "Type": "volume", "Name": mount["src"],
            "Destination": mount["dst"],
            "RW": "readonly" not in created_option("--mount").split(","),
        }],
    }
    if failure == "network":
        info["HostConfig"]["NetworkMode"] = "bridge"
    elif failure == "readonly":
        info["Mounts"][0]["RW"] = True
    elif failure == "mount-name":
        info["Mounts"][0]["Name"] = "unrelated-volume"
    elif failure == "mount-type":
        info["Mounts"][0]["Type"] = "bind"
    elif failure == "extra-mount":
        info["Mounts"].append({"Type": "bind", "Destination": "/store"})
    elif failure == "image":
        info["Image"] = "sha256:" + "b" * 64
    elif failure == "user":
        info["Config"]["User"] = "0:0"
    elif failure == "inspect-json":
        print("UNSAFE_RAW_LOG_DO_NOT_PUBLISH")
        sys.exit(0)
    print(json.dumps([info]))
elif args[0] == "start":
    assert args[-1] in state["containers"]
    created = state["containers"][args[-1]]
    phase, profile = created[-3:-1]
    targets = {"centos7": "centos7", "ubuntu24": "ubuntu24.04", "ubuntu26": "ubuntu26.04"}
    print("UNSAFE_RAW_LOG_DO_NOT_PUBLISH")
    print("::warning::UNSAFE_RAW_LOG_DO_NOT_PUBLISH")
    print(f"Target probe: phase={phase} profile={profile} stage=secret code=OK")
    print(f"Target probe: phase=unknown profile={profile} stage=complete code=OK")
    print(f"Target identity: profile={profile} target=linux-wrong-x86_64 "
          "gcc=999 python=3.11.16 spack=1.0.0 code=OK")
    print(f"Target identity: profile={profile} target=linux-{targets[profile]}-x86_64 "
          "gcc=UNSAFE_RAW_LOG_DO_NOT_PUBLISH python=3.11.16 spack=1.0.0 code=OK")
    if failure != "missing-identity":
        print(f"Target identity: profile={profile} target=linux-{targets[profile]}-x86_64 "
              "gcc=12.3.0 python=3.11.16 spack=1.0.0 code=OK")
    print(f"Target probe: phase={phase} profile={profile} stage=platform code=OK")
    print(f"Target probe: phase={phase} profile={profile} stage=resolve code=RUNNING")
    print(f"Target diagnostic: phase={phase} profile={profile} error=KeyError line=345")
    print(f"Target diagnostic: phase={phase} profile={profile} error=UNSAFE_RAW_LOG_DO_NOT_PUBLISH line=345")
    if failure != "missing-complete":
        print(f"Target probe: phase={phase} profile={profile} stage=complete code=OK")
    if failure == "failed-marker":
        print(f"Target probe: phase={phase} profile={profile} stage=execute code=FAILED")
elif command == "container rm":
    if args[-1] not in state["containers"]:
        sys.exit(1)
    state["containers"].pop(args[-1])
elif command == "volume rm":
    if args[-1] not in state["volumes"]:
        sys.exit(1)
    state["volumes"].remove(args[-1])
elif command == "image rm":
    if args[-1] not in state["images"]:
        sys.exit(1)
    state["images"].remove(args[-1])
else:
    print("UNEXPECTED_DOCKER_COMMAND", file=sys.stderr)
    sys.exit(2)
state_path.write_text(json.dumps(state))
"""


class RunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="kq-target-runner-test-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.runner_temp = self.base / "runner-temp"
        self.runner_temp.mkdir()
        stub = self.bin / "docker"
        stub.write_text(
            f"#!{sys.executable}\n" + textwrap.dedent(DOCKER_STUB),
            encoding="utf-8",
        )
        stub.chmod(0o700)
        self.environment = {
            "PATH": str(self.bin) + os.pathsep + os.defpath,
            "HOME": str(self.base),
            "GITHUB_ACTIONS": "true",
            "RUNNER_OS": "Linux",
            "RUNNER_ARCH": "X64",
            "GITHUB_RUN_ID": "123456",
            "GITHUB_RUN_ATTEMPT": "2",
            "RUNNER_TEMP": str(self.runner_temp),
            "STUB_ROOT": str(self.base),
        }
        self.bash = shutil.which("bash")
        self.assertIsNotNone(self.bash)

    def invoke(
        self,
        *args: str,
        overrides: dict[str, str] | None = None,
        failure: str = "",
    ) -> subprocess.CompletedProcess[str]:
        env = {**self.environment, "STUB_FAILURE": failure, **(overrides or {})}
        return subprocess.run(
            [self.bash, str(RUNNER), *args],
            env=env,
            cwd=self.base,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
            check=False,
        )

    def calls(self) -> list[list[str]]:
        path = self.base / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def assert_clean(self) -> None:
        state_file = self.base / "state.json"
        if state_file.exists():
            self.assertEqual(json.loads(state_file.read_text()), {
                "containers": {}, "volumes": [], "images": [],
            })
        self.assertEqual(list(self.runner_temp.iterdir()), [])

    def assert_safe_output(self, result: subprocess.CompletedProcess[str]) -> None:
        output = result.stdout + result.stderr
        self.assertNotIn(RAW_LOG, output)
        self.assertNotIn("stage=secret", output)
        self.assertNotIn("phase=unknown", output)
        self.assertNotIn("linux-wrong", output)
        for line in output.splitlines():
            self.assertRegex(
                line,
                r"^(Target runner: stage=[a-z-]+ code=(OK|FAILED)"
                r"|Target probe: phase=(prepare|offline) profile=(centos7|ubuntu24|ubuntu26) "
                r"stage=(platform|prepare|metadata|missing-source|resolve|install|execute|readback|complete) "
                r"code=(OK|FAILED|RUNNING)"
                r"|Target bootstrap: stage=(platform|openssl|python|solver|spack|recipes) code=(OK|FAILED)"
                r"|Target checkout: component=spack error=missing-ref code=FAILED"
                r"|Target diagnostic: phase=(prepare|offline) profile=(centos7|ubuntu24|ubuntu26) "
                r"error=KeyError line=345"
                r"|Target identity: profile=(centos7|ubuntu24|ubuntu26) "
                r"target=linux-(centos7|ubuntu24\.04|ubuntu26\.04)-x86_64 "
                r"gcc=[0-9.]+ python=3\.11\.16 spack=1\.0\.0 code=OK)$",
            )

    def test_invalid_arguments_never_invoke_docker(self) -> None:
        for args in ((), ("ubuntu24", "extra"), ("ubuntu",), ("--help",), ("../centos7",)):
            with self.subTest(args=args):
                result = self.invoke(*args)
                self.assertEqual(result.returncode, 2)
                self.assertIn("stage=arguments code=FAILED", result.stderr)
                self.assertEqual(self.calls(), [])
                self.assert_clean()

    def test_ci_guards_precede_docker(self) -> None:
        invalid = (
            {"GITHUB_ACTIONS": ""},
            {"GITHUB_ACTIONS": "false"},
            {"RUNNER_OS": "macOS"},
            {"RUNNER_ARCH": "ARM64"},
            {"GITHUB_RUN_ID": ""},
            {"GITHUB_RUN_ID": "1/../../other"},
            {"GITHUB_RUN_ATTEMPT": "0"},
            {"GITHUB_RUN_ATTEMPT": "2\n3"},
            {"RUNNER_TEMP": ""},
            {"RUNNER_TEMP": "relative"},
            {"RUNNER_TEMP": str(self.base / "missing")},
        )
        for overrides in invalid:
            with self.subTest(overrides=overrides):
                result = self.invoke("ubuntu24", overrides=overrides)
                self.assertEqual(result.returncode, 2)
                self.assertIn("stage=ci-guard code=FAILED", result.stderr)
                self.assertEqual(self.calls(), [])
                self.assert_clean()

    def test_all_profiles_use_fixed_image_and_isolated_lifecycle(self) -> None:
        for profile in ("centos7", "ubuntu24", "ubuntu26"):
            with self.subTest(profile=profile):
                calls_before = len(self.calls())
                result = self.invoke(profile)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assert_safe_output(result)
                self.assertIn("Target bootstrap: stage=recipes code=OK", result.stdout)
                self.assertEqual(result.stdout.count("Target identity:"), 2)
                self.assertIn("gcc=12.3.0 python=3.11.16 spack=1.0.0 code=OK", result.stdout)
                self.assert_clean()
                calls = self.calls()[calls_before:]
                build = next(call for call in calls if call[0] == "build")
                self.assertEqual(build[-1], str(ROOT))
                filename = "centos7.Dockerfile" if profile == "centos7" else "ubuntu.Dockerfile"
                self.assertEqual(
                    build[build.index("--file") + 1],
                    str(RUNNER.with_name(filename)),
                )
                if profile != "centos7":
                    self.assertIn(f"TARGET_PROFILE={profile}", build)
                    self.assertIn(f"BASE_IMAGE=ubuntu:{profile[-2:]}.04", build)
                else:
                    self.assertNotIn("--build-arg", build)
                creates = [call for call in calls if call[0] == "create"]
                self.assertEqual(len(creates), 2)
                for phase, created in zip(("prepare", "offline"), creates):
                    self.assertEqual(created[-6:], [
                        IMAGE_ID, "python", "/opt/kq-target/probe.py", phase,
                        profile, "/delivery",
                    ])
                    self.assertIn("--read-only", created)
                    for option, value in (
                        ("--platform", "linux/amd64"), ("--user", "1000:1000"),
                        ("--cpus", "2"), ("--memory", "4g"), ("--pids-limit", "256"),
                        ("--cap-drop", "ALL"), ("--security-opt", "no-new-privileges"),
                        ("--entrypoint", "/opt/spack/bin/spack"),
                        ("--network", "bridge" if phase == "prepare" else "none"),
                    ):
                        self.assertEqual(created[created.index(option) + 1], value)
                    self.assertIn(
                        "/tmp:rw,exec,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=1777", created,
                    )
                    self.assertIn(
                        "/work:rw,exec,nosuid,nodev,size=2g,uid=1000,gid=1000,mode=0700", created,
                    )
                    self.assertNotIn("--privileged", created)
                prefix = f"kq-spack-target-123456-2-{profile}"
                self.assertIn(f"type=volume,src={prefix}-delivery,dst=/delivery", creates[0])
                self.assertIn(
                    f"type=volume,src={prefix}-delivery,dst=/delivery,readonly,volume-nocopy",
                    creates[1],
                )
                inspect = ["container", "inspect", f"{prefix}-offline"]
                start = ["start", "--attach", f"{prefix}-offline"]
                self.assertLess(calls.index(creates[1]), calls.index(inspect))
                self.assertLess(calls.index(inspect), calls.index(start))
                self.assertEqual(
                    [call for call in calls if call[:2] == ["container", "rm"]],
                    [
                        ["container", "rm", "--force", f"{prefix}-offline"],
                        ["container", "rm", "--force", f"{prefix}-prepare"],
                    ],
                )
                self.assertIn(["volume", "rm", f"{prefix}-delivery"], calls)
                self.assertIn(["image", "rm", f"{prefix}:local"], calls)

    def test_failure_paths_cleanup_without_raw_logs(self) -> None:
        for failure in (
            "build", "image-identity", "volume create", "create-prepare",
            "start-prepare", "create-offline", "container inspect", "start-offline",
            "signal-prepare", "signal-offline",
        ):
            with self.subTest(failure=failure):
                result = self.invoke("ubuntu24", failure=failure)
                self.assertNotEqual(result.returncode, 0)
                if failure == "build":
                    self.assertIn("Target bootstrap: stage=openssl code=FAILED", result.stdout)
                    self.assertIn("Target checkout: component=spack error=missing-ref code=FAILED", result.stdout)
                self.assert_safe_output(result)
                self.assert_clean()

    def test_success_requires_identity_and_completion_without_failed_markers(self) -> None:
        for failure in ("missing-identity", "missing-complete", "failed-marker"):
            with self.subTest(failure=failure):
                result = self.invoke("ubuntu24", failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("stage=prepare-evidence code=FAILED", result.stderr)
                self.assert_safe_output(result)
                self.assert_clean()

    def test_inspection_rejects_unsafe_runtime_before_offline_start(self) -> None:
        for failure in (
            "network", "readonly", "mount-name", "mount-type", "extra-mount",
            "image", "user", "inspect-json",
        ):
            with self.subTest(failure=failure):
                calls_before = len(self.calls())
                result = self.invoke("ubuntu24", failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("stage=isolation code=FAILED", result.stderr)
                calls = self.calls()[calls_before:]
                self.assertFalse(any(
                    call[0] == "start" and call[-1].endswith("-offline") for call in calls
                ))
                self.assert_safe_output(result)
                self.assert_clean()

    def test_collision_does_not_adopt_or_delete_existing_resources(self) -> None:
        prefix = "kq-spack-target-123456-2-ubuntu24"
        for state in (
            {"containers": {f"{prefix}-prepare": []}, "volumes": [], "images": []},
            {"containers": {f"{prefix}-offline": []}, "volumes": [], "images": []},
            {"containers": {}, "volumes": [f"{prefix}-delivery"], "images": []},
            {"containers": {}, "volumes": [], "images": [f"{prefix}:local"]},
        ):
            with self.subTest(state=state):
                state_file = self.base / "state.json"
                state_file.write_text(json.dumps(state), encoding="utf-8")
                calls_before = len(self.calls())
                result = self.invoke("ubuntu24")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("stage=resource-collision code=FAILED", result.stderr)
                self.assertEqual(json.loads(state_file.read_text()), state)
                self.assertTrue(all(call[1] == "ls" for call in self.calls()[calls_before:]))
                self.assertEqual(list(self.runner_temp.iterdir()), [])

    def test_unrelated_resources_are_preserved(self) -> None:
        state = {
            "containers": {"unrelated-container": []},
            "volumes": ["unrelated-volume"],
            "images": ["unrelated-image:local"],
        }
        state_file = self.base / "state.json"
        state_file.write_text(json.dumps(state), encoding="utf-8")
        result = self.invoke("ubuntu24")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(state_file.read_text()), state)
        self.assertEqual(list(self.runner_temp.iterdir()), [])

    def test_cleanup_failure_is_reported_without_raw_logs(self) -> None:
        result = self.invoke("ubuntu24", failure="cleanup")
        self.assertEqual(result.returncode, 1)
        self.assertIn("stage=cleanup code=FAILED", result.stderr)
        self.assert_safe_output(result)
        self.assertEqual(list(self.runner_temp.iterdir()), [])


if __name__ == "__main__":
    unittest.main()

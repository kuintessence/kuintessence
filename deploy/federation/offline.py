#!/usr/bin/env python3
"""Local image delivery and fail-closed offline Compose operations (Python 3.10+)."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE_ENGINE = ["docker"]
BUILD_OPTIONS = []
KINDS = ("evidence", "commercial", "market", "case")
ADMIN_OPERATIONS = ("orderer-join", "peer-join", "install", "approve", "readiness", "commit", "initialize", "verify", "trust-update")
COMPONENTS = {
    "server": ("packages/server/Dockerfile", None),
    "registry": ("packages/registry/Dockerfile", None),
    "web": ("packages/web/Dockerfile", None),
    "db-migrate": ("packages/db/Dockerfile", None),
    "federation-gateway": ("deploy/federation/gateway.Dockerfile", None),
    "fabric-adapter": ("deploy/federation/runtime.Dockerfile", "adapter"),
    "fabric-chaincode": ("deploy/federation/runtime.Dockerfile", "chaincode"),
    "fabric-tools": ("deploy/federation/tools.Dockerfile", None),
    "storage-observer": ("deploy/federation/storage-observer.Dockerfile", None),
}
THIRD_PARTY = ("postgres:16-alpine", "redis:7-alpine", "authzed/spicedb:v1.54.0",
               "rustfs/rustfs:1.0.0", "rustfs/rc:v0.1.36", "mariadb:11.4.8",
               "hyperledger/fabric-peer:3.1.5", "hyperledger/fabric-orderer:3.1.5", "nginx:1.27-alpine")
PUBLIC_FILES = ("deploy/main/compose.yml", "deploy/federation/compose.ingress.yml",
                "deploy/federation/compose.fabric.yml", "deploy/federation/fabric-init.sh",
                "deploy/federation/offline.py", "deploy/rustfs/bootstrap-object-lock.sh",
                "deploy/main/env.example", "deploy/federation/env.example",
                "deploy/federation/deployment.md", "deploy/federation/aio/README.md",
                "deploy/federation/aio/env.example",
                "deploy/federation/aio/compose.yml", "deploy/federation/aio/orderer.yml",
                "deploy/federation/aio/pbs.yml", "deploy/federation/aio/managed.yml",
                "deploy/federation/aio/accounting.yml",
                "deploy/federation/aio/edge.conf.example")


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def image_name(component, revision):
    return f"kq-offline/{component}:sha-{revision}"


def require_revision(revision):
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Use a full lowercase Git revision")


def require_casdoor_image(reference):
    if not isinstance(reference, str) or not re.fullmatch(r"[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}", reference):
        raise ValueError("Provide an approved Casdoor image pinned with @sha256")


def source_revision(revision):
    require_revision(revision)
    head = run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    dirty = run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True).stdout
    if head != revision or dirty:
        raise ValueError("Build/export requires a clean checkout of the specified revision")


def inspect_image(name):
    # nerdctl 2.4.2 incorrectly matches a digest-only image against an implicit latest tag.
    by_digest = Path(IMAGE_ENGINE[0]).name == "nerdctl" and "@sha256:" in name
    query = name.rsplit("@", 1)[1] if by_digest else name
    records = json.loads(run([*IMAGE_ENGINE, "image", "inspect", query], capture_output=True, text=True).stdout)
    if len(records) != 1 or records[0]["Os"] != "linux" or records[0]["Architecture"] != "amd64":
        raise ValueError("Every image must be linux/amd64")
    record = records[0]
    if by_digest and not any(reference.rsplit("@", 1)[-1] == query for reference in record.get("RepoDigests", [])):
        raise ValueError("Inspected image does not match the requested source digest")
    return {"name": name, "id": record["Id"], "size": record["Size"],
            "repoDigests": record.get("RepoDigests", []),
            "source": (record.get("Config", {}).get("Labels") or {}).get("org.opencontainers.image.source"),
            "revision": (record.get("Config", {}).get("Labels") or {}).get("org.opencontainers.image.revision")}


def build(args):
    source_revision(args.revision)
    if args.minimum_free_gib < 1:
        raise ValueError("Build space requirement must be positive")
    if shutil.disk_usage(ROOT).free < args.minimum_free_gib * 1024 ** 3:
        raise ValueError(f"Local build requires {args.minimum_free_gib} GiB free; no files were deleted")
    require_casdoor_image(args.casdoor_image)
    run([*IMAGE_ENGINE, "info"], stdout=subprocess.DEVNULL)
    for component, (dockerfile, target) in COMPONENTS.items():
        command = [*IMAGE_ENGINE, "build", *BUILD_OPTIONS, "--platform", "linux/amd64", "--file", dockerfile,
                   "--tag", image_name(component, args.revision), "--label",
                   f"org.opencontainers.image.revision={args.revision}",
                   "--label", "org.opencontainers.image.source=https://github.com/kuintessence/kuintessence",
                   "--build-arg", f"KQ_BUILD_REVISION={args.revision}",
                   "--build-arg", "VITE_PREVIEW_LOGIN=false"]
        if target:
            command += ["--target", target]
        run([*command, "."], cwd=ROOT)
    scheduler_base = image_name("scheduler-base", args.revision)
    run([*IMAGE_ENGINE, "build", *BUILD_OPTIONS, "--platform", "linux/amd64", "-t", scheduler_base,
         "--build-arg", "SCHEDULER_OS_IMAGE=ubuntu:24.04",
         "-f", "deploy/schedulers/base/Dockerfile", "deploy/schedulers"], cwd=ROOT)
    managed_base = image_name("scheduler-managed-base", args.revision)
    run([*IMAGE_ENGINE, "build", *BUILD_OPTIONS, "--platform", "linux/amd64", "-t", managed_base,
         "--build-arg", f"KQ_SCHEDULER_BASE_IMAGE={scheduler_base}",
         "-f", "deploy/federation/aio/managed-base.Dockerfile", "."], cwd=ROOT)
    for scheduler in ("slurm", "pbs"):
        runtime = image_name(f"scheduler-{scheduler}-runtime", args.revision)
        run([*IMAGE_ENGINE, "build", *BUILD_OPTIONS, "--platform", "linux/amd64", "-t", runtime,
             "--build-arg", f"SCHEDULER_BASE_IMAGE={managed_base}",
             *(["--build-arg", "KQ_AIO_ACCOUNTING=true"] if scheduler == "slurm" else []),
             "-f", f"deploy/schedulers/{scheduler}/Dockerfile", "deploy/schedulers"], cwd=ROOT)
        run([*IMAGE_ENGINE, "build", *BUILD_OPTIONS, "--platform", "linux/amd64", "-t", image_name(f"scheduler-{scheduler}", args.revision),
             "--label", f"org.opencontainers.image.revision={args.revision}",
             "--label", "org.opencontainers.image.source=https://github.com/kuintessence/kuintessence",
             "--build-arg", f"KQ_SERVER_IMAGE={image_name('server', args.revision)}",
             "--build-arg", f"KQ_SCHEDULER_IMAGE={runtime}",
             "--build-arg", f"KQ_BUILD_REVISION={args.revision}",
             "-f", "deploy/federation/aio/scheduler.Dockerfile", "."], cwd=ROOT)
    for image in (*THIRD_PARTY, args.casdoor_image):
        run([*IMAGE_ENGINE, "pull", "--platform", "linux/amd64", image])
    run([*IMAGE_ENGINE, "tag", args.casdoor_image, image_name("casdoor", args.revision)])
    source_revision(args.revision)
    print("Local images ready; export them before transferring to any target")


def export(args):
    source_revision(args.revision)
    require_casdoor_image(args.casdoor_image)
    casdoor = inspect_image(args.casdoor_image)
    names = [image_name(c, args.revision) for c in (*COMPONENTS, "scheduler-slurm", "scheduler-pbs", "casdoor")]
    records = [inspect_image(name) for name in (*names, *THIRD_PARTY)]
    if records[len(names) - 1]["id"] != casdoor["id"]:
        raise ValueError("Casdoor alias does not match the approved source image")
    for record in records:
        if record["name"] in names[:-1] and record["revision"] != args.revision:
            raise ValueError("Locally built image revision mismatch")
    output = args.output.resolve()
    if output.exists():
        raise ValueError("Output must not already exist; incomplete deliveries are never overwritten")
    output.parent.mkdir(parents=True, exist_ok=True)
    # Conservative export/scratch margin; never reclaim images or original materials here.
    needed = sum(record["size"] for record in records) * 2 + 2 * 1024 ** 3
    if shutil.disk_usage(output.parent).free < needed:
        raise ValueError(f"Export requires a conservative {needed // 1024 ** 2} MiB free")
    output.mkdir(mode=0o700)
    archive = output / "images.tar.gz"
    with archive.open("xb") as stream:
        save = subprocess.Popen([*IMAGE_ENGINE, "save", *names, *THIRD_PARTY], stdout=subprocess.PIPE)
        try:
            try:
                run(["gzip", "-1"], stdin=save.stdout, stdout=stream)
            finally:
                save.stdout.close()
            if save.wait() != 0:
                raise ValueError("Image archive failed; no ready manifest was published")
        except BaseException:
            # Reap the image exporter even when gzip or the destination disk fails.
            if save.poll() is None:
                save.kill()
            save.wait()
            raise
    source_revision(args.revision)
    if any(inspect_image(record["name"])["id"] != record["id"] for record in records):
        raise ValueError("Image changed during export; no ready manifest was published")
    for name in PUBLIC_FILES:
        source = ROOT / name
        if source.is_symlink() or not source.is_file():
            raise ValueError("Delivery payload must contain regular tracked files")
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    files = {name: {"sha256": digest(output / name), "bytes": (output / name).stat().st_size}
             for name in ("images.tar.gz", *PUBLIC_FILES)}
    manifest = {"version": 1, "revision": args.revision, "platform": "linux/amd64",
                "casdoor": {"source": args.casdoor_image, "id": casdoor["id"]},
                "images": records, "files": files}
    source_revision(args.revision)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"manifest-sha256: {digest(output / 'manifest.json')}")


def isolated_image_command(name, entrypoint, create_name=None):
    action = ["create", "--name", create_name] if create_name else ["run", "--rm"]
    return [*IMAGE_ENGINE, *action, "--pull", "never", "--network", "none", "--read-only",
            "--user", "65534:65534", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--memory", "256m", "--memory-swap", "256m", "--cpus", "1", "--pids-limit", "64",
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--workdir", "/tmp",
            "--entrypoint", entrypoint, name]


def scheduler_image(manifest, scheduler):
    name = image_name(f"scheduler-{scheduler}", manifest["revision"])
    record = next(record for record in manifest["images"] if record["name"] == name)
    if inspect_image(name)["id"] != record["id"]:
        raise ValueError("Target image does not match trusted manifest")
    return record


def export_runtime(manifest, scheduler, output):
    metadata = Path(str(output) + ".json")
    if output.exists() or metadata.exists():
        raise ValueError("Runtime export must use new output paths")
    record = scheduler_image(manifest, scheduler)
    if shutil.disk_usage(output.parent).free < record["size"] + 256 * 1024 ** 2:
        raise ValueError("Not enough space to extract the runtime")
    pending = Path(str(output) + ".creating")
    with open(pending, "xb", opener=lambda p, flags: os.open(p, flags, 0o600)):
        pass
    source_path = "/usr/local/share/kuintessence/runtime/spack.sif"
    observe = ("import hashlib,json,pathlib\np=pathlib.Path(" + repr(source_path) + ")\n"
               "h=hashlib.sha256()\nwith p.open('rb') as f:\n"
               " for b in iter(lambda:f.read(1024*1024),b''): h.update(b)\n"
               "print(json.dumps({'bytes':p.stat().st_size,'sha256':h.hexdigest()}))")
    source = json.loads(run([*isolated_image_command(record["name"], "/usr/bin/python3"), "-c", observe],
                            capture_output=True, text=True, timeout=120).stdout)
    if (not isinstance(source, dict) or set(source) != {"bytes", "sha256"}
            or type(source["bytes"]) is not int or source["bytes"] <= 0
            or not isinstance(source["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", source["sha256"])):
        raise ValueError("Invalid runtime source observation")
    container = "kq-runtime-copy-" + uuid.uuid4().hex
    try:
        run(isolated_image_command(record["name"], "/bin/true", create_name=container),
            capture_output=True, text=True, timeout=120)
        run([*IMAGE_ENGINE, "cp", container + ":" + source_path, pending],
            capture_output=True, text=True, timeout=120)
    finally:
        run([*IMAGE_ENGINE, "rm", "--force", container], capture_output=True, text=True, timeout=120)
    if not stat.S_ISREG(pending.lstat().st_mode):
        raise ValueError("Runtime copy must be a regular file")
    if pending.stat().st_size != source["bytes"] or digest(pending) != source["sha256"]:
        raise ValueError("Runtime copy does not match source size and SHA-256")
    scheduler_image(manifest, scheduler)
    with pending.open("rb") as stream:
        os.fsync(stream.fileno())
    result = {"revision": manifest["revision"], "image": {"name": record["name"], "id": record["id"]},
              "sha256": source["sha256"], "bytes": source["bytes"],
              "signed": False, "softwareInstallationAccepted": False}
    # The metadata is the completion record; failed output is never silently reused.
    pending.chmod(0o444)
    os.link(pending, output)
    pending.unlink()
    private_write(metadata, result)
    print(f"Unsigned runtime SHA-256: {result['sha256']}; approve/sign and prepare a site profile separately")


def target_facts(manifest, scheduler, output):
    if output.exists():
        raise ValueError("Target observation output must not already exist")
    record = scheduler_image(manifest, scheduler)
    name = record["name"]
    result = run([*isolated_image_command(name, "/usr/bin/python3"),
                  "/usr/local/bin/kq-target-facts.py", scheduler],
                 capture_output=True, text=True, timeout=120)
    facts = json.loads(result.stdout)
    if facts.get("version") != 1 or facts.get("scheduler") != scheduler or facts.get("softwareInstallationAccepted") is not False:
        raise ValueError("Invalid target observation")
    private_write(output, {"revision": manifest["revision"], "image": {"name": name, "id": record["id"]},
                           "platform": manifest["platform"], "facts": facts})
    print(f"Target observation SHA-256: {digest(output)}; no native lock or installation approval was generated")


def verify_bundle(bundle, expected_digest):
    if not re.fullmatch(r"[a-f0-9]{64}", expected_digest):
        raise ValueError("A trusted manifest SHA-256 is required")
    if bundle.is_symlink() or (bundle / "manifest.json").is_symlink():
        raise ValueError("Delivery directories and manifests cannot be links")
    bundle = bundle.resolve(strict=True)
    if digest(bundle / "manifest.json") != expected_digest:
        raise ValueError("Manifest SHA-256 mismatch")
    manifest = json.loads((bundle / "manifest.json").read_text())
    if manifest["version"] != 1 or manifest["platform"] != "linux/amd64":
        raise ValueError("Unsupported delivery version or architecture")
    require_revision(manifest["revision"])
    if set(manifest["files"]) != {"images.tar.gz", *PUBLIC_FILES}:
        raise ValueError("Unexpected or missing delivery payload")
    for name, expected in manifest["files"].items():
        path = bundle / name
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or path.resolve().relative_to(bundle).as_posix() != name:
            raise ValueError("Delivery path escapes its directory or contains links")
        if not path.is_file() or path.stat().st_size != expected["bytes"] or digest(path) != expected["sha256"]:
            raise ValueError(f"Payload checksum mismatch: {name}")
    names = set()
    for record in manifest["images"]:
        if not re.fullmatch(r"[a-zA-Z0-9./:_-]+", record["name"]) or record["name"] in names:
            raise ValueError("Invalid or duplicate image reference")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", record["id"]):
            raise ValueError("Invalid image identity")
        if type(record.get("size")) is not int or record["size"] <= 0:
            raise ValueError("Invalid uncompressed image size")
        names.add(record["name"])
    expected_names = {image_name(c, manifest["revision"]) for c in (*COMPONENTS, "scheduler-slurm", "scheduler-pbs", "casdoor")} | set(THIRD_PARTY)
    if names != expected_names:
        raise ValueError("Incomplete image closure")
    casdoor = manifest.get("casdoor")
    if not isinstance(casdoor, dict):
        raise ValueError("Missing approved Casdoor source")
    require_casdoor_image(casdoor.get("source"))
    alias = next(record for record in manifest["images"] if record["name"] == image_name("casdoor", manifest["revision"]))
    if casdoor.get("id") != alias["id"]:
        raise ValueError("Casdoor source identity does not match its alias")
    return manifest


def validate_images(manifest):
    for record in manifest["images"]:
        actual = inspect_image(record["name"])
        if actual["id"] != record["id"]:
            raise ValueError("Loaded image does not match trusted manifest")


def load_images(bundle, manifest):
    data_root = Path(run(["docker", "info", "--format", "{{.DockerRootDir}}"],
                         capture_output=True, text=True).stdout.strip())
    if not data_root.is_absolute() or not data_root.is_dir():
        raise ValueError("Load must run on the Docker host with an accessible Docker data directory")
    # Allow space for unpacking and stored layers without assuming deduplication.
    needed = sum(record["size"] for record in manifest["images"]) * 2 + 1024 ** 3
    if shutil.disk_usage(data_root).free < needed:
        raise ValueError(f"Docker image load requires a conservative {needed // 1024 ** 2} MiB free; no images were loaded or deleted")
    run(["docker", "load", "--input", bundle / "images.tar.gz"])
    validate_images(manifest)


def private_write(path, value):
    with open(path, "x", opener=lambda p, flags: os.open(p, flags, 0o600)) as target:
        target.write(json.dumps(value, indent=2) + "\n")


def render_config(bundle, manifest, args):
    require_private_file(args.env_file)
    if not re.fullmatch(r"kq-fed-[a-z0-9][a-z0-9-]{0,39}", args.project):
        raise ValueError("Use a distinct kq-fed-<institution> project name")
    if args.role in ("arbitrator", "orderer") and args.mode != "fabric":
        raise ValueError("Arbitrator and Orderer deployments require fabric mode")
    if getattr(args, "managed", False) and args.role != "institution":
        raise ValueError("Managed compute is limited to an institution's test scheduler")
    env = {k: v for k, v in os.environ.items() if k in {"PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"}}
    env["KQ_IMAGE_TAG"] = f"sha-{manifest['revision']}"
    env["KQ_AIO_SCHEDULER"] = args.scheduler
    env["KQ_AIO_SCHEDULER_TYPE"] = "slurm" if args.scheduler == "slurm" else "pbs-pro"
    files = ["deploy/main/compose.yml", "deploy/federation/compose.ingress.yml",
             "deploy/federation/aio/compose.yml"]
    if args.mode == "fabric":
        files.append("deploy/federation/compose.fabric.yml")
    if args.scheduler == "pbs" and args.role != "arbitrator":
        files.append("deploy/federation/aio/pbs.yml")
    if getattr(args, "managed", False):
        files.append("deploy/federation/aio/managed.yml")
        if args.scheduler == "slurm":
            files.append("deploy/federation/aio/accounting.yml")
    if args.role == "orderer":
        files = ["deploy/federation/aio/orderer.yml"]
    command = ["docker", "compose", "--project-directory", bundle, "--env-file", args.env_file,
               "--project-name", args.project]
    for path in files:
        command += ["-f", bundle / path]
    if args.mode == "fabric" and args.role != "orderer":
        command += ["--profile", "fabric-admin"]
    config = json.loads(run([*command, "config", "--format", "json"], env=env, capture_output=True, text=True).stdout)
    if args.role == "arbitrator":
        del config["services"]["scheduler"]
        del config["services"]["fabric-orderer"]
        for kind in ("evidence", "commercial", "market"):
            for suffix in ("adapter", "chaincode"):
                del config["services"][f"fabric-{kind}-{suffix}"]
        server = config["services"]["server"]
        for key in ("FEDERATION_ATTESTATION_SOCKET_PATH", "FEDERATION_COMMERCIAL_SOCKET_PATH", "FEDERATION_MARKET_SOCKET_PATH"):
            del server["environment"][key]
        server["volumes"] = [v for v in server["volumes"] if not any(v["target"].startswith(f"/run/kq-fabric/{kind}/") for kind in ("evidence", "commercial", "market"))]
    for name, service in config["services"].items():
        component = service["image"].split("/")[-1].split(":")[0]
        if component.startswith("kuintessence-"):
            service["image"] = image_name(component.removeprefix("kuintessence-"), manifest["revision"])
        if service["image"] not in {r["name"] for r in manifest["images"]}:
            raise ValueError(f"Image missing from delivery: {name}")
        service.pop("build", None)
        service["pull_policy"] = "never"
        if name.startswith("fabric-"):
            service.setdefault("mem_limit", (384 if name in ("fabric-peer", "fabric-orderer") else 128) * 1024 ** 2)
        if "privileged" in service and name != "scheduler":
            raise ValueError("Only the isolated test scheduler may be privileged")
    config["name"] = args.project
    return config


def require_private_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Environment/config file must be private and owned by this user")


def validate_accounting_credentials(config):
    service = config["services"].get("scheduler-accounting")
    if service is None:
        return
    targets = {"/run/secrets/slurm-db-password", "/run/secrets/root-password"}
    mounts = {v["target"]: v for v in service.get("volumes", []) if v["target"] in targets}
    if set(mounts) != targets:
        raise ValueError("Accounting requires both private password files")
    for volume in mounts.values():
        if volume.get("type") != "bind" or not volume.get("read_only"):
            raise ValueError("Accounting credentials require read-only file mounts")
        path = Path(volume["source"])
        if not path.is_absolute() or path.resolve(strict=True) != path:
            raise ValueError("Accounting credential paths must be canonical")
        for parent in path.parents:
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError("Accounting credential parent must be root-protected")
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 65:
            raise ValueError("Accounting credentials must be private root files")
        if not re.fullmatch(rb"[a-f0-9]{64}\n?", path.read_bytes()):
            raise ValueError("Accounting passwords require 32 random hex-encoded bytes")


def capacity(config, other_limits=0):
    info = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith(("MemTotal:", "MemAvailable:"))}
    memory = info["MemTotal"]
    running = [s for s in config["services"].values() if s.get("restart") != "no" and not s.get("profiles")]
    reserved = sum(int(s.get("mem_limit", 0)) for s in running)
    needed = reserved + other_limits + 512 * 1024 ** 2
    available_needed = reserved + 512 * 1024 ** 2
    return {"hostMiB": memory // 1024 ** 2, "serviceLimitsMiB": reserved // 1024 ** 2,
            "requiredMiB": needed // 1024 ** 2, "fitsReservedBudget": needed <= memory,
            "otherContainerLimitsMiB": other_limits // 1024 ** 2,
            "availableMiB": info["MemAvailable"] // 1024 ** 2,
            "availableRequiredMiB": available_needed // 1024 ** 2,
            "fitsAvailableBudget": available_needed <= info["MemAvailable"],
            "measuredCapacityAcceptance": False}


def other_container_limits(project):
    ids = run(["docker", "ps", "--quiet"], capture_output=True, text=True).stdout.split()
    if not ids:
        return 0
    containers = json.loads(run(["docker", "inspect", *ids], capture_output=True, text=True).stdout)
    return sum(item.get("HostConfig", {}).get("Memory", 0) for item in containers
               if (item.get("Config", {}).get("Labels") or {}).get("com.docker.compose.project") != project)


def escape_interpolation(value):
    # Compose interpolates rendered JSON again; preserve literal credentials and commands.
    if isinstance(value, str):
        return value.replace("$", "$$")
    if isinstance(value, list):
        return [escape_interpolation(item) for item in value]
    if isinstance(value, dict):
        return {key: escape_interpolation(item) for key, item in value.items()}
    return value


def admin_service(saved, operation, kind, revision):
    if saved["mode"] != "fabric":
        raise ValueError("Fabric administration is unavailable in direct mode")
    if operation not in ADMIN_OPERATIONS:
        raise ValueError("Unsupported Fabric administrative operation")
    if operation in ("orderer-join", "peer-join"):
        if kind is not None:
            raise ValueError("Channel join does not accept a chaincode kind")
    elif kind not in KINDS:
        raise ValueError("Specify the chaincode kind")
    if operation == "trust-update" and (kind != "commercial" or saved["role"] != "institution"):
        raise ValueError("Trust append requires an institution's commercial chaincode")
    role = saved["role"]
    if role == "arbitrator" and (operation == "orderer-join" or kind not in (None, "case")):
        raise ValueError("Arbitrator administration is limited to its Peer and case chaincode")
    if role == "orderer":
        if operation != "orderer-join":
            raise ValueError("Orderer-only deployments allow only orderer-join")
        volumes = saved["compose"]["services"]["fabric-orderer"]["volumes"]
        directory = next(v["source"] for v in volumes if v["target"] == "/run/kq-orderer")
        service = {
            "image": image_name("fabric-tools", revision), "pull_policy": "never",
            "read_only": True, "tmpfs": ["/tmp"], "cap_drop": ["ALL"],
            "security_opt": ["no-new-privileges:true"],
            "volumes": [{"type": "bind", "source": str(Path(directory).parent / "admin"),
                         "target": "/run/kq-admin", "read_only": True,
                         "bind": {"create_host_path": False}}],
        }
    else:
        service = dict(saved["compose"]["services"]["fabric-admin"])
    service.pop("profiles", None)
    service.update({"mem_limit": 128 * 1024 ** 2, "cpus": 0.5})
    return service


def main():
    global IMAGE_ENGINE, BUILD_OPTIONS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image-engine", choices=("docker", "nerdctl"), default="docker",
                        help="Local build/export engine; target deployment always uses Docker")
    parser.add_argument("--containerd-address", default="/run/k3s/containerd/containerd.sock")
    parser.add_argument("--namespace", default="kq-federation-build")
    parser.add_argument("--buildkit-host", default="unix:///run/kuintessence-buildkit/buildkitd.sock")
    commands = parser.add_subparsers(dest="action", required=True)
    build_parser = commands.add_parser("build", help="Build/pull all images locally, sequentially")
    build_parser.add_argument("--revision", required=True)
    build_parser.add_argument("--casdoor-image", required=True)
    build_parser.add_argument("--minimum-free-gib", type=int, default=40)
    exporter = commands.add_parser("export", help="Export the complete image set and public payload")
    exporter.add_argument("--revision", required=True)
    exporter.add_argument("--casdoor-image", required=True)
    exporter.add_argument("--output", type=Path, required=True)
    for action in ("verify", "transfer", "load", "config", "up", "admin", "target", "runtime"):
        command = commands.add_parser(action)
        command.add_argument("--bundle", type=Path, required=True)
        command.add_argument("--manifest-sha256", required=True)
        if action in ("target", "runtime"):
            command.add_argument("--scheduler", choices=("slurm", "pbs"), required=True)
            command.add_argument("--output", type=Path, required=True)
        if action == "transfer":
            command.add_argument("--host", required=True)
            command.add_argument("--destination", required=True)
        if action == "config":
            command.add_argument("--managed", action="store_true", help="Enable the isolated AIO managed compute runtime")
            command.add_argument("--mode", choices=("direct", "fabric"), required=True)
            command.add_argument("--role", choices=("institution", "arbitrator", "orderer"), default="institution")
            command.add_argument("--scheduler", choices=("slurm", "pbs"), default="slurm")
            command.add_argument("--env-file", type=Path, required=True)
            command.add_argument("--project", required=True)
            command.add_argument("--output", type=Path, required=True)
        if action in ("up", "admin"):
            command.add_argument("--config", type=Path, required=True)
        if action == "admin":
            command.add_argument("--operation", choices=ADMIN_OPERATIONS, required=True)
            command.add_argument("--kind", choices=KINDS)
    args = parser.parse_args()
    if args.image_engine == "nerdctl":
        if args.action not in ("build", "export", "target", "runtime"):
            raise ValueError("nerdctl is for local build/export/target/runtime preparation; deployment uses Docker")
        if not re.fullmatch(r"kq-federation-build(?:-[a-z0-9-]+)?", args.namespace):
            raise ValueError("Use a dedicated kq-federation-build namespace, never k8s.io")
        IMAGE_ENGINE = ["nerdctl", "--address", args.containerd_address, "--namespace", args.namespace]
        BUILD_OPTIONS = ["--buildkit-host", args.buildkit_host]
    if args.action == "build":
        build(args)
        return
    if args.action == "export":
        export(args)
        return
    manifest = verify_bundle(args.bundle, args.manifest_sha256)
    bundle = args.bundle.resolve()
    if args.action == "verify":
        print(f"Verified offline delivery {manifest['revision']}")
    elif args.action == "target":
        target_facts(manifest, args.scheduler, args.output)
    elif args.action == "runtime":
        export_runtime(manifest, args.scheduler, args.output)
    elif args.action == "transfer":
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9@._-]*", args.host):
            raise ValueError("Use an SSH host alias or user@hostname")
        if not re.fullmatch(r"/opt/kuintessence-federation/incoming/[a-zA-Z0-9_-]+", args.destination):
            raise ValueError("Destination must be a dedicated incoming delivery directory")
        ssh = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"]
        run([*ssh, args.host, f"umask 077; mkdir -p {shlex.quote(args.destination)}"])
        run(["rsync", "-rt", "--partial", "--append-verify", "--protect-args", "-e", shlex.join(ssh),
             f"{bundle}/", f"{args.host}:{args.destination}/"])
        print("Transferred; verify the trusted manifest digest on the target before loading")
    elif args.action == "load":
        load_images(bundle, manifest)
        print("Loaded images match the manifest; no services were started")
    elif args.action == "config":
        config = render_config(bundle, manifest, args)
        private_write(args.output, {"deliveryManifest": args.manifest_sha256, "mode": args.mode,
                                    "role": args.role, "managedRuntime": args.managed, "compose": config})
        print(json.dumps(capacity(config)))
        print("Private config written; this is not a runtime readiness result")
    elif args.action in ("up", "admin"):
        require_private_file(args.config)
        saved = json.loads(args.config.read_text())
        if saved["deliveryManifest"] != args.manifest_sha256:
            raise ValueError("Configuration belongs to another delivery")
        config = saved["compose"]
        if not re.fullmatch(r"kq-fed-[a-z0-9][a-z0-9-]{0,39}", config["name"]):
            raise ValueError("Refusing to manage an existing platform project")
        allowed = {r["name"] for r in manifest["images"]}
        if any(s.get("build") or s.get("pull_policy") != "never" or s.get("image") not in allowed for s in config["services"].values()):
            raise ValueError("Offline startup requires only delivered images and pull_policy=never")
        if args.action == "admin":
            service = admin_service(saved, args.operation, args.kind, manifest["revision"])
            config["services"]["fabric-admin"] = service
            budget = capacity({"services": {"fabric-admin": service}}, other_container_limits(""))
        else:
            validate_accounting_credentials(config)
            budget = capacity(config, other_container_limits(config["name"]))
        if not budget["fitsReservedBudget"] or not budget["fitsAvailableBudget"]:
            raise ValueError(f"Capacity preflight failed: {json.dumps(budget)}; measure/tune or expand before startup")
        validate_images(manifest)
        with args.config.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            state_path = args.config.parent / f"{config['name']}.deployment.json"
            state = {"mode": saved["mode"], "role": saved["role"], "manifest": args.manifest_sha256,
                     "managedRuntime": saved.get("managedRuntime", False), "phase": "starting"}
            if state_path.exists():
                require_private_file(state_path)
                previous = json.loads(state_path.read_text())
                if any(previous[key] != state[key] for key in ("mode", "role", "manifest")):
                    raise ValueError("Existing deployment requires explicit backup/maintenance before changing mode, role or release")
                if previous.get("managedRuntime", False) != state["managedRuntime"]:
                    raise ValueError("Changing the compute runtime requires explicit backup/maintenance")
            elif args.action == "admin":
                raise ValueError("Start the matching offline project before administration")
            else:
                private_write(state_path, state)
            with tempfile.TemporaryDirectory(prefix="kq-offline-up-") as directory:
                compose_file = Path(directory) / "compose.json"
                private_write(compose_file, escape_interpolation(config))
                command = ["docker", "compose", "--project-directory", bundle, "--project-name", config["name"], "-f", compose_file]
                run([*command, "config", "--quiet"])
                if args.action == "admin":
                    operation = [args.operation] + ([args.kind] if args.kind else [])
                    run([*command, "run", "--rm", "--no-deps", "--pull", "never", "-T", "fabric-admin", *operation])
                    return
                run([*command, "up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "300"])
            state["phase"] = "complete"
            next_state = state_path.with_suffix(".next")
            private_write(next_state, state)
            os.replace(next_state, state_path)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        # Do not dump captured Compose output: it can contain private environment values.
        print(f"Offline operation failed: {error if not isinstance(error, subprocess.SubprocessError) else 'external command failed'}", file=sys.stderr)
        sys.exit(1)

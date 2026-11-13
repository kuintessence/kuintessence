"""Check the two rendered deployments without a Docker daemon or real credentials."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
KINDS = ("evidence", "commercial", "market", "case")

def render(mode, env, *extra):
    result = subprocess.run(
        ["bash", "deploy/federation/compose.sh", mode, *extra, "config", "--format", "json"],
        cwd=ROOT, env=env, text=True, capture_output=True,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Compose configuration failed")
    return json.loads(result.stdout)

with tempfile.TemporaryDirectory(prefix="kq-compose-") as directory:
    env = {**os.environ, "KQ_DEPLOY_ENV_FILE": "/dev/null"}
    env.update({key: "test-only" for key in (
        "POSTGRES_PASSWORD", "JWT_SECRET", "AUTHZ_SPICEDB_TOKEN", "RUSTFS_ACCESS_KEY",
        "RUSTFS_SECRET_KEY", "SSO_BOOTSTRAP_CLIENT_ID", "SSO_BOOTSTRAP_CLIENT_SECRET",
        "REGISTRY_JWT_SECRET", "SPACK_MATERIAL_TICKET_SECRET",
    )})
    env.update({
        "DATABASE_URL": "postgres://kq:unused@postgres/kuintessence",
        "MTLS_TRUSTED_PROXY_CIDRS": "127.0.0.1/32",
        "WEB_BASE_URL": "https://platform.example.com",
        "REGISTRY_PUBLIC_ORIGIN": "https://registry.example.com",
        "SSO_BOOTSTRAP_ISSUER_URL": "https://sso.example.com",
        "SSO_BOOTSTRAP_REDIRECT_URI": "https://platform.example.com/callback",
        "FEDERATION_SITE_ID": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "FEDERATION_SIGNING_KEY_ID": "example-key",
        "KQ_FABRIC_DIRECTORY": directory,
        "KQ_IMAGE_TAG": "test-tag",
        # The wrapper must ignore ambient file/profile settings.
        "COMPOSE_FILE": "/nonexistent.yml", "COMPOSE_PROFILES": "fabric-admin",
    })
    for key in ("FEDERATION_SIGNING_KEY_FILE", "FEDERATION_CLIENT_CA_FILE",
                "FEDERATION_CLIENT_CERT_FILE", "FEDERATION_CLIENT_KEY_FILE",
                "FEDERATION_TLS_CA_FILE", "FEDERATION_TLS_CERT_FILE", "FEDERATION_TLS_KEY_FILE"):
        env[key] = str(Path(directory) / (key + ".test"))
    direct = render("direct", env)
    assert not any(name.startswith("fabric-") for name in direct["services"])
    assert direct["services"]["registry"]["init"] is True
    server = direct["services"]["server"]
    assert not any(key in server["environment"] for key in (
        "FEDERATION_ATTESTATION_SOCKET_PATH", "FEDERATION_COMMERCIAL_SOCKET_PATH",
        "FEDERATION_MARKET_SOCKET_PATH", "FEDERATION_CASE_SOCKET_PATH"))
    assert server["environment"]["FEDERATION_CLIENT_KEY_FILE"] == "/run/kq-federation/client.key"
    for key in ("FEDERATION_SIGNING_KEY_FILE", "FEDERATION_CLIENT_CERT_FILE", "FEDERATION_CLIENT_KEY_FILE"):
        target = server["environment"][key]
        volume = next(v for v in server["volumes"] if v["target"] == target)
        assert volume["read_only"] and not volume.get("bind", {}).get("create_host_path", False)
    for kind in KINDS:
        env[f"KQ_FABRIC_{kind.upper()}_PACKAGE_ID"] = f"{kind}:test-package-digest"
    fabric = render("fabric", env)
    services = fabric["services"]
    assert "fabric-admin" not in services
    for kind in KINDS:
        adapter = services[f"fabric-{kind}-adapter"]
        chaincode = services[f"fabric-{kind}-chaincode"]
        assert chaincode["init"] is True
        assert not adapter.get("ports") and not chaincode.get("ports")
        assert adapter["environment"]["KQ_FABRIC_ADAPTER_KIND"] == kind
        assert chaincode["environment"]["CHAINCODE_ID"] == env[f"KQ_FABRIC_{kind.upper()}_PACKAGE_ID"]
        path = f"/run/kq-fabric/{kind}/private/{kind}.sock"
        assert path in services["server"]["environment"].values()
        assert path in adapter["healthcheck"]["test"][-1]
        assert adapter["read_only"] and chaincode["read_only"]
        assert not any(v["type"] == "volume" and "data" in v["source"] for v in adapter["volumes"])
    for name in ("fabric-peer", "fabric-orderer"):
        assert any(v["type"] == "volume" and "data" in v["source"] for v in services[name]["volumes"])
        assert services[name]["ports"][0]["host_ip"] == "127.0.0.1"
    admin = render("fabric", env, "--profile", "fabric-admin")["services"]["fabric-admin"]
    assert not any(v["source"].endswith("/admin") for name, svc in services.items() for v in svc.get("volumes", []))
    assert admin["profiles"] == ["fabric-admin"]
    assert all(svc["image"].endswith(":test-tag") for svc in services.values() if svc["image"].startswith("ghcr.io/"))
    missing = dict(env)
    del missing["FEDERATION_CLIENT_KEY_FILE"]
    assert subprocess.run(["bash", "deploy/federation/compose.sh", "direct", "config", "--quiet"], cwd=ROOT, env=missing, capture_output=True).returncode != 0
    missing = dict(env)
    del missing["KQ_FABRIC_EVIDENCE_PACKAGE_ID"]
    assert subprocess.run(["bash", "deploy/federation/compose.sh", "fabric", "config", "--quiet"], cwd=ROOT, env=missing, capture_output=True).returncode != 0
print("Compose direct/fabric configuration, isolation, required credentials and release tags: passed")

"""Start the published Node/CLI entrypoints with disposable local identities, without a ledger."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import uuid

component, image = sys.argv[1:]
KINDS = ("evidence", "commercial", "market", "case")
containers = []

def run(*args):
    return subprocess.run(args, text=True, capture_output=True, check=True).stdout.strip()

def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) if not isinstance(value, str) else value)
    path.chmod(0o600)

def start(name, *arguments):
    name = "kq-compose-" + name + "-" + secrets.token_hex(4)
    run("docker", "run", "-d", "--name", name, "--network", "none", "--memory", "256m",
        "--cpus", "0.5", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", f"{os.getuid()}:{os.getgid()}", *arguments)
    containers.append(name)
    return name

def ready(name, code):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        state = run("docker", "inspect", "--format", "{{.State.Running}}", name)
        if state != "true":
            raise RuntimeError(f"{component} entrypoint exited before readiness")
        result = subprocess.run(["docker", "exec", name, "node", "-e", code], capture_output=True)
        if result.returncode == 0:
            return
        time.sleep(0.25)
    raise RuntimeError(f"{component} readiness timed out")

try:
    if component == "fabric-tools":
        version = run("docker", "run", "--rm", "--network", "none", "--entrypoint", "peer", image, "version")
        assert "3.1.5" in version
        print("Fabric tools 3.1.5 entrypoint: passed")
        sys.exit(0)
    with tempfile.TemporaryDirectory(prefix="kq-compose-runtime-") as directory:
        root = Path(directory)
        # Local test CA and a distinct non-CA identity, never used outside these containers.
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=Compose Test CA", "-keyout", str(root / "ca.key"), "-out", str(root / "ca.pem"))
        run("openssl", "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=Compose Test Identity",
            "-keyout", str(root / "identity.key"), "-out", str(root / "identity.csr"))
        write(root / "identity.ext", "basicConstraints=CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=clientAuth,serverAuth\n")
        run("openssl", "x509", "-req", "-days", "1", "-in", str(root / "identity.csr"),
            "-CA", str(root / "ca.pem"), "-CAkey", str(root / "ca.key"), "-CAcreateserial",
            "-extfile", str(root / "identity.ext"), "-out", str(root / "identity.pem"))
        (root / "identity.key").chmod(0o600)
        run("openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(root / "business.key"))
        public = run("openssl", "pkey", "-in", str(root / "business.key"), "-pubout")
        sites = [str(uuid.uuid4()) for _ in range(3)]
        organizations = [{"siteId": site, "mspId": f"Org{number}MSP", "keys": [{
            "keyId": "test-key", "publicKeyPem": public, "validFrom": "2020-01-01T00:00:00Z",
            "validUntil": "2099-01-01T00:00:00Z"}]} for number, site in enumerate(sites)]
        base = {"version": 1, "generationId": str(uuid.uuid4()), "organizations": organizations,
                "domains": [{"domainId": str(uuid.uuid4()), "collection": "test_AB", "siteIds": sites[:2]}]}
        commercial = {**base, "keyPurposes": [{"siteId": site, "keyId": "test-key", "kinds": ["commercial-agreement"]} for site in sites]}
        case = {**base, "domains": [{"domainId": str(uuid.uuid4()), "commercialDomainId": base["domains"][0]["domainId"],
            "sourceSiteId": sites[0], "targetSiteId": sites[1], "recipientSiteId": sites[2], "collection": "case_test_ABR"}],
            "keyPurposes": [{"siteId": site, "keyId": "test-key", "kinds": ["case-evidence-publication"]} for site in sites]}
        market = {"version": 1, "generationId": str(uuid.uuid4()),
                  "organizations": [{"siteId": org["siteId"], "mspId": org["mspId"]} for org in organizations]}
        trusts = dict(zip(KINDS, (base, commercial, market, case)))
        if component == "federation-gateway":
            socket = root / "gateway-socket"
            socket.mkdir(mode=0o700)
            name = start("gateway", "-v", f"{root}:/run/test:ro",
                "-e", "FEDERATION_TLS_CA_FILE=/run/test/ca.pem",
                "-e", "FEDERATION_TLS_CERT_FILE=/run/test/identity.pem",
                "-e", "FEDERATION_TLS_KEY_FILE=/run/test/identity.key",
                "-e", "FEDERATION_SOCKET_PATH=/run/test/gateway-socket/ingress.sock",
                "-e", "FEDERATION_TLS_PORT=3443", image)
            ready(name, "const s=require('node:net').connect(3443,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))")
        elif component in ("fabric-adapter", "fabric-chaincode"):
            for kind in KINDS:
                write(root / f"{kind}-trust.json", trusts[kind])
                if component == "fabric-adapter":
                    socket = root / f"{kind}-socket"
                    socket.mkdir(mode=0o700)
                    recovery = root / f"{kind}-recovery.key"
                    recovery.write_bytes(secrets.token_bytes(32))
                    recovery.chmod(0o600)
                    config = {"adapter": {"siteId": sites[0], "channel": "compose-test", "chaincode": "kq-" + kind, "trust": trusts[kind]},
                        "peerEndpoint": "localhost:7051", "peerTlsCaFile": "/run/test/ca.pem",
                        "tlsCertificateFile": "/run/test/identity.pem", "tlsPrivateKeyFile": "/run/test/identity.key",
                        "identityCertificateFile": "/run/test/identity.pem", "identityPrivateKeyFile": "/run/test/identity.key",
                        "recoveryKeyFile": f"/run/test/{kind}-recovery.key", "runDirectory": "/run/socket/private"}
                    write(root / f"{kind}-adapter.json", config)
                    name = start(kind, "-v", f"{root}:/run/test:ro", "-v", f"{socket}:/run/socket",
                        "-e", f"KQ_FABRIC_ADAPTER_KIND={kind}", "-e", f"KQ_FABRIC_ADAPTER_CONFIG=/run/test/{kind}-adapter.json", image)
                    ready(name, f"require('node:http').get({{socketPath:'/run/socket/private/{kind}.sock',path:'/health'}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))")
                    assert (socket / "private").stat().st_mode & 0o777 == 0o700
                    assert (socket / "private" / f"{kind}.sock").stat().st_mode & 0o777 == 0o600
                else:
                    contract = "commercial" if kind == "case" else kind
                    main = "case-main" if kind == "case" else "main"
                    name = start(kind, "-v", f"{root}:/run/test:ro", "-e", f"KQ_{kind.upper()}_TRUST_FILE=/run/test/{kind}-trust.json",
                        "-e", f"CHAINCODE_ID={kind}:test-digest", "-e", "CHAINCODE_ADDRESS=0.0.0.0:9999",
                        "-e", "CHAINCODE_TLS_KEY_FILE=/run/test/identity.key", "-e", "CHAINCODE_TLS_CERT_FILE=/run/test/identity.pem",
                        "-e", "CHAINCODE_TLS_CLIENT_CA_FILE=/run/test/ca.pem", image, "node", f"contracts/fabric/{contract}/dist/{main}.js")
                    ready(name, "const s=require('node:net').connect(9999,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))")
        else:
            raise ValueError("Unknown image component")
        print(f"{component} real entrypoint startup: passed (no live ledger requested)")
finally:
    for name in containers:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
